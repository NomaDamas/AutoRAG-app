import type { IndexStatus } from "./index-contract";
import type { NewFileFormatId } from "./new-file-contract";

/**
 * Finder contract shared by the filesystem worker, the main process, and the
 * renderer.
 *
 * The fs worker (`src/fs-worker`, an Electron utility process) implements
 * every member; the preload exposes typed wrappers on `window.autorag.fs` that
 * talk to it over a MessagePort (`fs-worker-protocol.ts`). All paths crossing
 * this boundary are absolute OS paths. Datasource virtual identifiers
 * (`/kakao/...`) never appear here — they belong to the search bridge, not the
 * filesystem.
 */

/** IPC channels the main process still owns for the Finder. */
export const FS_CHANNELS = {
	/** Renderer → main: hand a row drag to the OS as real files; fire and forget. */
	startDrag: "fs:startDrag",
} as const;

/** Finder/Spotlight metadata used by Sort By and Group By. */
export interface FsFinderMetadata {
	readonly createdAt: string | null;
	readonly addedAt: string | null;
	readonly lastOpenedAt: string | null;
	readonly tags: readonly string[];
	/** Each tag's colour as the file stored it (parallel to `tags`); the registry's colour wins when it knows the tag. */
	readonly tagColors?: readonly FsTagColor[];
	readonly comments: string | null;
	readonly width: number | null;
	readonly height: number | null;
	readonly rating: number | null;
	readonly application: string | null;
}

/** `FsEntry.flags` bit: the path is a symbolic link (the other fields describe its target when it resolves). */
export const FS_ENTRY_SYMLINK = 1;

/**
 * One directory child as the filesystem reports it: plain values only, no
 * display strings and nothing the renderer can derive. Labels (date, size,
 * kind) are computed when a cell renders; the OS kind, tile icon, and Finder
 * metadata arrive later through `enrichEntries` / `finderMetadata`.
 */
export interface FsEntry {
	/** File or folder name (last path segment). */
	readonly name: string;
	/** Absolute OS path. Kept beside `name`: search hits, Recents, and version families mix folders. */
	readonly path: string;
	/**
	 * "folder" for a browsable directory, "file" for everything the OS opens as
	 * one item. A macOS application bundle (`.app`, a directory on disk) reports
	 * "file": the OS launches it instead of listing its contents.
	 */
	readonly kind: "folder" | "file";
	/** Lowercase extension without the dot; "" for folders and extensionless files. An app bundle carries "app". */
	readonly ext: string;
	/** Bytes; null for folders and app bundles (both are directories on disk). */
	readonly size: number | null;
	/** Modification time in epoch ms (`fs.Stats.mtimeMs`); also the file-version identity for enrichment. */
	readonly mtimeMs: number;
	/** Creation time in epoch ms, only when the filesystem exposes a real birth time. */
	readonly birthtimeMs?: number;
	/** Bit set of `FS_ENTRY_*` flags. */
	readonly flags: number;
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
	readonly mtimeMs: number;
}

/**
 * Background OS kind and tile icon for one requested entry; identity fields
 * echo the request. Finder metadata travels separately (`finderMetadata`):
 * its helper processes and EXIF reads are far slower than the icon pool, and
 * a folder's icons must never wait for them.
 */
export interface FsEntryEnrichment {
	readonly path: string;
	readonly mtimeMs: number;
	readonly osKind: string | null;
	readonly iconUrl: string | null;
}

/** Finder/Spotlight metadata for one requested entry; identity fields echo the request. */
export interface FsFinderEnrichment {
	readonly path: string;
	readonly mtimeMs: number;
	readonly finder: FsFinderMetadata;
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
	| "discord"
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

/**
 * Finder tags (macOS only). A tag's colour is the Finder label index: 0 none,
 * then 1 gray, 2 green, 3 purple, 4 blue, 5 yellow, 6 red, 7 orange.
 */
export type FsTagColor = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** One tag in Finder's tag registry. */
export interface FsTag {
	readonly name: string;
	readonly color: FsTagColor;
	/** Finder lists it in its sidebar (the registry's `p` flag). */
	readonly sidebar: boolean;
}

/**
 * The tags this Mac knows. `supported` is false off macOS, where the sidebar
 * has no Tags section and the row menu no tag items. `colorNames` is the OS's
 * localized name per colour index (`NSWorkspace.fileLabels`): the names the
 * seven colour dots tag a file with.
 */
export interface FsTagCatalog {
	readonly supported: boolean;
	readonly tags: readonly FsTag[];
	readonly colorNames: readonly string[];
	/**
	 * macOS refused the app Finder's tag registry (no Full Disk Access): the
	 * custom tags' names are known, their colours are not, and every one of them
	 * would draw as a hollow ring. The sidebar then offers the grant.
	 */
	readonly colorsDenied: boolean;
}

/** Tags to add to and to remove from every requested path; names match case-insensitively. */
export interface FsTagChange {
	readonly add: readonly string[];
	readonly remove: readonly string[];
}

/**
 * The virtual location listing every file and folder that carries one tag. Like
 * Recents it is not a directory on disk: the listing's rows keep their real
 * paths, and nothing is created, pasted, or watched there.
 */
export const TAG_PATH_PREFIX = "tag://";

export function tagPath(name: string): string {
	return `${TAG_PATH_PREFIX}${name}`;
}

export function isTagPath(path: string): boolean {
	return path.startsWith(TAG_PATH_PREFIX) && path.length > TAG_PATH_PREFIX.length;
}

/** The tag `path` lists; "" when `path` is not a tag location. */
export function tagNameOf(path: string): string {
	return isTagPath(path) ? path.slice(TAG_PATH_PREFIX.length) : "";
}

/** True for the locations that list real files without being their folder: Recents and a tag. */
export function isVirtualListing(path: string): boolean {
	return path === RECENTS_PATH || isTagPath(path);
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
 * The operations the undo history records, named so the UI can say what a
 * ⌘Z / ⇧⌘Z just took back or applied again.
 */
export type FsHistoryOperation =
	| "copy"
	| "move"
	| "duplicate"
	| "rename"
	| "createFolder"
	| "createFile"
	| "trash"
	| "restore"
	| "extract"
	| "compress";

/** The operations an Action output can be recorded as ({@link FsCoreBridge.recordCreated}). */
export type FsRecordedOperation = Extract<FsHistoryOperation, "extract" | "compress">;

/**
 * Outcome of ⌘Z / ⇧⌘Z: the main process undoes (or redoes) the newest
 * operation of its bounded history. A step that cannot apply reports its
 * path with the verbatim reason in `failed`; the record is consumed either way.
 */
export interface FsUndoOutcome {
	/** True when a record existed and every step was applied. */
	readonly ok: boolean;
	/** True when the history held nothing to undo (or redo). */
	readonly empty: boolean;
	/** Per-step failures with the verbatim reason. */
	readonly failed: readonly FsOpError[];
	/** The operation that was undone or redone; absent when `empty`. */
	readonly operation?: FsHistoryOperation;
}
/** Substring filename search over every available location (except Recents). */
export interface FsSearchResult {
	readonly entry: FsEntry;
	/** The location name this hit belongs to, e.g. "Documents". */
	readonly location: string;
}

/** Options for {@link FsCoreBridge.search}. */
export interface FsSearchOptions {
	/**
	 * Restrict hits to this folder subtree (an absolute path); absent searches
	 * the whole file-name index. The "파일 이름" chip passes the folder in view.
	 */
	readonly scope?: string;
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
	/** Finder metadata for the targets the platform answers for; the rest are omitted. */
	finderMetadata(targets: readonly FsEnrichmentTarget[]): Promise<readonly FsFinderEnrichment[]>;
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
	previewIcon(path: string, mtimeMs: number): Promise<string | null>;
	exists(path: string): Promise<boolean>;
	search(query: string, options?: FsSearchOptions): Promise<readonly FsSearchResult[]>;
	locations(): Promise<readonly FsLocation[]>;
	/** Finder's tag registry; `supported` is false off macOS. */
	tags(): Promise<FsTagCatalog>;
	/**
	 * Add and remove Finder tags on every path (macOS). Each path reports on its
	 * own: one that cannot be tagged fails with the verbatim reason and the rest
	 * still change. Existing tags a path carries and are not named stay as they are.
	 */
	setTags(paths: readonly string[], change: FsTagChange): Promise<FsBatchResult>;
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
	/**
	 * Create a new file inside `directory` from the format's template (Finder
	 * "New File"). The first one is "untitled.<ext>"; a taken name falls
	 * through to "untitled 2.<ext>", "untitled 3.<ext>", … Returns the created
	 * file's absolute path and name.
	 */
	createFile(directory: string, format: NewFileFormatId): Promise<{ readonly path: string; readonly name: string }>;
	/** Move to the macOS Trash (shell.trashItem). */
	/**
	 * Create a temporary Evidence Folder populated with symlinks (or hardlink/copy
	 * fallback on restricted platforms) for the existing local paths in `paths`.
	 * Returns the created folder's absolute path.
	 */
	createEvidenceFolder(paths: readonly string[], folderName?: string): Promise<string>;
	/**
	 * Delete a temporary Evidence Folder previously created by
	 * {@link createEvidenceFolder}. Paths outside tracked Evidence Folders are ignored.
	 */
	removeEvidenceFolder(folderPath: string): Promise<void>;
	trash(paths: readonly string[]): Promise<FsBatchResult>;
	/**
	 * Restore trashed payloads back to the folders they came from (Finder
	 * "Put Back"). `ok` lists the trash paths that went back; a payload whose
	 * origin nobody knows fails with its verbatim reason and stays put. Undoing
	 * this operation (⌘Z) moves the rows back into the Trash.
	 */
	restoreFromTrash(paths: readonly string[]): Promise<FsBatchResult>;
	/**
	 * Permanently delete everything in the Trash. `ok` lists the trash paths
	 * deleted; each path that could not be deleted fails with its verbatim
	 * reason. Windows' `$I` records go with their payloads.
	 */
	emptyTrash(): Promise<FsBatchResult>;
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
	/** Undo the newest operation of the history (⌘Z): copy, move, duplicate, rename, create, trash, Put Back, extract, compress. */
	undo(): Promise<FsUndoOutcome>;
	/** Redo the operation the last undo took back (⇧⌘Z); a new operation clears the redo history. */
	redo(): Promise<FsUndoOutcome>;
	/**
	 * Record an output an Action (extract, compress) created at the absolute
	 * `path`, so ⌘Z can move it to the Trash. Rejects a relative or missing path.
	 */
	recordCreated(path: string, operation: FsRecordedOperation): Promise<void>;
	/** Write the absolute paths as text to the OS clipboard ("Copy Path"). */
	copyPathsToClipboard(paths: readonly string[]): Promise<void>;
}

/**
 * The renderer's row drag-out. It is not a filesystem operation — the main
 * process starts an Electron native drag with the paths — so it sits beside the
 * filesystem service rather than inside it.
 */
export interface FsDragBridge {
	/**
	 * Hand a row drag to the OS as real files (`webContents.startDrag`). The
	 * renderer calls this from `dragstart` after `preventDefault()`; the OS then
	 * owns the gesture, so the files can land in Finder, Mail, or any other app.
	 * Fire and forget — there is no reply.
	 */
	startDrag(paths: readonly string[]): void;
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

export interface FsBridge extends FsCoreBridge, FsVersionFamilyBridge, FsIndexBridge, FsDragBridge {}

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
