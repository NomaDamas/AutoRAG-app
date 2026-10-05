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
	details: "fs:details",
	previewIcon: "fs:previewIcon",
	exists: "fs:exists",
	search: "fs:search",
	locations: "fs:locations",
	ejectLocation: "fs:ejectLocation",
	/** Main → renderer: a volume mounted/unmounted or a cloud account connected/disconnected. */
	locationsChanged: "fs:locationsChanged",
	copy: "fs:copy",
	move: "fs:move",
	duplicate: "fs:duplicate",
	rename: "fs:rename",
	createFolder: "fs:createFolder",
	trash: "fs:trash",
	reveal: "fs:reveal",
	quickLook: "fs:quickLook",
	open: "fs:open",
	openUrl: "fs:openUrl",
	clipboardSet: "fs:clipboardSet",
	clipboardGet: "fs:clipboardGet",
	undo: "fs:undo",
	copyPathsToClipboard: "fs:copyPathsToClipboard",
	versionFamilies: "fs:versionFamilies",
	versionFamiliesRefresh: "fs:versionFamiliesRefresh",
	indexStatus: "index:status",
	indexSetExcluded: "index:setExcluded",
	/** Main → renderer: a background parsed + MinSync refresh settled (payload: error or null). */
	indexRefreshed: "index:refreshed",
} as const;

export type FsChannel = (typeof FS_CHANNELS)[keyof typeof FS_CHANNELS];

/** Finder/Spotlight metadata used by Sort By and Group By. */
export interface FsFinderMetadata {
	readonly createdAt: string | null;
	readonly addedAt: string | null;
	readonly lastOpenedAt: string | null;
	readonly tags: readonly string[];
	readonly comments: string | null;
	readonly width: number | null;
	readonly height: number | null;
	readonly rating: number | null;
	readonly application: string | null;
}

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
	/** ISO 8601 creation time, when the filesystem exposes one. */
	readonly createdAt?: string;
	/** Spotlight/Finder metadata; absent when the platform has no equivalent. */
	readonly finder?: FsFinderMetadata;
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
	readonly createdAt?: string;
}

/** Background metadata/thumbnail result; identity fields echo the requested entry. */
export interface FsEntryEnrichment {
	readonly path: string;
	readonly modifiedAt: string;
	readonly osKind: string | null;
	readonly iconUrl: string | null;
	readonly finder?: FsFinderMetadata;
}

/**
 * The virtual sidebar location listing recently opened or previewed files.
 * It is not a directory on disk: the main process answers `listDir` for it from
 * the app-owned recents store, and search / version-family scans skip it.
 */
export const RECENTS_PATH = "Recents";

/**
 * The normalized `http:` / `https:` URL `text` names, or null. Only web pages
 * may reach `openUrl`: `file:`, `javascript:`, and custom schemes would let
 * model output launch local programs. Shared so main re-checks what the
 * renderer sends.
 */
export function webUrl(text: string): string | null {
	const trimmed = text.trim();
	if (!/^https?:\/\//iu.test(trimmed) || !URL.canParse(trimmed)) return null;
	const url = new URL(trimmed);
	return url.hostname === "" ? null : url.href;
}

/** Sidebar glyph for a location; the renderer maps each to a lucide icon. */
export type FsLocationIcon =
	| "recents"
	| "home"
	| "applications"
	| "desktop"
	| "documents"
	| "downloads"
	| "music"
	| "movies"
	| "pictures"
	| "trash"
	| "qa"
	| "icloud"
	| "google-drive"
	| "onedrive"
	| "dropbox"
	| "box"
	| "cloud"
	| "disk"
	| "network";

/**
 * A browsable top-level location shown in the sidebar. Cloud rows are the
 * drives connected to the OS (one per account); `locations` rows are the boot
 * disk plus every mounted volume / drive letter.
 */
export interface FsLocation {
	/** Display name, e.g. "Desktop", "Google Drive - me@example.com", "Data (D:)". */
	readonly name: string;
	readonly path: string;
	/** Sidebar section for grouping. */
	readonly section: "favorites" | "cloud" | "locations";
	readonly icon: FsLocationIcon;
	/** True when the path exists and is readable right now. */
	readonly available: boolean;
	/** Walked by filename search and the version-family scan (content folders and cloud drives, never whole disks). */
	readonly scanned: boolean;
	/** A mounted volume the sidebar offers to unmount (never the boot disk / system drive). */
	readonly ejectable: boolean;
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

/**
 * Outcome of ⌘Z: the main process undoes its most recent recorded copy/move
 * transfer (a copy step deletes the created row, a move step moves the row
 * back to its original folder). The record is consumed by the call.
 */
export interface FsUndoOutcome {
	/** True when a record existed and every step was applied. */
	readonly ok: boolean;
	/** True when no transfer was recorded to undo. */
	readonly empty: boolean;
	/** Per-step failures with the verbatim reason. */
	readonly failed: readonly FsOpError[];
}
/** Substring filename search over every available location (except Recents). */
export interface FsSearchResult {
	readonly entry: FsEntry;
	/** The location name this hit belongs to, e.g. "Documents". */
	readonly location: string;
}

/** A geographic coordinate read from a photo's EXIF GPS IFD. */
export interface FsGeoPoint {
	readonly latitude: number;
	readonly longitude: number;
}

/**
 * Camera/photo metadata read from a file's EXIF. Every field is optional
 * because cameras write different subsets; null means the file carries no such
 * tag (or the file is not an image exifr can read).
 */
export interface FsImageMetadata {
	readonly width: number | null;
	readonly height: number | null;
	readonly make: string | null;
	readonly model: string | null;
	readonly lens: string | null;
	/** ISO sensitivity. */
	readonly iso: number | null;
	/** Relative aperture, e.g. 2.8 for f/2.8. */
	readonly fNumber: number | null;
	/** Exposure time in seconds, e.g. 0.008 for 1/125 s. */
	readonly exposureTime: number | null;
	/** Focal length in millimeters. */
	readonly focalLength: number | null;
	/** 35mm-equivalent focal length in millimeters. */
	readonly focalLength35mm: number | null;
	/** ISO 8601 capture time (EXIF DateTimeOriginal), null when untagged. */
	readonly dateTaken: string | null;
	readonly exposureProgram: string | null;
	readonly meteringMode: string | null;
	readonly flash: string | null;
	readonly whiteBalance: string | null;
	readonly colorSpace: string | null;
	readonly orientation: string | null;
	readonly software: string | null;
	readonly artist: string | null;
	readonly copyright: string | null;
	readonly gps: FsGeoPoint | null;
}

/**
 * Rich file metadata for the Inspector's Info panel: everything the OS
 * reports for a path (times, size, mode, ownership, symlink) plus EXIF for
 * images. Read on demand for the focused entry, so it never rides on listings.
 */
export interface FsFileDetails {
	readonly path: string;
	readonly kind: "folder" | "file";
	/** Bytes; null for folders. */
	readonly size: number | null;
	/** ISO 8601 creation (birth) time; falls back to the inode change time like Finder. */
	readonly createdAt: string;
	readonly modifiedAt: string;
	readonly accessedAt: string;
	/** Inode change time (ctime). */
	readonly changedAt: string;
	readonly isSymlink: boolean;
	/** Absolute target of a symlink; null otherwise. */
	readonly linkTarget: string | null;
	/** ls-style permission string, e.g. "-rw-r--r--". */
	readonly permissions: string;
	/** Owning user name when resolvable, else the numeric uid. */
	readonly owner: string;
	/** Owning group name when resolvable, else the numeric gid. */
	readonly group: string;
	readonly inode: number;
	/** EXIF metadata for image files; null otherwise. */
	readonly image: FsImageMetadata | null;
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
	/** Rich metadata for the Info panel: OS stat fields plus EXIF for images. */
	details(path: string): Promise<FsFileDetails>;
	/**
	 * Large-tier (640px) Quick Look thumbnail for the Info panel's preview
	 * paper, as an `autorag-thumb://` URL; null when the OS produced none and
	 * the panel keeps its letter tile. On demand per inspected file — never
	 * part of listings.
	 */
	previewIcon(path: string, modifiedAt: string): Promise<string | null>;
	exists(path: string): Promise<boolean>;
	search(query: string): Promise<readonly FsSearchResult[]>;
	locations(): Promise<readonly FsLocation[]>;
	/** Unmount the ejectable location at `path` (diskutil on macOS, eject / net use on Windows); rejects with the OS reason. */
	ejectLocation(path: string): Promise<void>;
	/** Fires when the mounted volumes or connected cloud accounts change; returns the unsubscribe. */
	onLocationsChanged?(listener: () => void): () => void;
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
	/** Open an `http(s)` page in the OS default browser (`shell.openExternal`); rejects any other scheme. */
	openUrl(url: string): Promise<void>;
	clipboardSet(clipboard: FsClipboard): Promise<void>;
	clipboardGet(): Promise<FsClipboard | null>;
	/** Undo the most recent recorded copy/move transfer (⌘Z). The record is consumed. */
	undo(): Promise<FsUndoOutcome>;
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
