/** Windows known folders, as Electron's `app.getPath` resolves them. */
export interface KnownFolders {
	readonly desktop: string;
	readonly documents: string;
	readonly downloads: string;
	readonly music: string;
	readonly videos: string;
	readonly pictures: string;
}

/**
 * Every op the worker answers. The preload bridge and the main process call
 * these names; the worker's handler table is typed by this union, so a name
 * on one side without the other is a type error.
 */
export type FsWorkerOp =
	| "listDir"
	| "readEntries"
	| "enrichEntries"
	| "finderMetadata"
	| "stat"
	| "details"
	| "previewIcon"
	| "exists"
	| "search"
	| "locations"
	| "ejectLocation"
	| "copy"
	| "move"
	| "duplicate"
	| "rename"
	| "createFolder"
	| "createFile"
	| "trash"
	| "restoreFromTrash"
	| "emptyTrash"
	| "reveal"
	| "quickLook"
	| "open"
	| "openUrl"
	| "clipboardSet"
	| "clipboardGet"
	| "undo"
	| "copyPathsToClipboard"
	| "versionFamilies"
	| "refreshVersionFamilies"
	| "setScanInterval"
	| "indexStatus"
	| "setIndexExcluded"
	| "setWatchSet"
	| "layers"
	/** The app that opens a path (Quick Look's "Open with"); main asks so it never spawns a child itself. */
	| "defaultApp"
	| "diagnostics";

/** The Electron-only ops the worker asks the main process for, over the host port. */
export type FsWorkerHostOp = "trashItem" | "showItemInFolder" | "openPath" | "openExternal" | "writeText" | "icons" | "previewIcon";

/**
 * The filesystem worker: an Electron utility process that owns folder
 * listings, live watches, Finder metadata, places, the file-name index, the
 * AutoRAG index badges, and the dupey version-family scans. The main process
 * forks it, hands every client a MessagePort to it, restarts it when it dies,
 * and asks it to release its watches before the app quits.
 */

/** IPC channels between the preload and the main process for the worker link. */
export const FS_WORKER_CHANNELS = {
	/** Renderer → main (send): this page wants a port to the worker. */
	connect: "fs-worker:connect",
	/** Main → renderer (postMessage with one port): the current worker's port; a later one means it restarted. */
	port: "fs-worker:port",
	/** Main-only handle: the worker's pid, restart count, and request counters, for diagnostics and QA. */
	diagnostics: "fs-worker:diagnostics",
	/** Main-only handle, registered only with AUTORAG_FS_WORKER_QA=1: a synthetic watcher overflow for a folder. */
	qaOverflow: "fs-worker:qaOverflow",
	/** Main-only handle, registered only with AUTORAG_FS_WORKER_QA=1: hold enrichment answers for a path prefix. */
	qaHoldEnrichment: "fs-worker:qaHoldEnrichment",
	/** Main-only handle, registered only with AUTORAG_FS_WORKER_QA=1: answer every held enrichment request. */
	qaReleaseEnrichment: "fs-worker:qaReleaseEnrichment",
} as const;

/** argv flag carrying the JSON {@link FsWorkerConfig}. */
export const FS_WORKER_CONFIG_FLAG = "--autorag-fs-worker=";

/** Electron's `serviceName` for the worker, as `app.getAppMetrics()` reports it. */
export const FS_WORKER_SERVICE_NAME = "AutoRAG File System";

/** What the worker needs from main at start; everything else it reads itself. */
export interface FsWorkerConfig {
	readonly userDataDir: string;
	/** Playwright points the first tab here. Absent in normal runs. */
	readonly qaRoot?: string;
	/** Windows known folders as Electron resolves them (OneDrive can redirect them). */
	readonly knownFolders?: KnownFolders;
}

/** What the first message on `process.parentPort` hands the worker with each port. */
export interface FsWorkerClientHello {
	readonly type: "client";
	/** Renderer clients receive live pushes; the main client does not. */
	readonly kind: "renderer" | "main";
}

/** One request the worker answered recently: the op and, when it had one, its path argument. */
export interface FsWorkerRequestRecord {
	readonly op: string;
	readonly path: string | null;
	readonly at: number;
}

export interface FsWorkerDiagnostics {
	readonly pid: number;
	/** Times main has forked a replacement since the app started. */
	readonly restarts: number;
	/** Requests answered per op since this worker started. */
	readonly requests: Readonly<Record<string, number>>;
	/** The most recent requests, oldest first. */
	readonly recent: readonly FsWorkerRequestRecord[];
}
