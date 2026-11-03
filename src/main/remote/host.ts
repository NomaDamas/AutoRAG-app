import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import dazziMarkPath from "../../renderer/src/assets/dazzi-mark.png?asset";
import type { AppSettings } from "../../shared/settings-contract";
import {
	remotePreviewMime,
	type RemoteAccessStatus,
	type RemoteCall,
	type RemotePairedDevice,
	type RemotePairingCode,
	type RemotePush,
	type RemoteServerError,
	type RemoteTailscaleServeError,
	type RemoteTailscaleStatus,
} from "../../shared/remote-contract";
import { APP_VERSION } from "../../shared/app-info";
import { buildRemoteBootstrapScript } from "./bootstrap";
import { DeviceStore } from "./devices";
import { discoverLanOrigins } from "./lan";
import { createRemoteDispatcher } from "./registry";
import { createRemoteServer, type RemoteAuthenticatedContext, type RemoteServer } from "./server";
import { findTailscaleBinary, readTailscaleStatus, startTailscaleServe, stopTailscaleServe } from "./tailscale";
import { writePrivateState } from "./private-state";
import { createTunnelManager, type TunnelManager } from "./tunnel";
import { previewResponseForPath } from "../../preview/node/protocol";
import { iconIdentityFromUrl } from "../icon-protocol";
import type { IconStore } from "../file-icon";
import type { FsWorkerRemoteClient, FsWorkerHost } from "../fs-worker-host";
import { FS_WORKER_PUSH } from "../../shared/fs-worker-protocol";
import type { WorkerClient } from "../../shared/fs-worker-protocol";

/**
 * Wires the remote server, device pairing registry, read-only Tailscale status,
 * LAN IPv4 discovery, and the Cloudflare tunnel (Quick Tunnel or own domain) to the running app.
 */

/** The sunflower mark the AccessGate draws above "Dazzi", inlined because the gate page allows only `data:` images. */
function gateLogoDataUrl(): string | undefined {
	try {
		return `data:image/png;base64,${readFileSync(dazziMarkPath).toString("base64")}`;
	} catch {
		return undefined;
	}
}

/** Bridge target -> the IPC channel map whose keys are the bridge method names. */
export type RemoteTargetChannels = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface RemoteHostDeps {
	/** The renderer bundle root the desktop window loads. */
	readonly rendererRoot: string;
	/** Private state directory (`<userData>/settings`) for `remote-devices.json`. */
	readonly stateDir: string;
	readonly host: string;
	readonly port: () => Promise<number>;
	/** The icon cache that serves `autorag-thumb://` for the desktop. */
	readonly icons: IconStore;
	readonly workerHost: FsWorkerHost;
	/** Bridge targets whose methods map 1:1 onto IPC channels. */
	readonly targets: RemoteTargetChannels;
	/** The desktop window whose webContents stands in for a browser sender. */
	readonly window: () => BrowserWindow | null;
	readonly settings: () => Promise<AppSettings>;
	readonly onStatusChanged?: (status: RemoteAccessStatus) => void;
	readonly log?: (message: string) => void;
}

export interface RemoteHost {
	start(): Promise<string>;
	stop(): Promise<void>;
	/** Forward one desktop push to every connected browser session. */
	push(channel: string, payload: unknown): void;
	status(): Promise<RemoteAccessStatus>;
	startPairing(): RemotePairingCode;
	devices(): readonly RemotePairedDevice[];
	renameDevice(id: string, label: string): RemotePairedDevice | null;
	revokeDevice(id: string): boolean;
	revokeAllDevices(): number;
	refreshNetwork(): Promise<RemoteAccessStatus>;
	startTunnel(): Promise<RemoteAccessStatus>;
	stopTunnel(): Promise<RemoteAccessStatus>;
	/** `cloudflared tunnel login`, run from the desktop only (it opens a browser on the host). */
	loginTunnel(): Promise<RemoteAccessStatus>;
	/** Publish Dazzi in the tailnet with `tailscale serve` (desktop only: it changes the host's Tailscale config). */
	startTailscaleServe(): Promise<RemoteAccessStatus>;
	/** Remove the serve route that points at Dazzi. */
	stopTailscaleServe(): Promise<RemoteAccessStatus>;
	/** The own-domain hostname setting changed (`""` = Quick Tunnel). */
	setTunnelHostname(hostname: string): Promise<void>;
}

/** Calls the IPC handler the desktop renderer would reach, with a stand-in sender. */
function invokeIpc(channel: string, sender: Electron.WebContents | null, args: readonly unknown[]): Promise<unknown> {
	const handlers = Reflect.get(ipcMain, "_invokeHandlers") as Map<string, unknown> | undefined;
	const handler = handlers?.get(channel);
	if (typeof handler !== "function") return Promise.reject(new Error(`remote channel not available: ${channel}`));
	const event = { sender } as IpcMainInvokeEvent;
	return Promise.resolve((handler as (event: IpcMainInvokeEvent, ...rest: unknown[]) => unknown)(event, ...args));
}

const TAILSCALE_CACHE_TTL_MS = 30_000;

/** A port the OS hands out right now on `host`: what Settings offers when the configured one is taken. */
function probeFreePort(host: string): Promise<number | null> {
	return new Promise((resolve) => {
		const probe = createNetServer();
		probe.once("error", () => resolve(null));
		probe.listen(0, host, () => {
			const address = probe.address();
			const port = typeof address === "object" && address !== null ? address.port : null;
			probe.close(() => resolve(port));
		});
	});
}

async function describeStartFailure(error: unknown, port: number, host: string): Promise<RemoteServerError> {
	if ((error as NodeJS.ErrnoException | null)?.code === "EADDRINUSE") {
		return { code: "port_in_use", port, suggestedPort: await probeFreePort(host) };
	}
	return { code: "failed", port, message: error instanceof Error ? error.message : String(error) };
}

export function createRemoteHost(deps: RemoteHostDeps): RemoteHost {
	const log = deps.log ?? ((message: string) => console.error(`[remote] ${message}`));
	const deviceStore = new DeviceStore(deps.stateDir);
	const gateLogo = gateLogoDataUrl();
	let token = "";
	let origin: string | null = null;
	let baseOrigin: string | null = null;
	let boundPort: number | null = null;
	let server: RemoteServer | null = null;
	/** Why the last start did not serve; null once a start succeeds or remote access is stopped. */
	let serverError: RemoteServerError | null = null;
	/** The start in flight: concurrent callers (launch, the settings toggle, a port change) share it. */
	let starting: Promise<string> | null = null;
	const sessions = new Map<string, FsWorkerRemoteClient>();
	let fallback: FsWorkerRemoteClient | null = null;
	let cachedTailscale: { value: RemoteTailscaleStatus; at: number; port: number } | null = null;

	const emitChanged = (): void => {
		if (deps.onStatusChanged === undefined) return;
		void buildStatus().then(
			(next) => deps.onStatusChanged?.(next),
			() => undefined,
		);
	};

	deviceStore.onChanged(emitChanged);

	const tunnel: TunnelManager = createTunnelManager({
		stateDir: deps.stateDir,
		onChange: emitChanged,
	});
	void deps.settings().then(
		(settings) => tunnel.setHostname(settings.remoteTunnelHostname),
		() => undefined,
	);

	/**
	 * Ports earlier runs listened on (`remote-ports.json`), newest first. A Tailscale serve route still pointing at one
	 * of them is Dazzi's own leftover and is re-pointed at this run instead of being treated as another app's.
	 */
	const portsFile = join(deps.stateDir, "remote-ports.json");
	const readPastPorts = (): number[] => {
		try {
			const parsed: unknown = JSON.parse(readFileSync(portsFile, "utf8"));
			return Array.isArray(parsed) ? parsed.filter((value): value is number => Number.isInteger(value) && value > 0 && value <= 65535) : [];
		} catch {
			return [];
		}
	};
	let pastPorts = readPastPorts();
	const rememberPort = (port: number): void => {
		pastPorts = [port, ...pastPorts.filter((value) => value !== port)].slice(0, 8);
		try {
			writePrivateState(portsFile, pastPorts);
		} catch (error) {
			log(`could not record the remote port: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	/** The last publish/stop failure; shown until the next success or a manual re-check. */
	let serveError: RemoteTailscaleServeError | null = null;
	const getTailscale = async (port: number, force = false): Promise<RemoteTailscaleStatus> => {
		const now = Date.now();
		if (!force && cachedTailscale !== null && cachedTailscale.port === port && now - cachedTailscale.at < TAILSCALE_CACHE_TTL_MS) {
			return { ...cachedTailscale.value, serveError };
		}
		const value = await readTailscaleStatus(port, pastPorts);
		cachedTailscale = { value, at: Date.now(), port };
		return { ...value, serveError };
	};

	/** Publish or unpublish Dazzi's port in the tailnet, then re-read Tailscale so Settings shows the result. */
	const changeTailscaleServe = async (action: "start" | "stop"): Promise<RemoteAccessStatus> => {
		const binary = findTailscaleBinary();
		const port = boundPort ?? 0;
		const current = await getTailscale(port, true);
		if (binary === null || current.state !== "running") {
			serveError = { reason: "Tailscale is not running on this computer", enableUrl: null };
		} else if (action === "start") {
			if (server === null || port <= 0) serveError = { reason: "The remote access server is not running", enableUrl: null };
			else if (current.servingUrl !== null) serveError = null;
			else if (current.servePort === null || current.servePort === undefined) serveError = { reason: "Every HTTPS port Dazzi can use is taken by another serve route", enableUrl: null };
			else {
				const result = await startTailscaleServe({ binary, httpsPort: current.servePort, port });
				serveError = result.ok ? null : { reason: result.reason, enableUrl: result.enableUrl };
			}
		} else if (current.servingPort !== null && current.servingPort !== undefined) {
			const result = await stopTailscaleServe({ binary, httpsPort: current.servingPort });
			serveError = result.ok ? null : { reason: result.reason, enableUrl: result.enableUrl };
		} else {
			serveError = null;
		}
		const next = await buildStatus(true);
		emitChanged();
		return next;
	};

	/**
	 * A route Dazzi published in an earlier run still points at that run's port (the app restarted, or the port moved),
	 * so the `ts.net` address answers 502. Re-point it at this run: the user already chose to publish, and only a route
	 * whose target is one of Dazzi's own past ports qualifies, never another app's.
	 */
	const reclaimTailscaleRoute = async (port: number): Promise<void> => {
		const binary = findTailscaleBinary();
		if (binary === null) return;
		const current = await getTailscale(port, true);
		if (current.state !== "running" || current.servingUrl !== null || current.reclaimable !== true || current.servePort == null) return;
		const result = await startTailscaleServe({ binary, httpsPort: current.servePort, port });
		serveError = result.ok ? null : { reason: result.reason, enableUrl: result.enableUrl };
		if (result.ok) log(`re-pointed the Tailscale route on :${current.servePort} at port ${port}`);
		await getTailscale(port, true);
	};

	const buildStatus = async (forceNetwork = false): Promise<RemoteAccessStatus> => {
		const configuredPort = await deps.port();
		const activePort = boundPort ?? configuredPort;
		const tailscale = await getTailscale(activePort, forceNetwork);
		const lanOrigins = server !== null && activePort > 0 ? discoverLanOrigins(activePort) : [];
		return {
			serving: server !== null,
			origin,
			baseOrigin,
			port: activePort,
			sessions: sessions.size,
			lanOrigins,
			tailscale,
			tunnel: tunnel.status(),
			pairing: deviceStore.activePairing(),
			devices: deviceStore.list(null),
			serverError,
		};
	};

	// What a browser session may call on `remote.*`. Tunnel control stays with the desktop: it spawns
	// cloudflared on the host and its login opens a browser there.
	const remoteMethods: Readonly<Record<string, (...args: readonly unknown[]) => unknown>> = {
		status: () => buildStatus(),
		startPairing: () => deviceStore.startPairing(),
		devices: () => deviceStore.list(null),
		renameDevice: (id, label) => deviceStore.rename(String(id), label),
		revokeDevice: (id) => deviceStore.revoke(String(id)),
		revokeAllDevices: () => deviceStore.revokeAll().length,
		refreshNetwork: () => buildStatus(true),
	};

	const dispatcher = createRemoteDispatcher({
		workerFor: (sessionId) => workerFor(sessionId).client,
		targets: {
			...Object.fromEntries(
				Object.entries(deps.targets).map(([target, methods]) => [
					target,
					Object.fromEntries(
						Object.entries(methods).map(([method, channel]) => [
							method,
							(...args: readonly unknown[]) => invokeIpc(channel, deps.window()?.webContents ?? null, args),
						]),
					),
				]),
			),
			remote: remoteMethods,
		},
	});

	const dispatch = (call: RemoteCall, sessionId: string): Promise<unknown> => dispatcher(call, sessionId);

	const forwardWorkerPushes = (client: WorkerClient, sink: (payload: RemotePush) => void): void => {
		for (const name of [FS_WORKER_PUSH.live, FS_WORKER_PUSH.locationsChanged, FS_WORKER_PUSH.indexRefreshed]) {
			client.onPush(name, (payload) => sink({ channel: name, payload }));
		}
	};

	const workerFor = (sessionId: string): FsWorkerRemoteClient => {
		const existing = sessions.get(sessionId);
		if (existing !== undefined) return existing;
		const created = deps.workerHost.remoteClient();
		forwardWorkerPushes(created.client, (push) => server?.sendToSession(sessionId, push));
		sessions.set(sessionId, created);
		return created;
	};

	const sharedWorker = (): FsWorkerRemoteClient => {
		if (fallback === null) {
			fallback = deps.workerHost.remoteClient();
			forwardWorkerPushes(fallback.client, (push) => server?.broadcast(push));
		}
		return fallback;
	};

	const buildBootstrapFor = async (auth?: RemoteAuthenticatedContext): Promise<string> => {
		const settings = await deps.settings();
		return buildRemoteBootstrapScript({
			...(auth === undefined || auth.includeQueryToken ? { token } : {}),
			...(auth?.via !== undefined ? { via: auth.via } : {}),
			...(auth?.deviceId !== undefined ? { deviceId: auth.deviceId } : {}),
			platform: process.platform,
			appearance: settings.appearance,
			language: settings.language,
			version: APP_VERSION,
		});
	};

	const lifecycle = {
		start(): Promise<string> {
			// Each start re-reads the port setting: a server on another port moves (Settings asks to restart Dazzi,
			// but the switch and a launch should not keep a stale port either).
			const run = async (): Promise<string> => {
				const listenPort = await deps.port();
				if (server !== null && (listenPort === 0 || listenPort === boundPort)) return origin ?? "";
				if (server !== null) await stopServer();
				return startServer(listenPort);
			};
			const next = (starting ?? Promise.resolve("")).catch(() => "").then(run);
			const current = next.finally(() => {
				if (starting === current) starting = null;
			});
			starting = current;
			return current;
		},
		async stop(): Promise<void> {
			await starting?.catch(() => undefined);
			await tunnel.stop();
			await stopServer();
			serverError = null;
			emitChanged();
		},
	};

	async function startServer(listenPort: number): Promise<string> {
		token = randomBytes(24).toString("base64url");
		const defaultBootstrap = await buildBootstrapFor();
		void getTailscale(listenPort, true);
		const candidate = createRemoteServer({
			rendererRoot: deps.rendererRoot,
			token,
			host: deps.host,
			port: listenPort,
			bootstrapScript: defaultBootstrap,
			bootstrapScriptFor: (auth) => buildBootstrapFor(auth),
			devices: deviceStore,
			tailscaleOwner: () => cachedTailscale?.value.owner ?? null,
			gatePrefs: async () => {
				const current = await deps.settings();
				return { language: current.language, appearance: current.appearance };
			},
			...(gateLogo === undefined ? {} : { gateLogoDataUrl: gateLogo }),
			dispatch,
			onSessionOpen: () => emitChanged(),
			onSessionClose: (sessionId) => {
				sessions.get(sessionId)?.close();
				sessions.delete(sessionId);
				emitChanged();
			},
			preview: (filePath, range) => previewResponseForPath(filePath, range, remotePreviewMime(filePath) ?? undefined),
			thumbnail: (query) => {
				const path = query.get("path");
				const mtime = query.get("mtime");
				if (path === null || mtime === null) return { status: 400, contentType: null, body: null };
				const size = query.get("size");
				const identity = iconIdentityFromUrl(
					`autorag-thumb://local/?path=${encodeURIComponent(path)}&mtime=${encodeURIComponent(mtime)}${size === null ? "" : `&size=${encodeURIComponent(size)}`}`,
				);
				if (identity === null) return { status: 400, contentType: null, body: null };
				const bytes = deps.icons.read(identity.path, identity.mtimeMs, identity.size);
				return bytes === null ? { status: 404, contentType: null, body: null } : { status: 200, contentType: "image/png", body: bytes };
			},
			upload: async (folder, name, bytes) => {
				await sharedWorker().client.call("uploadFile", [folder, name, bytes]);
			},
			download: async (filePath) => {
				const bytes = await sharedWorker().client.call<Uint8Array | null>("readFile", [filePath]);
				return bytes === null
					? { status: 404, contentType: null, body: null }
					: { status: 200, contentType: "application/octet-stream", body: bytes };
			},
			log,
		});
		let started: { readonly port: number; readonly origin: string };
		try {
			started = await candidate.start();
		} catch (error) {
			await candidate.stop().catch(() => undefined);
			serverError = await describeStartFailure(error, listenPort, deps.host);
			emitChanged();
			throw error;
		}
		server = candidate;
		serverError = null;
		boundPort = started.port;
		rememberPort(started.port);
		baseOrigin = started.origin;
		origin = `${started.origin}/?token=${encodeURIComponent(token)}`;
		void reclaimTailscaleRoute(started.port).then(() => emitChanged(), () => undefined);
		log(`serving at ${started.origin}`);
		emitChanged();
		return origin;
	}

	async function stopServer(): Promise<void> {
		for (const session of sessions.values()) session.close();
		sessions.clear();
		fallback?.close();
		fallback = null;
		const current = server;
		server = null;
		origin = null;
		baseOrigin = null;
		boundPort = null;
		await current?.stop();
	}

	return {
		start: lifecycle.start,
		stop: lifecycle.stop,
		push(channel, payload) {
			server?.broadcast({ channel, payload } satisfies RemotePush);
		},
		status: () => buildStatus(false),
		startPairing: () => deviceStore.startPairing(),
		devices: () => deviceStore.list(null),
		renameDevice: (id, label) => deviceStore.rename(id, label),
		revokeDevice: (id) => deviceStore.revoke(id),
		revokeAllDevices: () => deviceStore.revokeAll().length,
		refreshNetwork: () => {
			serveError = null;
			return buildStatus(true);
		},
		startTailscaleServe: () => changeTailscaleServe("start"),
		stopTailscaleServe: () => changeTailscaleServe("stop"),
		startTunnel: async () => {
			await tunnel.start(boundPort ?? 0);
			return buildStatus(false);
		},
		stopTunnel: async () => {
			await tunnel.stop();
			return buildStatus(false);
		},
		loginTunnel: async () => {
			await tunnel.login();
			return buildStatus(false);
		},
		setTunnelHostname: (hostname) => tunnel.setHostname(hostname),
	};
}
