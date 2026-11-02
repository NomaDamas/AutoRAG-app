import type { WorkerClient } from "../../shared/fs-worker-protocol";
import { REMOTE_NATIVE_ONLY_METHODS, type RemoteCall } from "../../shared/remote-contract";

/**
 * Turns one browser bridge call into the same service the desktop's preload
 * reaches: filesystem and live calls go to the session's own fs-worker client,
 * everything else to the target map the main process builds from its services.
 * Native-only methods are refused with a typed error the UI can show.
 */

export interface RemoteDispatcherDeps {
	/** One browser session's own worker client (watches, listings and pushes included). */
	readonly workerFor: (sessionId: string) => WorkerClient;
	/** Bridge targets other than `fs`/`live`, as `target -> method -> call`. */
	readonly targets: Readonly<Record<string, Readonly<Record<string, (...args: readonly unknown[]) => unknown>>>>;
}

/** The `fs` bridge methods that are one fs-worker op each, in the worker's own names. */
const FS_WORKER_METHODS: Readonly<Record<string, string>> = {
	listDir: "listDir",
	enrichEntries: "enrichEntries",
	finderMetadata: "finderMetadata",
	readEntries: "readEntries",
	stat: "stat",
	details: "details",
	previewIcon: "previewIcon",
	exists: "exists",
	search: "search",
	locations: "locations",
	tags: "tags",
	setTags: "setTags",
	ejectLocation: "ejectLocation",
	copy: "copy",
	move: "move",
	duplicate: "duplicate",
	rename: "rename",
	createFolder: "createFolder",
	createFile: "createFile",
	createEvidenceFolder: "createEvidenceFolder",
	removeEvidenceFolder: "removeEvidenceFolder",
	trash: "trash",
	restoreFromTrash: "restoreFromTrash",
	emptyTrash: "emptyTrash",
	undo: "undo",
	redo: "redo",
	recordCreated: "recordCreated",
	versionFamilies: "versionFamilies",
	refreshVersionFamilies: "refreshVersionFamilies",
	indexStatus: "indexStatus",
	setIndexExcluded: "setIndexExcluded",
};

const LIVE_WORKER_METHODS: Readonly<Record<string, string>> = {
	setWatchSet: "setWatchSet",
	layers: "layers",
};

export class RemoteUnsupportedError extends Error {
	readonly code = "remote-unsupported";
	constructor(target: string, method: string) {
		super(`${target}.${method} is not available from a browser`);
		this.name = "RemoteUnsupportedError";
	}
}

function isNativeOnly(target: string, method: string): boolean {
	return REMOTE_NATIVE_ONLY_METHODS[target]?.includes(method) === true;
}

export function createRemoteDispatcher(deps: RemoteDispatcherDeps): (call: RemoteCall, sessionId: string) => Promise<unknown> {
	return async function dispatch(call: RemoteCall, sessionId: string): Promise<unknown> {
		const { target, method, args } = call;
		if (isNativeOnly(target, method)) throw new RemoteUnsupportedError(target, method);
		const workerOp = target === "fs" ? FS_WORKER_METHODS[method] : target === "live" ? LIVE_WORKER_METHODS[method] : undefined;
		if (target === "fs" || target === "live") {
			if (workerOp === undefined) throw new RemoteUnsupportedError(target, method);
			return deps.workerFor(sessionId).call(workerOp, [...args]);
		}
		const implementation = deps.targets[target]?.[method];
		if (implementation === undefined) throw new RemoteUnsupportedError(target, method);
		return implementation(...args);
	};
}
