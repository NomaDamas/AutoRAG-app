/**
 * Entry of the filesystem worker, an Electron utility process forked by the
 * main process (`src/main/fs-worker-host.ts`).
 *
 * Messages on `process.parentPort`, each from main:
 *   { type: "host" }   + port  the main process's Electron-only ops (shell, clipboard, icons)
 *   { type: "client", kind } + port  one client (a renderer page or main itself) to answer
 *   { type: "dispose" }        release the watches; answered with { type: "disposed" }
 *
 * A native fault here (the `@parcel/watcher` abort that used to take the whole
 * app down) now ends only this process; main forks a new one and hands every
 * client a fresh port.
 */

import type { MessagePortMain } from "electron";
import type { FsWorkerClientHello, FsWorkerConfig, FsWorkerDiagnostics, FsWorkerRequestRecord, KnownFolders } from "../shared/fs-worker-contract";
import { FS_WORKER_CONFIG_FLAG } from "../shared/fs-worker-contract";
import { createWorkerClient, serveWorkerPort, type WorkerConnection, type WorkerPort } from "../shared/fs-worker-protocol";
import type { IconTarget } from "../main/file-icon";
import { createFsWorkerService } from "./service";

/** Recent requests kept for diagnostics (QA asserts which folder was listed when). */
const RECENT_REQUESTS = 200;

function readConfig(): FsWorkerConfig {
	const arg = process.argv.find((value) => value.startsWith(FS_WORKER_CONFIG_FLAG));
	if (arg === undefined) throw new Error("fs-worker started without its config");
	const parsed: unknown = JSON.parse(arg.slice(FS_WORKER_CONFIG_FLAG.length));
	if (typeof parsed !== "object" || parsed === null || !("userDataDir" in parsed) || typeof parsed.userDataDir !== "string") {
		throw new Error("fs-worker config has no userDataDir");
	}
	const qaRoot = "qaRoot" in parsed && typeof parsed.qaRoot === "string" ? parsed.qaRoot : undefined;
	const knownFolders = "knownFolders" in parsed && isKnownFolders(parsed.knownFolders) ? parsed.knownFolders : undefined;
	return {
		userDataDir: parsed.userDataDir,
		...(qaRoot === undefined ? {} : { qaRoot }),
		...(knownFolders === undefined ? {} : { knownFolders }),
	};
}

function isKnownFolders(value: unknown): value is KnownFolders {
	if (typeof value !== "object" || value === null) return false;
	const fields = new Map(Object.entries(value));
	return (["desktop", "documents", "downloads", "music", "videos", "pictures"] as const).every(
		(key) => typeof fields.get(key) === "string",
	);
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

function isHello(value: unknown): value is FsWorkerClientHello {
	return typeof value === "object" && value !== null && "type" in value && value.type === "client" && "kind" in value;
}

function isType(value: unknown, type: string): boolean {
	return typeof value === "object" && value !== null && "type" in value && value.type === type;
}

const parentPort = process.parentPort;
const host = createWorkerClient();
const renderers = new Set<WorkerConnection>();
const requests: Record<string, number> = {};
const recent: FsWorkerRequestRecord[] = [];

const service = createFsWorkerService({
	config: readConfig(),
	host: {
		shell: {
			trashItem: (path) => host.call("trashItem", [path]),
			showItemInFolder: (path) => void host.call("showItemInFolder", [path]),
			openPath: (path) => host.call("openPath", [path]),
			openExternal: (url) => host.call("openExternal", [url]),
		},
		clipboard: { writeText: (text) => void host.call("writeText", [text]) },
		icons: {
			async icons(targets: readonly IconTarget[]) {
				return new Map(await host.call<[string, string][]>("icons", [targets]));
			},
			preview: (target) => host.call("previewIcon", [target]),
		},
	},
	broadcast: (name, payload) => {
		for (const connection of renderers) connection.push(name, payload);
	},
});

function record(op: string, args: readonly unknown[]): void {
	requests[op] = (requests[op] ?? 0) + 1;
	recent.push({ op, path: typeof args[0] === "string" ? args[0] : null, at: Date.now() });
	if (recent.length > RECENT_REQUESTS) recent.shift();
}

const handlers = {
	...service.handlers,
	diagnostics: (): Omit<FsWorkerDiagnostics, "restarts"> => ({ pid: process.pid, requests: { ...requests }, recent: [...recent] }),
	// QA lanes only (AUTORAG_FS_WORKER_QA=1): push a synthetic "events were lost"
	// batch for `dir` (the watcher's overflow), and hold/release the enrichment
	// passes so a lane can read a listing's heap without them racing it.
	...(process.env.AUTORAG_FS_WORKER_QA === "1"
		? { qaOverflow: service.qaOverflow, qaHoldEnrichment: service.qaHoldEnrichment, qaReleaseEnrichment: service.qaReleaseEnrichment }
		: {}),
};

parentPort.on("message", (event) => {
	const message: unknown = event.data;
	const [port] = event.ports;
	if (isType(message, "host") && port !== undefined) {
		host.attach(adaptPort(port));
		return;
	}
	if (isHello(message) && port !== undefined) {
		const adapted = adaptPort(port);
		const connection = serveWorkerPort(adapted, handlers, record);
		if (message.kind === "renderer") renderers.add(connection);
		adapted.onClose?.(() => {
			renderers.delete(connection);
			// The page went away: its listings and searches stop here.
			connection.close();
		});
		return;
	}
	if (isType(message, "dispose")) {
		void service
			.dispose()
			.catch((error: unknown) => console.error("[fs-worker] dispose failed:", error))
			.finally(() => parentPort.postMessage({ type: "disposed" }));
	}
});
