import { randomBytes } from "node:crypto";
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { AppAppearance, AppSettings } from "../../shared/settings-contract";
import { remotePreviewMime, type RemoteCall, type RemotePush } from "../../shared/remote-contract";
import { APP_VERSION } from "../../shared/app-info";
import { buildRemoteBootstrapScript } from "./bootstrap";
import { createRemoteDispatcher } from "./registry";
import { createRemoteServer, type RemoteServer } from "./server";
import { previewResponseForPath } from "../../preview/node/protocol";
import { iconIdentityFromUrl } from "../icon-protocol";
import type { IconStore } from "../file-icon";
import type { FsWorkerRemoteClient, FsWorkerHost } from "../fs-worker-host";
import { FS_WORKER_PUSH } from "../../shared/fs-worker-protocol";
import type { WorkerClient } from "../../shared/fs-worker-protocol";

/**
 * Wires the remote server to the running app. Each browser session gets its own
 * fs-worker client (independent watches and listings) and its calls go to the
 * SAME `ipcMain` handlers the desktop renderer uses, so validation lives in one
 * place. Every push the desktop windows receive is forwarded to each session.
 */

/** Bridge target -> the IPC channel map whose keys are the bridge method names. */
export type RemoteTargetChannels = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface RemoteHostDeps {
	/** The renderer bundle root the desktop window loads. */
	readonly rendererRoot: string;
	readonly host: string;
	readonly port: number;
	/** The icon cache that serves `autorag-thumb://` for the desktop. */
	readonly icons: IconStore;
	readonly workerHost: FsWorkerHost;
	/** Bridge targets whose methods map 1:1 onto IPC channels. */
	readonly targets: RemoteTargetChannels;
	/** The desktop window whose webContents stands in for a browser sender. */
	readonly window: () => BrowserWindow | null;
	readonly settings: () => Promise<AppSettings>;
	readonly log?: (message: string) => void;
}

export interface RemoteHost {
	start(): Promise<string>;
	stop(): Promise<void>;
	/** Forward one desktop push to every connected browser session. */
	push(channel: string, payload: unknown): void;
	status(): { readonly serving: boolean; readonly origin: string | null; readonly sessions: number };
}

/** Calls the IPC handler the desktop renderer would reach, with a stand-in sender. */
function invokeIpc(channel: string, sender: Electron.WebContents | null, args: readonly unknown[]): Promise<unknown> {
	const handlers = Reflect.get(ipcMain, "_invokeHandlers") as Map<string, unknown> | undefined;
	const handler = handlers?.get(channel);
	if (typeof handler !== "function") return Promise.reject(new Error(`remote channel not available: ${channel}`));
	const event = { sender } as IpcMainInvokeEvent;
	return Promise.resolve((handler as (event: IpcMainInvokeEvent, ...rest: unknown[]) => unknown)(event, ...args));
}

export function createRemoteHost(deps: RemoteHostDeps): RemoteHost {
	const log = deps.log ?? ((message: string) => console.error(`[remote] ${message}`));
	let token = "";
	let origin: string | null = null;
	let server: RemoteServer | null = null;
	const sessions = new Map<string, FsWorkerRemoteClient>();
	let fallback: FsWorkerRemoteClient | null = null;

	const dispatcher = createRemoteDispatcher({
		workerFor: (sessionId) => workerFor(sessionId).client,
		targets: Object.fromEntries(
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
	});

	const dispatch = (call: RemoteCall, sessionId: string): Promise<unknown> => dispatcher(call, sessionId);

	// The worker pushes its own events over its own port; a browser can only see
	// them through its SSE stream, so each session's client forwards them on.
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
			// Writes this client makes (an upload) change folders every session may
			// be viewing, so its batches go to all of them.
			forwardWorkerPushes(fallback.client, (push) => server?.broadcast(push));
		}
		return fallback;
	};

	return {
		async start() {
			if (server !== null) return origin ?? "";
			token = randomBytes(24).toString("base64url");
			const settings = await deps.settings();
			const appearance: AppAppearance = settings.appearance;
			const bootstrapScript = buildRemoteBootstrapScript({
				token,
				platform: process.platform,
				appearance,
				language: settings.language,
				version: APP_VERSION,
			});
			server = createRemoteServer({
				rendererRoot: deps.rendererRoot,
				token,
				host: deps.host,
				port: deps.port,
				bootstrapScript,
				dispatch,
				onSessionClose: (sessionId) => {
					sessions.get(sessionId)?.close();
					sessions.delete(sessionId);
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
					return bytes === null ? { status: 404, contentType: null, body: null } : { status: 200, contentType: "application/octet-stream", body: bytes };
				},
				log,
			});
			const started = await server.start();
			origin = `${started.origin}/?token=${encodeURIComponent(token)}`;
			log(`serving at ${started.origin}`);
			return origin;
		},
		async stop() {
			for (const session of sessions.values()) session.close();
			sessions.clear();
			fallback?.close();
			fallback = null;
			const current = server;
			server = null;
			origin = null;
			await current?.stop();
		},
		push(channel, payload) {
			server?.broadcast({ channel, payload } satisfies RemotePush);
		},
		status: () => ({ serving: server !== null, origin, sessions: sessions.size }),
	};
}
