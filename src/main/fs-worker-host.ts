/**
 * The main process's side of the filesystem worker: fork it, give it the
 * Electron-only ops it cannot run itself, hand every client a MessagePort to
 * it, restart it when it dies, and let it release its watches before quit.
 *
 * Main never touches a listing. A renderer gets its own port and talks to the
 * worker directly; main itself holds one more port (`client`) only for the
 * little it still asks (the dupey scan interval from Settings).
 */

import { join } from "node:path";
import { MessageChannelMain, utilityProcess, type IpcMain, type MessagePortMain, type UtilityProcess, type WebContents } from "electron";
import { FS_WORKER_CHANNELS, FS_WORKER_CONFIG_FLAG, FS_WORKER_SERVICE_NAME, type FsWorkerConfig, type FsWorkerHostOp } from "../shared/fs-worker-contract";
import { createWorkerClient, serveWorkerPort, type WorkerClient, type WorkerHandler, type WorkerPort } from "../shared/fs-worker-protocol";
import type { IconSource, IconTarget } from "./file-icon";
import type { FsOsClipboard, FsShell } from "./fs-service";

/** Longest a quit waits for the worker to release its watches before it is killed. */
export const QUIT_DISPOSE_MS = 2000;
/** Restarts closer together than this count toward the crash-loop backoff. */
const RESTART_WINDOW_MS = 10_000;
/** Most a crash-looping worker waits before the next fork. */
const MAX_RESTART_DELAY_MS = 5000;

export interface FsWorkerHostDeps {
	readonly config: FsWorkerConfig;
	readonly shell: FsShell;
	readonly clipboard: FsOsClipboard;
	readonly icons: IconSource;
	/** Defaults to the built worker beside the main bundle. */
	readonly entry?: string;
	/** Runs after every fork, once main's client is attached: re-applies state a fresh worker lacks. */
	readonly onFork?: (client: WorkerClient) => void;
}

export interface FsWorkerHost {
	/** Main's own client of the worker. */
	readonly client: WorkerClient;
	/** Hand `contents` a port now and after every restart, until it is destroyed. */
	connect(contents: WebContents): void;
	/** The live worker's pid and how many times it was restarted. */
	status(): { readonly pid: number | null; readonly restarts: number };
	/** Ask the worker to release its watches, then stop it; bounded by {@link QUIT_DISPOSE_MS}. */
	dispose(): Promise<void>;
}

function adaptPort(port: MessagePortMain): WorkerPort {
	return {
		postMessage: (message) => port.postMessage(message),
		onMessage: (listener) => {
			port.on("message", (event) => listener(event.data));
			port.start();
		},
		onClose: (listener) => {
			port.on("close", listener);
		},
		close: () => port.close(),
	};
}

function stringArg(args: readonly unknown[], label: string): string {
	const value = args[0];
	if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
	return value;
}

function iconTargetArg(value: unknown): IconTarget {
	if (
		typeof value === "object" &&
		value !== null &&
		"path" in value &&
		typeof value.path === "string" &&
		"ext" in value &&
		typeof value.ext === "string" &&
		"mtimeMs" in value &&
		typeof value.mtimeMs === "number" &&
		Number.isFinite(value.mtimeMs)
	) {
		const size = "size" in value && typeof value.size === "number" ? value.size : undefined;
		return { path: value.path, ext: value.ext, mtimeMs: value.mtimeMs, ...(size === undefined ? {} : { size }) };
	}
	throw new TypeError("icon target must be { path, ext, mtimeMs }");
}

export function createFsWorkerHost(deps: FsWorkerHostDeps): FsWorkerHost {
	const entry = deps.entry ?? join(import.meta.dirname, "fs-worker.js");
	const client = createWorkerClient();
	const renderers = new Set<WebContents>();
	const hostHandlers: Record<FsWorkerHostOp, WorkerHandler> = {
		trashItem: (args) => deps.shell.trashItem(stringArg(args, "path")),
		showItemInFolder: (args) => deps.shell.showItemInFolder(stringArg(args, "path")),
		openPath: (args) => deps.shell.openPath(stringArg(args, "path")),
		openExternal: (args) => deps.shell.openExternal(stringArg(args, "url")),
		writeText: (args) => deps.clipboard.writeText(stringArg(args, "text")),
		// A Map does not survive structured clone through every port type; entries do.
		icons: async (args) => {
			const targets = args[0];
			if (!Array.isArray(targets)) throw new TypeError("icons expects an array of targets");
			return [...(await deps.icons.icons(targets.map(iconTargetArg)))];
		},
		previewIcon: (args) => deps.icons.preview(iconTargetArg(args[0])),
	};
	let worker: UtilityProcess | null = null;
	let restarts = 0;
	let recentExits: number[] = [];
	let disposing: Promise<void> | null = null;
	let restartTimer: NodeJS.Timeout | null = null;

	/** One port for `contents` on the current worker. */
	const sendPort = (contents: WebContents): void => {
		if (worker === null || contents.isDestroyed()) return;
		const { port1, port2 } = new MessageChannelMain();
		worker.postMessage({ type: "client", kind: "renderer" }, [port1]);
		contents.postMessage(FS_WORKER_CHANNELS.port, null, [port2]);
	};

	/**
	 * `stdio: "inherit"` does not carry the worker's output to a parent whose
	 * stdout is a pipe on Windows (a GUI process has no console to inherit), so
	 * the worker's logs and the `[fs-watch]` diagnostics QA reads would vanish.
	 * Pipe them and write them on main's own streams instead. A closed parent
	 * pipe must not take main down, so a stream error is swallowed.
	 */
	const swallowStreamError = (): void => {};
	process.stdout.on("error", swallowStreamError);
	process.stderr.on("error", swallowStreamError);
	const forward = (from: NodeJS.ReadableStream | null | undefined, to: NodeJS.WriteStream): void => {
		from?.on("data", (chunk: Buffer | string) => {
			to.write(chunk);
		});
	};

	const fork = (): void => {
		const child = utilityProcess.fork(entry, [`${FS_WORKER_CONFIG_FLAG}${JSON.stringify(deps.config)}`], {
			serviceName: FS_WORKER_SERVICE_NAME,
			stdio: "pipe",
		});
		forward(child.stdout, process.stdout);
		forward(child.stderr, process.stderr);
		worker = child;
		const host = new MessageChannelMain();
		child.postMessage({ type: "host" }, [host.port1]);
		serveWorkerPort(adaptPort(host.port2), hostHandlers);
		const own = new MessageChannelMain();
		child.postMessage({ type: "client", kind: "main" }, [own.port1]);
		client.attach(adaptPort(own.port2));
		for (const contents of renderers) sendPort(contents);
		deps.onFork?.(client);
		child.once("exit", (code) => {
			if (worker !== child) return;
			worker = null;
			host.port2.close();
			own.port2.close();
			if (disposing !== null) return;
			console.error(`[fs-worker] exited with code ${code}; restarting`);
			const now = Date.now();
			recentExits = [...recentExits.filter((at) => now - at < RESTART_WINDOW_MS), now];
			// The first crash restarts at once (the user sees only a short load);
			// a crash loop backs off so it never pins a core.
			const delay = Math.min(MAX_RESTART_DELAY_MS, recentExits.length <= 1 ? 0 : 250 * 2 ** (recentExits.length - 2));
			restartTimer = setTimeout(() => {
				restartTimer = null;
				if (disposing !== null) return;
				restarts += 1;
				fork();
			}, delay);
		});
	};

	fork();

	return {
		client,
		connect(contents) {
			if (renderers.has(contents)) {
				// A reload asks again: the page lost its old port with its old document.
				sendPort(contents);
				return;
			}
			renderers.add(contents);
			contents.once("destroyed", () => renderers.delete(contents));
			sendPort(contents);
		},
		status: () => ({ pid: worker?.pid ?? null, restarts }),
		dispose() {
			disposing ??= (async () => {
				clearTimeout(restartTimer ?? undefined);
				const child = worker;
				if (child === null) return;
				const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
				const released = new Promise<void>((resolve) => {
					const onMessage = (message: unknown): void => {
						if (typeof message === "object" && message !== null && "type" in message && message.type === "disposed") {
							child.off("message", onMessage);
							resolve();
						}
					};
					child.on("message", onMessage);
				});
				child.postMessage({ type: "dispose" });
				const bound = new Promise<void>((resolve) => setTimeout(resolve, QUIT_DISPOSE_MS).unref());
				await Promise.race([released, exited, bound]);
				child.kill();
				await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, QUIT_DISPOSE_MS).unref())]);
			})();
			return disposing;
		},
	};
}

/** Answer the preload's port request for every page, and the QA probes. */
export function registerFsWorkerIpc(host: FsWorkerHost, ipcMain: IpcMain): void {
	ipcMain.on(FS_WORKER_CHANNELS.connect, (event) => host.connect(event.sender));
	ipcMain.handle(FS_WORKER_CHANNELS.diagnostics, async () => ({
		...(await host.client.call<object>("diagnostics")),
		restarts: host.status().restarts,
	}));
	// The worker only answers these ops under the same flag.
	if (process.env.AUTORAG_FS_WORKER_QA === "1") {
		ipcMain.handle(FS_WORKER_CHANNELS.qaOverflow, (_event, dir: unknown) => host.client.call("qaOverflow", [dir]));
		// A QA lane names the ops to hold (`enrichEntries`, `finderMetadata`) and,
		// on release, the subset to answer now; the rest stay held.
		ipcMain.handle(FS_WORKER_CHANNELS.qaHoldEnrichment, (_event, prefix: unknown, ops: unknown) => host.client.call("qaHoldEnrichment", [prefix, ops]));
		ipcMain.handle(FS_WORKER_CHANNELS.qaReleaseEnrichment, (_event, ops: unknown) => host.client.call("qaReleaseEnrichment", [ops]));
	}
}
