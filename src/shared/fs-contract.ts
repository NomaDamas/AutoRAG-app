import type { IndexStatus } from "./index-contract";

/**
 * Finder contract shared by the Electron main process and the renderer.
 *
 * The main process implements every channel; the preload exposes typed
 * wrappers on `window.autorag.fs`. All paths crossing this boundary are
 * absolute OS paths. Datasource virtual identifiers (`/kakao/...`) never
 * appear here — they belong to the search bridge, not the filesystem.
 */

/** IPC channel names. Keep in 1:1 sync with the main-process handlers. */
export const FS_CHANNELS = {
	listDir: "fs:listDir",
	readEntries: "fs:readEntries",
	enrichEntries: "fs:enrichEntries",
	stat: "fs:stat",
	exists: "fs:exists",
	search: "fs:search",
	locations: "fs:locations",
	copy: "fs:copy",
	move: "fs:move",
	duplicate: "fs:duplicate",
	rename: "fs:rename",
	createFolder: "fs:createFolder",
	trash: "fs:trash",
	reveal: "fs:reveal",
	quickLook: "fs:quickLook",
	open: "fs:open",
	clipboardSet: "fs:clipboardSet",
	clipboardGet: "fs:clipboardGet",
	copyPathsToClipboard: "fs:copyPathsToClipboard",
	versionFamilies: "fs:versionFamilies",
	versionFamiliesRefresh: "fs:versionFamiliesRefresh",
	indexStatus: "index:status",
	indexSetExcluded: "index:setExcluded",
	/** Main → renderer: a background parsed + MinSync refresh settled (payload: error or null). */
	indexRefreshed: "index:refreshed",
} as const;

export type FsChannel = (typeof FS_CHANNELS)[keyof typeof FS_CHANNELS];

export interface FsEntry {
	/** File or folder name (last path segment). */
	readonly name: string;
	/** Absolute OS path. */
	readonly path: string;
	readonly kind: "folder" | "file";
	/** Lowercase extension without the dot; "" for folders and extensionless files. */
	readonly ext: string;
	/** Bytes; null for folders. */
	readonly size: number | null;
	/** ISO 8601 modification time. */
	readonly modifiedAt: string;
	readonly isSymlink: boolean;
	/**
	 * The kind the OS itself reports — Finder's Kind / Explorer's Type, e.g.
	 * "MPEG-4 movie". Null for folders and whenever the OS answers nothing; the
	 * renderer then falls back to the extension map.
	 */
	readonly osKind: string | null;
	/**
	 * `autorag-thumb://` URL for the OS-provided tile icon — a Finder thumbnail
	 * on macOS. Null when the OS produced none; the tile then renders its
	 * letter. The PNG bytes stay in the main-process icon cache and load
	 * lazily through the protocol, so this field never carries base64.
	 */
	readonly iconUrl: string | null;
}

export interface DirListing {
	readonly path: string;
	readonly entries: readonly FsEntry[];
}

/**
 * Incremental refresh result for a watched directory: the requested children
 * that currently exist, and the requested paths that are gone (ENOENT/ENOTDIR).
 */
export interface FsEntriesPatch {
	readonly entries: readonly FsEntry[];
	readonly removed: readonly string[];
}

/** Lightweight identity sent back to the main process for background enrichment. */
export interface FsEnrichmentTarget {
	readonly path: string;
	readonly kind: "folder" | "file";
	readonly ext: string;
	readonly modifiedAt: string;
}

/** Background metadata/thumbnail result; identity fields echo the requested entry. */
export interface FsEntryEnrichment {
	readonly path: string;
	readonly modifiedAt: string;
	readonly osKind: string | null;
	readonly iconUrl: string | null;
}

/**
 * The virtual sidebar location listing recently opened or previewed files.
 * It is not a directory on disk: the main process answers `listDir` for it from
 * the app-owned recents store, and search / version-family scans skip it.
 */
export const RECENTS_PATH = "Recents";

/** A browsable top-level location shown in the sidebar. */
export interface FsLocation {
	/** Display name, e.g. "Desktop", "Documents". */
	readonly name: string;
	readonly path: string;
	/** Sidebar section for grouping. */
	readonly section: "favorites" | "cloud";
	/** True when the path exists and is readable right now. */
	readonly available: boolean;
}

/** In-app file clipboard (copy/cut + paste between folders). */
export interface FsClipboard {
	readonly op: "copy" | "cut";
	readonly paths: readonly string[];
}

export interface FsOpError {
	readonly path: string;
	readonly message: string;
}

/** Batch operation result: one entry per requested path. */
export interface FsBatchResult {
	readonly ok: readonly string[];
	readonly failed: readonly FsOpError[];
}

/** Substring filename search over every available location (except Recents). */
export interface FsSearchResult {
	readonly entry: FsEntry;
	/** The location name this hit belongs to, e.g. "Documents". */
	readonly location: string;
}

export interface FsCoreBridge {
	listDir(path: string): Promise<DirListing>;
	enrichEntries(targets: readonly FsEnrichmentTarget[], thumbnails: boolean): Promise<readonly FsEntryEnrichment[]>;
	/**
	 * Re-resolve only the requested direct children of `dir` after a change
	 * event. Every path is queried against the current disk, so a file deleted
	 * and recreated (or atomically replaced) reports its real, final state
	 * rather than a stale removal. Children that are now missing (ENOENT or
	 * ENOTDIR) come back in `removed`; any other filesystem error propagates.
	 */
	readEntries(dir: string, paths: readonly string[]): Promise<FsEntriesPatch>;
	stat(path: string): Promise<FsEntry>;
	exists(path: string): Promise<boolean>;
	search(query: string): Promise<readonly FsSearchResult[]>;
	locations(): Promise<readonly FsLocation[]>;
	/** Copy paths into destDir. Name collisions get a " copy" suffix (Finder-style). */
	copy(paths: readonly string[], destDir: string): Promise<FsBatchResult>;
	/** Move paths into destDir (cut + paste). */
	move(paths: readonly string[], destDir: string): Promise<FsBatchResult>;
	/** Duplicate in place (Finder "Duplicate": "<name> copy"). */
	duplicate(paths: readonly string[]): Promise<FsBatchResult>;
	/** Rename a single entry. Rejects empty names and name collisions. */
	rename(path: string, newName: string): Promise<FsEntry>;
	/**
	 * Create a new folder inside `directory` (Finder "New Folder"). The first
	 * one is "untitled folder"; a taken name falls through to "untitled folder
	 * 2", "untitled folder 3", … Returns the created folder's absolute path
	 * and name.
	 */
	createFolder(directory: string): Promise<{ readonly path: string; readonly name: string }>;
	/** Move to the macOS Trash (shell.trashItem). */
	trash(paths: readonly string[]): Promise<FsBatchResult>;
	/** Reveal in the real Finder (shell.showItemInFolder). */
	reveal(path: string): Promise<void>;
	/**
	 * Remember a file the in-app Quick Look opened. The renderer draws the
	 * preview; this does not spawn a platform preview app.
	 */
	quickLook(path: string): Promise<void>;
	/**
	 * Open the path with the OS default application for its type, exactly
	 * like double-clicking the file in Finder / Explorer. Implementation:
	 * Electron `shell.openPath`; a non-empty result message rejects.
	 */
	open(path: string): Promise<void>;
	clipboardSet(clipboard: FsClipboard): Promise<void>;
	clipboardGet(): Promise<FsClipboard | null>;
	/** Write the absolute paths as text to the OS clipboard ("Copy Path"). */
	copyPathsToClipboard(paths: readonly string[]): Promise<void>;
}

/**
 * Version-family members of the fs bridge. The main process composes them from
 * the persisted-snapshot service, not from the filesystem service.
 */
export interface FsVersionFamilyBridge {
	/**
	 * Version families from the persisted dupey snapshot (SSOT): one entry per
	 * family (head path, members with relations, entries for rendering), plus an
	 * explicit error when dupey is missing or the last scan failed. Reads the
	 * snapshot; it never runs a scan itself.
	 */
	versionFamilies(): Promise<FsVersionFamiliesResult>;
	/** Forces a dupey scan now, persists it, and returns the fresh snapshot. */
	refreshVersionFamilies(): Promise<FsVersionFamiliesResult>;
}

export interface FsIndexBridge {
	indexStatus(paths: readonly string[]): Promise<readonly IndexStatus[]>;
	setIndexExcluded(path: string, excluded: boolean): Promise<IndexStatus>;
	/** Fires when the refresh a toggle started has settled; `error` is null on success. */
	onIndexRefreshed?(listener: (error: string | null) => void): () => void;
}

export interface FsBridge extends FsCoreBridge, FsVersionFamilyBridge, FsIndexBridge {}

export type FsVersionRelation = "exact" | "near" | "contains";

export interface FsVersionMember {
	readonly path: string;
	readonly relation: FsVersionRelation;
}

export interface FsVersionFamily {
	readonly head: string;
	readonly members: readonly FsVersionMember[];
	readonly entries: readonly FsEntry[];
}

export interface FsVersionFamilyError {
	readonly code: "dupey-missing" | "scan-failed";
	readonly message: string;
	/** Present for dupey-missing: the command that installs the required CLI. */
	readonly installCommand: string | null;
}

/**
 * Version families never degrade silently: the renderer renders `error` when
 * the dupey CLI is missing or a scan fails. `scannedAt` is the persisted
 * snapshot's timestamp, so the UI can tell how old the families are.
 */
export interface FsVersionFamiliesResult {
	readonly families: readonly FsVersionFamily[];
	readonly scannedAt: string | null;
	readonly error: FsVersionFamilyError | null;
}
