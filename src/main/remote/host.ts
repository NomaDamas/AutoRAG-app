import { randomBytes } from "node:crypto";
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { AppSettings } from "../../shared/settings-contract";
import {
	remotePreviewMime,
	type RemoteAccessStatus,
	type RemoteCall,
	type RemotePairedDevice,
	type RemotePairingCode,
	type RemotePush,
	type RemoteTailscaleStatus,
} from "../../shared/remote-contract";
import { APP_VERSION } from "../../shared/app-info";
import { buildRemoteBootstrapScript } from "./bootstrap";
import { DeviceStore } from "./devices";
import { discoverLanOrigins } from "./lan";
import { createRemoteDispatcher } from "./registry";
import { createRemoteServer, type RemoteAuthenticatedContext, type RemoteServer } from "./server";
import { readTailscaleStatus } from "./tailscale";
import { createTunnelManager, type TunnelManager } from "./tunnel";
import { previewResponseForPath } from "../../preview/node/protocol";
import { iconIdentityFromUrl } from "../icon-protocol";
import type { IconStore } from "../file-icon";
import type { FsWorkerRemoteClient, FsWorkerHost } from "../fs-worker-host";
import { FS_WORKER_PUSH } from "../../shared/fs-worker-protocol";
import type { WorkerClient } from "../../shared/fs-worker-protocol";

/**
 * Wires the remote server, device pairing registry, read-only Tailscale status,
 * LAN IPv4 discovery, and Cloudflare Quick Tunnel to the running app.
 */

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

export function createRemoteHost(deps: RemoteHostDeps): RemoteHost {
	const log = deps.log ?? ((message: string) => console.error(`[remote] ${message}`));
	const deviceStore = new DeviceStore(deps.stateDir);
	let token = "";
	let origin: string | null = null;
	let baseOrigin: string | null = null;
	let boundPort: number | null = null;
	let server: RemoteServer | null = null;
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
		onChange: emitChanged,
	});

	const getTailscale = async (port: number, force = false): Promise<RemoteTailscaleStatus> => {
		const now = Date.now();
		if (!force && cachedTailscale !== null && cachedTailscale.port === port && now - cachedTailscale.at < TAILSCALE_CACHE_TTL_MS) {
			return cachedTailscale.value;
		}
		const value = await readTailscaleStatus(port);
		cachedTailscale = { value, at: Date.now(), port };
		return value;
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
		};
	};

	const remoteMethods: Readonly<Record<string, (...args: readonly unknown[]) => unknown>> = {
		status: () => buildStatus(),
		startPairing: () => deviceStore.startPairing(),
		devices: () => deviceStore.list(null),
		renameDevice: (id, label) => deviceStore.rename(String(id), label),
		revokeDevice: (id) => deviceStore.revoke(String(id)),
		revokeAllDevices: () => deviceStore.revokeAll().length,
		refreshNetwork: () => buildStatus(true),
		startTunnel: async () => {
			if (boundPort === null || boundPort <= 0) throw new Error("Remote server is not running");
			await tunnel.start(boundPort);
			return buildStatus();
		},
		stopTunnel: async () => {
			await tunnel.stop();
			return buildStatus();
		},
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

	return {
		async start() {
			if (server !== null) return origin ?? "";
			token = randomBytes(24).toString("base64url");
			const listenPort = await deps.port();
			const defaultBootstrap = await buildBootstrapFor();
			void getTailscale(listenPort, true);
			server = createRemoteServer({
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
			const started = await server.start();
			boundPort = started.port;
			baseOrigin = started.origin;
			origin = `${started.origin}/?token=${encodeURIComponent(token)}`;
			void getTailscale(started.port, true).then(() => emitChanged(), () => undefined);
			log(`serving at ${started.origin}`);
			emitChanged();
			return origin;
		},
		async stop() {
			await tunnel.stop();
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
			emitChanged();
		},
		push(channel, payload) {
			server?.broadcast({ channel, payload } satisfies RemotePush);
		},
		status: () => buildStatus(false),
		startPairing: () => deviceStore.startPairing(),
		devices: () => deviceStore.list(null),
		renameDevice: (id, label) => deviceStore.rename(id, label),
		revokeDevice: (id) => deviceStore.revoke(id),
		revokeAllDevices: () => deviceStore.revokeAll().length,
		refreshNetwork: () => buildStatus(true),
		startTunnel: async () => {
			if (boundPort === null || boundPort <= 0) throw new Error("Enable Remote Access before starting Quick Tunnel");
			await tunnel.start(boundPort);
			return buildStatus(false);
		},
		stopTunnel: async () => {
			await tunnel.stop();
			return buildStatus(false);
		},
	};
}
