import { randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename as fsRename, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, sep, win32 } from "node:path";
import {
	RECENTS_PATH,
	isTagPath,
	tagNameOf,
	webUrl,
	type DirListing,
	type FsHistoryOperation,
	type FsRecordedOperation,
	type FsUndoOutcome,
	type FsBatchResult,
	type FsCoreBridge,
	type FsClipboard,
	type FsEntriesPatch,
	type FsEnrichmentTarget,
	type FsEntry,
	type FsEntryEnrichment,
	type FsFinderEnrichment,
	type FsFileDetails,
	type FsLocation,
	type FsOpError,
	type FsSearchOptions,
	type FsSearchResult,
} from "../shared/fs-contract";
import { newFileFormat, type NewFileFormatId } from "../shared/new-file-contract";
import { t } from "../shared/i18n/core";
import type { FileNameSearchBackend } from "./file-name-search";
import { newFileContents } from "./file-templates";
import { createFinderMetadataResolver, type FinderMetadataLookup } from "./finder-metadata";
import { createFinderTags, type FinderTags } from "./finder-tags";
import { createIconProvider, type IconProvider } from "./file-icon";
import { copyTree } from "./copy-tree";
import { createOsKindResolver } from "./file-kind";
import { readFileDetails } from "./file-details";
import { buildFsEntry, errorMessage, hasErrorCode, isAvailable, onDiskPath, pathExists, resolveCopyName } from "./fs-entry";
import { createPlaces, type Places } from "./places";
import { isRecycleBinDir, readRecycleBinName, readRecycleBinRecord } from "./recycle-bin";
import { createRecentsStore, type RecentsStore } from "./recents-store";
import { discordAttachmentPaths, type DiscordAttachmentPaths } from "./discord-attachments";
import { isInsideSystemFolder, isSystemFolderName } from "./system-folders";
import { createTrashStore, type TrashStore } from "./trash-store";

/** Subset of Electron's shell used by the service (injected for testability). */
export interface FsShell {
	trashItem(path: string): Promise<void>;
	showItemInFolder(fullPath: string): void;
	/** Electron shell.openPath: resolves with "" on success or a verbatim error message. */
	openPath(path: string): Promise<string>;
	/** Electron shell.openExternal: the OS default handler for the URL (a browser for http/https). */
	openExternal(url: string): Promise<void>;
}

/** Subset of Electron's clipboard used by the service (injected for testability). */
export interface FsOsClipboard {
	writeText(text: string): void;
	/** Put the files themselves on the OS clipboard, so other apps paste them as files. */
	writeFiles(paths: readonly string[]): Promise<void>;
}

/** OS-native file-kind lookup: Finder's kind on macOS, Explorer's type on Windows. */
export type OsKindLookup = (path: string, ext: string) => Promise<string | null>;

export interface FsServiceDeps {
	readonly shell: FsShell;
	readonly clipboard: FsOsClipboard;
	/** Defaults to process.platform; tests inject one to pin platform-specific behavior. */
	readonly platform?: NodeJS.Platform;
	/** Defaults to os.homedir(); tests inject a fixture home. */
	readonly homeDir?: string;
	/** Playwright points the first tab here. Absent in normal runs. */
	readonly qaRoot?: string;
	/** Recently opened/previewed files. Defaults to `<homeDir>/recents`; production injects the userData store. */
	readonly recents?: RecentsStore;
	/** Put-Back origins for payloads the app trashed. Defaults to `<homeDir>/trash-store`; production injects the userData store. */
	readonly trashStore?: TrashStore;
	/** Defaults to the platform resolver (mdls on macOS, the registry on Windows). */
	readonly osKind?: OsKindLookup;
	/** Defaults to the platform icon provider (native Quick Look thumbnails on macOS/Windows). */
	readonly icons?: IconProvider;
	/** Defaults to the real stat + EXIF reader; tests inject a stub. */
	readonly details?: (path: string) => Promise<FsFileDetails>;
	/** Defaults to the macOS extended-attribute + Spotlight resolver; tests may inject one. */
	readonly finderMetadata?: FinderMetadataLookup;
	/** Finder tags (macOS); defaults to the real Spotlight + extended-attribute implementation. */
	readonly tags?: FinderTags;
	/** Defaults to the OS places for `homeDir`; production injects one with Electron's known-folder paths. */
	readonly places?: Places;
	/** The AutoRAG home and config variables (AUTORAG_HOME, AUTORAG_CONFIG); defaults to process.env. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Defaults to the Windows `$Recycle.Bin\<SID>` shape; tests point it at a fixture folder. */
	readonly recycleBin?: (dir: string) => boolean;
	/**
	 * Fast filename search (fsearch on macOS/Linux, Everything on Windows).
	 * When absent, or when it reports no index, search walks the disk.
	 */
	readonly fileNameSearch?: FileNameSearchBackend;
}

export type FsRenameErrorCode = "invalid-name" | "name-collision";

export class FsRenameError extends Error {
	readonly code: FsRenameErrorCode;

	constructor(code: FsRenameErrorCode, message: string) {
		super(message);
		this.name = "FsRenameError";
		this.code = code;
	}
}

/** Search stays bounded: shallow walk, hard result cap, symlinked dirs not followed. */
const SEARCH_MAX_DEPTH = 4;
const SEARCH_MAX_RESULTS = 200;
/** How many operations ⌘Z can walk back; the oldest falls off. */
const HISTORY_LIMIT = 100;

/**
 * Normalize a path before handing it to Electron's `shell` (trash/reveal/open).
 * Windows rejects forward-slash paths in `shell.trashItem` ("Failed to parse
 * path"), while Node's own fs calls accept them, so only the OS handoff needs
 * backslashes. POSIX platforms keep the path byte-for-byte.
 */
export function toHandoffPath(path: string, platform: NodeJS.Platform): string {
	return platform === "win32" ? win32.normalize(path) : path;
}

/**
 * Move one item to the Trash. The iCloud Drive file provider (`~/Documents`,
 * `~/Desktop` with Desktop & Documents sync) sometimes refuses a batch partway
 * through: after one or two items land in the Trash, every later
 * `trashItem` call fails with "you don't have permission to access it". The
 * refusal sticks to the file for 10–50 seconds, and plain retries do not clear
 * it. Renaming the item to a hidden sibling and straight back clears it at
 * once, so after a refusal we do that round trip and try once more. The item
 * keeps its own name, so the Trash entry and Put Back stay as Finder makes
 * them. A second refusal is a real failure and goes back to the caller as-is.
 */
async function trashOne(path: string, platform: NodeJS.Platform, trashItem: (path: string) => Promise<void>): Promise<void> {
	try {
		await trashItem(toHandoffPath(path, platform));
		return;
	} catch (error) {
		// A random parked name: POSIX rename replaces an existing target, so a
		// fixed name could overwrite a real file that happens to carry it.
		const parked = join(dirname(path), `.${basename(path)}.${randomUUID().slice(0, 8)}.autorag-trash`);
		try {
			await fsRename(path, parked);
		} catch {
			throw error;
		}
		try {
			await fsRename(parked, path);
		} catch (restoreError) {
			throw new Error(
				t("main.fs.restoreTempFailed", {
					message: errorMessage(error),
					name: basename(parked),
					detail: errorMessage(restoreError),
				}),
			);
		}
	}
	await trashItem(toHandoffPath(path, platform));
}

/**
 * Finder's new-folder naming for the Nth mkdir attempt: the first free name is
 * "untitled folder", then "untitled folder 2", "untitled folder 3", … The
 * caller retries with the next attempt only when mkdir reports EEXIST, so the
 * numbering matches exactly the names already on disk.
 */
export function untitledFolderName(attempt: number): string {
	return attempt === 1 ? "untitled folder" : `untitled folder ${attempt}`;
}

/**
 * Finder's new-file naming for the Nth attempt: "untitled.txt", then
 * "untitled 2.txt", "untitled 3.txt", … The numbering is driven by the `wx`
 * write failing with EEXIST, so it matches exactly the names already on disk.
 */
export function untitledFileName(extension: string, attempt: number): string {
	return `${attempt === 1 ? "untitled" : `untitled ${attempt}`}.${extension}`;
}

interface SearchContext {
	readonly needle: string;
	readonly location: string;
	readonly platform: NodeJS.Platform;
	readonly discord: DiscordAttachmentPaths;
	readonly results: FsSearchResult[];
	readonly signal: AbortSignal | undefined;
}

function compareEntries(a: FsEntry, b: FsEntry): number {
	if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
	return a.name.localeCompare(b.name);
}

/** Compare paths across platforms: the Windows index reports backslash paths. */
function normalizeSlashes(path: string): string {
	return path.replace(/\\/g, "/");
}

/** OS tile icons for a batch's files; the provider batches one call per listing. */
async function resolveIcons(targets: readonly FsEnrichmentTarget[], provider: IconProvider): Promise<ReadonlyMap<string, string>> {
	const files = targets
		.filter((target) => target.kind === "file")
		.map((target) => ({ path: target.path, ext: target.ext, mtimeMs: target.mtimeMs }));
	if (files.length === 0) return new Map();
	return provider.icons(files);
}

async function runBatch(paths: readonly string[], operation: (path: string) => Promise<void>): Promise<FsBatchResult> {
	const ok: string[] = [];
	const failed: FsOpError[] = [];
	for (const path of paths) {
		try {
			await operation(path);
			ok.push(path);
		} catch (error) {
			failed.push({ path, message: errorMessage(error) });
		}
	}
	return { ok, failed };
}

/** Rename across folders, falling back to copy+delete across devices. */
async function movePath(source: string, target: string): Promise<void> {
	try {
		await fsRename(source, target);
	} catch (error) {
		// Cross-device move: copy the tree, then remove the source.
		if (!hasErrorCode(error, "EXDEV")) throw error;
		await copyTree(source, target);
		await rm(source, { recursive: true, force: true });
	}
}

/** Move a row back into `restoreDir`, Finder-style collision naming included. Returns where it landed. */
async function moveBack(path: string, restoreDir: string): Promise<string> {
	const stepStat = await lstat(path);
	const back = join(restoreDir, await resolveCopyName(restoreDir, basename(path), stepStat.isDirectory()));
	await movePath(path, back);
	return back;
}

async function walkForSearch(dir: string, depth: number, context: SearchContext): Promise<void> {
	context.signal?.throwIfAborted();
	if (depth > SEARCH_MAX_DEPTH || context.results.length >= SEARCH_MAX_RESULTS) return;
	let dirents: Dirent[];
	try {
		dirents = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		// Unreadable directory: skip the subtree, keep the verbatim reason visible.
		console.warn(`fs:search skipping ${dir}: ${errorMessage(error)}`);
		return;
	}
	for (const dirent of dirents) {
		if (context.results.length >= SEARCH_MAX_RESULTS) return;
		// System folders are neither results nor walked; a symlink named like one is the user's own link.
		if (dirent.isDirectory() && isSystemFolderName(dirent.name)) continue;
		// A Discord connection's status file, `.discrawl/` and `.lock/` are the sync's, not attachments.
		if (context.discord.isInternalEntry(dir, dirent.name)) continue;
		const fullPath = join(dir, dirent.name);
		// macOS stores Hangul names decomposed (NFD); compare in one form so a typed (NFC) query matches.
		if (dirent.name.normalize("NFC").toLowerCase().includes(context.needle)) {
			try {
				context.results.push({
					entry: await buildFsEntry(fullPath, context.platform),
					location: context.location,
				});
			} catch (error) {
				console.warn(`fs:search skipping ${fullPath}: ${errorMessage(error)}`);
			}
		}
		if (dirent.isDirectory() && !dirent.isSymbolicLink()) {
			await walkForSearch(fullPath, depth + 1, context);
		}
	}
}

/**
 * The filesystem service as the worker serves it: the bridge contract, plus an
 * AbortSignal on the two ops that walk a folder, so a listing or search the
 * user already left stops instead of finishing for nobody.
 */
export interface FsService extends FsCoreBridge {
	listDir(path: string, signal?: AbortSignal): Promise<DirListing>;
	search(query: string, options?: FsSearchOptions, signal?: AbortSignal): Promise<readonly FsSearchResult[]>;
	/** Write one browser-uploaded file into `directory` under a free name (remote access). */
	uploadFile(directory: string, name: string, data: Uint8Array): Promise<{ readonly path: string; readonly name: string }>;
	/** Read one whole file for a browser download (remote access). */
	readFileBytes(path: string): Promise<Uint8Array | null>;
	/** Clean up any remaining temporary Evidence Folders on worker shutdown. */
	disposeEvidenceFolders?(): Promise<void>;
}

export function createFsService(deps: FsServiceDeps): FsService {
	const platform = deps.platform ?? process.platform;
	const home = deps.homeDir ?? homedir();
	const env = deps.env ?? process.env;
	const recents = deps.recents ?? createRecentsStore({ directory: join(home, "recents") });
	const osKind: OsKindLookup = deps.osKind ?? createOsKindResolver().kindFor;
	const finderMetadata = deps.finderMetadata ?? createFinderMetadataResolver();
	const finderTags = deps.tags ?? createFinderTags({ platform, homeDir: home });
	const iconProvider: IconProvider = deps.icons ?? createIconProvider();
	const places = deps.places ?? createPlaces({ homeDir: home, platform, env });
	const discord = discordAttachmentPaths(env, home);
	const recycleBin = deps.recycleBin ?? isRecycleBinDir;
	const trashStore = deps.trashStore ?? createTrashStore({ directory: join(home, "trash-store") });
	// In-app clipboard lives in this process's memory only (the fs worker in the app).
	let inAppClipboard: FsClipboard | null = null;
	/**
	 * Resolved targets for symlinks placed on the in-app clipboard: when an
	 * Evidence Folder is removed before the user pastes, the clipboard entry
	 * still resolves to the original source file under the link's (possibly
	 * renamed) filename.
	 */
	const clipboardResolved = new Map<string, { readonly targetPath: string; readonly name: string }>();
	/** Active temporary Evidence Folders: `folderPath -> parentTempDir`. */
	const evidenceFolders = new Map<string, string>();

	async function rememberClipboardTargets(paths: readonly string[]): Promise<void> {
		await Promise.all(
			paths.map(async (path) => {
				try {
					const info = await lstat(path);
					if (!info.isSymbolicLink()) return;
					const resolved = await realpath(path).catch(() => readlink(path));
					if (isAbsolute(resolved)) {
						clipboardResolved.set(path, { targetPath: resolved, name: basename(path) });
					}
				} catch {
					/* path may already be resolved or gone */
				}
			}),
		);
	}

	function sanitizeFolderName(raw: string | undefined): string {
		const trimmed = (raw ?? "").trim().replace(/[/\\:*?"<>|\0]/gu, "-");
		if (trimmed.length === 0 || trimmed === "." || trimmed === "..") return "Evidence Folder";
		return trimmed;
	}

	function findTrackedEvidenceFolder(candidate: string): { readonly folderPath: string; readonly parentDir: string } | null {
		const direct = evidenceFolders.get(candidate);
		if (direct !== undefined) return { folderPath: candidate, parentDir: direct };
		for (const [folderPath, parentDir] of evidenceFolders) {
			if (candidate === parentDir || candidate.startsWith(`${folderPath}${sep}`)) {
				return { folderPath, parentDir };
			}
		}
		return null;
	}

	function forgetEvidenceSteps(folderPath: string, parentDir: string): void {
		const inside = (path: string): boolean =>
			path === folderPath ||
			path === parentDir ||
			path.startsWith(`${folderPath}${sep}`) ||
			path.startsWith(`${parentDir}${sep}`);
		const stepTouches = (step: FsUndoStep): boolean =>
			inside(step.path) || (step.kind === "move" && inside(step.restoreDir));
		for (const stack of [undoStack, redoStack]) {
			for (let index = stack.length - 1; index >= 0; index -= 1) {
				const entry = stack[index];
				if (entry === undefined) continue;
				entry.steps = entry.steps.filter((step) => !stepTouches(step));
				if (entry.steps.length === 0) stack.splice(index, 1);
			}
		}
	}

	async function linkEvidenceEntry(sourcePath: string, targetPath: string, isDirectory: boolean): Promise<void> {
		try {
			await symlink(sourcePath, targetPath, isDirectory ? "junction" : "file");
			return;
		} catch (error) {
			if (!hasErrorCode(error, "EPERM") && !hasErrorCode(error, "EACCES") && !hasErrorCode(error, "ENOSYS")) {
				throw error;
			}
		}
		if (!isDirectory) {
			try {
				await link(sourcePath, targetPath);
				return;
			} catch {
				/* cross-device or unsupported: fall back to copy */
			}
		}
		await copyTree(sourcePath, targetPath, { dereference: true });
	}

	async function createEvidenceFolder(paths: readonly string[], folderName?: string): Promise<string> {
		const baseTmp = await realpath(tmpdir()).catch(() => tmpdir());
		const parentDir = await mkdtemp(join(baseTmp, "dazzi-evidence-"));
		const folderPath = join(parentDir, sanitizeFolderName(folderName));
		await mkdir(folderPath, { recursive: true });
		evidenceFolders.set(folderPath, parentDir);

		const seen = new Set<string>();
		for (const rawPath of paths) {
			if (!isAbsolute(rawPath)) continue;
			const key = rawPath.normalize("NFC");
			if (seen.has(key)) continue;
			seen.add(key);
			try {
				const diskPath = await onDiskPath(rawPath).catch(() => rawPath);
				const sourceStat = await stat(diskPath);
				const isDir = sourceStat.isDirectory();
				const targetName = await resolveCopyName(folderPath, basename(diskPath), isDir);
				await linkEvidenceEntry(diskPath, join(folderPath, targetName), isDir);
			} catch (error) {
				if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR")) {
					console.warn(`fs:createEvidenceFolder skipping ${rawPath}: ${errorMessage(error)}`);
				}
			}
		}
		return folderPath;
	}

	async function removeEvidenceFolder(folderPath: string): Promise<void> {
		const tracked = findTrackedEvidenceFolder(folderPath);
		if (tracked === null) return;
		if (inAppClipboard !== null) {
			await rememberClipboardTargets(inAppClipboard.paths);
		}
		evidenceFolders.delete(tracked.folderPath);
		forgetEvidenceSteps(tracked.folderPath, tracked.parentDir);
		await rm(tracked.folderPath, { recursive: true, force: true });
		await rmdir(tracked.parentDir).catch(() => undefined);
	}

	async function disposeEvidenceFolders(): Promise<void> {
		const parents = [...new Set(evidenceFolders.values())];
		evidenceFolders.clear();
		await Promise.all(parents.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
	}
	/**
	 * OS kind and tile icon only. Finder metadata is a separate call: its
	 * helper processes and EXIF reads are far slower than the icon pool on a
	 * slow disk, and folding it in made every icon in the batch wait for the
	 * slowest file's metadata.
	 */
	async function enrichEntries(
		targets: readonly FsEnrichmentTarget[],
		thumbnails: boolean,
	): Promise<readonly FsEntryEnrichment[]> {
		const [icons, kinds] = await Promise.all([
			thumbnails ? resolveIcons(targets, iconProvider) : Promise.resolve(new Map<string, string>()),
			Promise.all(
				targets.map(async (target) => {
					if (target.kind !== "file") return null;
					try {
						return await osKind(target.path, target.ext);
					} catch (error) {
						console.warn(`fs:osKind failed for ${target.path}: ${errorMessage(error)}`);
						return null;
					}
				}),
			),
		]);
		return targets.map((target, index) => ({
			path: target.path,
			mtimeMs: target.mtimeMs,
			osKind: kinds[index] ?? null,
			iconUrl: icons.get(target.path) ?? null,
		}));
	}

	async function finderMetadataFor(targets: readonly FsEnrichmentTarget[]): Promise<readonly FsFinderEnrichment[]> {
		const results = await Promise.all(
			targets.map(async (target): Promise<FsFinderEnrichment | null> => {
				const finder = await finderMetadata(target.path);
				if (finder === null) return null;
				// A missing Spotlight creation date falls back to the listing's birth time in the renderer.
				return { path: target.path, mtimeMs: target.mtimeMs, finder };
			}),
		);
		return results.filter((result) => result !== null);
	}

	async function buildListingEntries(dirents: readonly Dirent[], path: string, signal?: AbortSignal): Promise<FsEntry[]> {
		const entries: FsEntry[] = [];
		for (let index = 0; index < dirents.length; index += 64) {
			// A folder the user already left stops here instead of stat-ing every remaining child.
			signal?.throwIfAborted();
			const batch = dirents.slice(index, index + 64);
			const built = await Promise.all(
				batch.map(async (dirent) => {
					const fullPath = join(path, dirent.name);
					try {
						return await buildFsEntry(fullPath, platform);
					} catch (error) {
						// Unreadable entry: skip it, keep the verbatim reason visible.
						console.warn(`fs:listDir skipping ${fullPath}: ${errorMessage(error)}`);
						return null;
					}
				}),
			);
			for (const entry of built) {
				if (entry !== null) entries.push(entry);
			}
		}
		return entries;
	}

	async function listDir(path: string, signal?: AbortSignal): Promise<DirListing> {
		if (path === RECENTS_PATH) {
			// The recents store already lists most-recent first; sorting by
			// name would destroy that order.
			return { path, entries: await recentEntries() };
		}
		if (isTagPath(path)) return { path, entries: await taggedEntries(tagNameOf(path), signal) };
		const dirents = await readdir(path, { withFileTypes: true });
		if (recycleBin(path)) {
			return { path, entries: await recycleBinEntries(path, dirents) };
		}
		const visible = dirents.filter((dirent) => !discord.isInternalEntry(path, dirent.name));
		const entries = await buildListingEntries(visible, path, signal);
		entries.sort(compareEntries);
		return { path, entries };
	}

	/**
	 * A Windows Recycle Bin folder, as Explorer shows it: one row per `$R`
	 * payload, named after its `$I` record's original path. The row keeps the
	 * payload's real path, so open / Quick Look / delete act on the actual file.
	 */
	async function recycleBinEntries(path: string, dirents: readonly Dirent[]): Promise<FsEntry[]> {
		const payloads = dirents.filter((dirent) => dirent.name.startsWith("$R"));
		const entries = await buildListingEntries(payloads, path);
		const named = await Promise.all(
			entries.map(async (entry) => {
				const record = join(path, `$I${entry.name.slice(2)}`);
				const original = await readRecycleBinName(record).catch((error: unknown) => {
					console.warn(`fs:listDir ${record}: ${errorMessage(error)}`);
					return null;
				});
				return original === null ? entry : { ...entry, name: original };
			}),
		);
		return named.sort(compareEntries);
	}

	/**
	 * Incremental relist for a watched directory: resolve exactly the requested
	 * direct children against the current disk, enrich only those with OS kind
	 * and tile icon, and report the ones that vanished. Paths are deduplicated
	 * and resolved with bounded concurrency so a large change burst stays cheap.
	 */
	async function readEntries(dir: string, paths: readonly string[]): Promise<FsEntriesPatch> {
		if (!isAbsolute(dir)) {
			throw new Error(`Invalid directory "${dir}": expected an absolute path`);
		}
		const requested = [...new Set(paths)];
		for (const path of requested) {
			if (!isAbsolute(path) || dirname(path) !== dir) {
				throw new Error(`Invalid path "${path}": expected a direct child of "${dir}"`);
			}
		}
		const entries: FsEntry[] = [];
		const removed: string[] = [];
		for (let index = 0; index < requested.length; index += 64) {
			const batch = requested.slice(index, index + 64);
			const resolved = await Promise.all(
				batch.map(async (path) => {
					try {
						return { path, entry: await buildFsEntry(path, platform) };
					} catch (error) {
						if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
							return { path, entry: null };
						}
						throw error;
					}
				}),
			);
			for (const item of resolved) {
				// The sync rewrites its status file and logs all the time; the listing never shows them, so the patch must not add them.
				if (item.entry === null || discord.isInternalEntry(dir, basename(item.path))) removed.push(item.path);
				else entries.push(item.entry);
			}
		}
		return { entries, removed };
	}

	/**
	 * The virtual Recents listing: recorded paths that still exist, most recent
	 * first. A file that moved or was deleted simply drops out of the view; any
	 * other failure keeps its verbatim reason visible.
	 */
	async function recentEntries(): Promise<FsEntry[]> {
		const entries: FsEntry[] = [];
		for (const stored of await recents.list()) {
			try {
				entries.push(await buildFsEntry(stored, platform));
			} catch (error) {
				if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR")) {
					console.warn(`fs:listDir ${RECENTS_PATH} skipping ${stored}: ${errorMessage(error)}`);
				}
			}
		}
		return entries;
	}

	/**
	 * The virtual tag listing: every indexed path carrying the tag, as real
	 * entries. A hit that vanished since the index last ran drops out; any other
	 * failure keeps its verbatim reason visible.
	 */
	async function taggedEntries(name: string, signal?: AbortSignal): Promise<FsEntry[]> {
		const entries: FsEntry[] = [];
		const paths = await finderTags.search(name);
		const hits = await Promise.all(
			paths.map(async (hit) => {
				signal?.throwIfAborted();
				try {
					return await buildFsEntry(hit, platform);
				} catch (error) {
					const gone = ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].some((code) => hasErrorCode(error, code));
					if (!gone) console.warn(`fs:listDir tag ${name} skipping ${hit}: ${errorMessage(error)}`);
					return null;
				}
			}),
		);
		for (const hit of hits) if (hit !== null) entries.push(hit);
		return entries.sort(compareEntries);
	}

	async function locations(): Promise<readonly FsLocation[]> {
		const result: FsLocation[] = [
			{
				name: RECENTS_PATH,
				path: RECENTS_PATH,
				section: "favorites",
				icon: "recents",
				available: true,
				scanned: false,
				ejectable: false,
			},
		];
		if (deps.qaRoot !== undefined) {
			result.push({
				name: "QA",
				path: deps.qaRoot,
				section: "favorites",
				icon: "qa",
				available: await isAvailable(deps.qaRoot),
				scanned: true,
				ejectable: false,
			});
		}
		result.push(...(await places.list()));
		return result;
	}

	/**
	 * Filename substring search, case-insensitive. The platform index answers
	 * when it can (fsearch / Everything); otherwise the disk walk runs. `scope`
	 * restricts both to one folder subtree — the "파일 이름" chip's folder.
	 */
	async function search(query: string, options?: FsSearchOptions, signal?: AbortSignal): Promise<readonly FsSearchResult[]> {
		const needle = query.trim().normalize("NFC").toLowerCase();
		if (needle.length === 0) return [];
		const rawScope = options?.scope?.trim();
		const scope = rawScope !== undefined && rawScope.length > 0 ? rawScope : undefined;
		const backend = deps.fileNameSearch;
		if (backend !== undefined) {
			try {
				const paths = await backend.search(query, scope);
				if (paths !== null) return indexedHits(paths, scope);
			} catch (error) {
				console.warn(`fs:search index failed, walking instead: ${errorMessage(error)}`);
			}
		}
		return walkSearch(needle, scope, signal);
	}

	/**
	 * Turn index paths into rows, attributing each to its location by longest prefix.
	 * The index knows nothing of system folders or a Discord sync's own entries, so hits inside them are dropped here.
	 */
	async function indexedHits(paths: readonly string[], scope: string | undefined): Promise<readonly FsSearchResult[]> {
		const known = (await locations()).filter((location) => location.path !== RECENTS_PATH);
		const results: FsSearchResult[] = [];
		for (const path of paths) {
			if (results.length >= SEARCH_MAX_RESULTS) break;
			if (isInsideSystemFolder(path, scope) || discord.isInternalPath(path)) continue;
			try {
				results.push({ entry: await buildFsEntry(path, platform), location: searchLocation(path, known) });
			} catch (error) {
				// The index can be stale: a path that vanished since indexing is skipped.
				if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR")) {
					console.warn(`fs:search skipping ${path}: ${errorMessage(error)}`);
				}
			}
		}
		return results;
	}

	function searchLocation(path: string, known: readonly FsLocation[]): string {
		const target = normalizeSlashes(path);
		let match: FsLocation | undefined;
		for (const location of known) {
			const root = normalizeSlashes(location.path);
			if (target !== root && !target.startsWith(`${root}/`)) continue;
			if (match === undefined || location.path.length > match.path.length) match = location;
		}
		return match?.name ?? dirname(path);
	}

	async function walkSearch(needle: string, scope: string | undefined, signal: AbortSignal | undefined): Promise<readonly FsSearchResult[]> {
		const results: FsSearchResult[] = [];
		if (scope !== undefined) {
			// The "파일 이름" chip scopes to the folder in view, which may sit
			// outside the scanned places (e.g. inside a mounted disk).
			const known = (await locations()).filter((location) => location.path !== RECENTS_PATH);
			await walkForSearch(scope, 0, { needle, location: searchLocation(scope, known), platform, discord, results, signal });
			return results;
		}
		for (const location of await locations()) {
			// Recents is virtual and whole disks are too large to walk; only scanned places count.
			if (!location.available || !location.scanned) continue;
			await walkForSearch(location.path, 0, { needle, location: location.name, platform, discord, results, signal });
			if (results.length >= SEARCH_MAX_RESULTS) break;
		}
		return results;
	}

	/** How a created row came to be, so redo can make it again. */
	type FsUndoMake =
		| { readonly kind: "copy"; readonly from: string }
		| { readonly kind: "folder" }
		| { readonly kind: "file"; readonly format: NewFileFormatId };

	/**
	 * One reversible step. Applying a step (undo or redo alike) returns its
	 * inverse, which is what the opposite history stack stores — so a record
	 * only ever needs one `applyStep`.
	 */
	type FsUndoStep =
		/** `path` exists because of the operation; applying removes it. */
		| { readonly kind: "created"; readonly path: string; readonly make: FsUndoMake }
		/** `path` was removed by an undo; applying makes it again. */
		| { readonly kind: "removed"; readonly path: string; readonly make: FsUndoMake }
		/** The row at `path` goes back into `restoreDir` (Finder-style collision naming). */
		| { readonly kind: "move"; readonly path: string; readonly restoreDir: string }
		/** The row at `path` takes the name `name` back; a retaken name fails. */
		| { readonly kind: "rename"; readonly path: string; readonly name: string }
		/** The item sits in the Trash; applying puts it back at `path` (Finder "Put Back"). */
		| { readonly kind: "trash"; readonly path: string }
		/** The item sits at `path`; applying moves it into the Trash. */
		| { readonly kind: "restore"; readonly path: string };

	/** One user-visible operation: all its steps undo (and redo) together. */
	interface FsHistoryRecord {
		readonly operation: FsHistoryOperation;
		steps: FsUndoStep[];
	}

	/** Operations ⌘Z can walk back, newest last; a new operation clears what ⇧⌘Z could redo. */
	const undoStack: FsHistoryRecord[] = [];
	const redoStack: FsHistoryRecord[] = [];

	function pushBounded(stack: FsHistoryRecord[], entry: FsHistoryRecord): void {
		stack.push(entry);
		if (stack.length > HISTORY_LIMIT) stack.shift();
	}

	/** Record a fresh operation: it becomes the next ⌘Z and the redo history is forgotten. */
	function record(operation: FsHistoryOperation, steps: readonly FsUndoStep[]): FsHistoryRecord {
		const entry: FsHistoryRecord = { operation, steps: [...steps] };
		pushBounded(undoStack, entry);
		redoStack.length = 0;
		return entry;
	}

	/** Take a record back when none of its steps took effect. */
	function discard(entry: FsHistoryRecord): void {
		const index = undoStack.lastIndexOf(entry);
		if (index >= 0) undoStack.splice(index, 1);
	}

	/** The Trash was emptied: steps that put a payload back have nothing left to act on. */
	function forgetTrashedSteps(): void {
		for (const stack of [undoStack, redoStack]) {
			for (let index = stack.length - 1; index >= 0; index -= 1) {
				const entry = stack[index];
				if (entry === undefined) continue;
				entry.steps = entry.steps.filter((step) => step.kind !== "trash");
				if (entry.steps.length === 0) stack.splice(index, 1);
			}
		}
	}

	/** Move one item to the Trash and remember where it came from (Put Back, ⌘Z). */
	async function trashOneAndRecord(path: string): Promise<void> {
		await trashOne(path, platform, (target) => deps.shell.trashItem(target));
		// Windows keeps the origin in the `$I` record itself; macOS keeps none,
		// so the app owns it. A record that fails to persist only costs that
		// one item's Put Back from the view, never the trashing itself.
		if (platform === "darwin") {
			const dir = await places.trashDir();
			if (dir !== null) {
				await trashStore
					.record([{ sourcePath: path, trashPath: join(dir, basename(path)) }])
					.catch((error: unknown) => console.warn(`fs:trash origin not kept for ${path}: ${errorMessage(error)}`));
			}
		}
	}

	/**
	 * The original location a Trash payload should go back to: the `$I`
	 * record's path on Windows, the app-kept origin on macOS. Null when
	 * neither knows — the payload stays put and the caller reports why.
	 */
	async function trashOrigin(payloadPath: string): Promise<string | null> {
		if (recycleBin(dirname(payloadPath))) {
			const record = await readRecycleBinRecord(join(dirname(payloadPath), `$I${basename(payloadPath).slice(2)}`)).catch(
				() => null,
			);
			return record?.originalPath ?? null;
		}
		if (platform === "win32") return null;
		return (await trashStore.find(payloadPath))?.sourcePath ?? null;
	}

	/** Finder "Put Back" for one payload: move it to `origin`, named the way the folder left it. */
	async function putBackPayload(payloadPath: string, origin: string): Promise<string> {
		const originDir = dirname(origin);
		const target = join(originDir, await resolveCopyName(originDir, basename(origin), (await lstat(payloadPath)).isDirectory()));
		await movePath(payloadPath, target);
		if (recycleBin(dirname(payloadPath))) {
			// Windows: a record must not outlive its payload.
			await rm(join(dirname(payloadPath), `$I${basename(payloadPath).slice(2)}`), { force: true });
		} else if (platform === "darwin") {
			await trashStore.forget([payloadPath]);
		}
		return target;
	}

	/**
	 * The Trash payload `sourcePath` became when it was trashed (⌘Z after a
	 * trash). Windows finds it by scanning the records naming the source and
	 * keeping the newest whose payload still exists; macOS expects it in
	 * `~/.Trash` under the item's own name.
	 */
	async function payloadForSource(sourcePath: string): Promise<string> {
		if (platform === "win32") {
			const dir = await places.trashDir();
			if (dir === null) {
				throw new Error(t("main.fs.trashLocationUnknown"));
			}
			let found: { readonly payload: string; readonly deletedAt: bigint } | null = null;
			for (const name of await readdir(dir).catch(() => [] as string[])) {
				if (!name.startsWith("$I")) continue;
				const record = await readRecycleBinRecord(join(dir, name)).catch(() => null);
				if (record === null || normalizeSlashes(record.originalPath) !== normalizeSlashes(sourcePath)) continue;
				const payload = join(dir, `$R${name.slice(2)}`);
				if (!(await pathExists(payload))) continue;
				if (found === null || record.deletedAt > found.deletedAt) found = { payload, deletedAt: record.deletedAt };
			}
			if (found === null) {
				throw new Error(t("main.fs.trashItemNotFound", { name: basename(sourcePath) }));
			}
			return found.payload;
		}
		const dir = await places.trashDir();
		if (dir === null) {
			throw new Error(t("main.fs.trashLocationUnknown"));
		}
		const expected = join(dir, basename(sourcePath));
		if (!(await pathExists(expected))) {
			throw new Error(t("main.fs.trashItemNotFound", { name: basename(sourcePath) }));
		}
		return expected;
	}

	/** Restore trashed payloads back to the folders they came from (Finder "Put Back"). */
	async function restoreFromTrash(paths: readonly string[]): Promise<FsBatchResult> {
		const steps: FsUndoStep[] = [];
		const result = await runBatch(paths, async (payloadPath) => {
			const origin = await trashOrigin(payloadPath);
			if (origin === null) {
				throw new Error(t("main.fs.trashOriginUnknown", { name: basename(payloadPath) }));
			}
			// ⌘Z moves the row back into the Trash, like undoing any other move.
			steps.push({ kind: "restore", path: await putBackPayload(payloadPath, origin) });
		});
		if (steps.length > 0) record("restore", steps);
		return result;
	}

	/**
	 * Permanently delete everything in the Trash: the payloads the view shows
	 * plus Windows' `$I` records, keeping the OS's own metadata files
	 * (.DS_Store, desktop.ini). Origins are forgotten and a trash-kind undo
	 * record is dropped, so ⌘Z cannot resurrect what an empty removed.
	 */
	async function emptyTrash(): Promise<FsBatchResult> {
		const dir = await places.trashDir();
		if (dir === null) {
			return { ok: [], failed: [{ path: "", message: t("main.fs.trashLocationUnknown") }] };
		}
		let names: string[];
		try {
			names = await readdir(dir);
		} catch (error) {
			// A Trash folder that does not exist is already empty.
			if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR")) throw error;
			return { ok: [], failed: [] };
		}
		const deletable =
			platform === "win32"
				? (name: string) => name.startsWith("$R") || name.startsWith("$I")
				: (name: string) => !name.startsWith(".");
		const result = await runBatch(
			names.filter(deletable).map((name) => join(dir, name)),
			async (path) => {
				await rm(path, { recursive: true, force: true });
			},
		);
		if (result.ok.length === 0) return result;
		if (platform === "darwin") {
			// Every origin record points inside the emptied Trash folder.
			await trashStore
				.forget((await trashStore.list()).map((record) => record.trashPath))
				.catch((error: unknown) => console.warn(`fs:emptyTrash origins not cleared: ${errorMessage(error)}`));
		}
		forgetTrashedSteps();
		return result;
	}

	async function copy(paths: readonly string[], destDir: string): Promise<FsBatchResult> {
		const steps: FsUndoStep[] = [];
		const result = await runBatch(paths, async (source) => {
			let sourcePath = source;
			let desiredName = basename(source);
			let isSymlink = false;
			let isDirectory = false;
			try {
				const sourceStat = await lstat(source);
				isSymlink = sourceStat.isSymbolicLink();
				const effectiveStat = isSymlink ? await stat(source).catch(() => sourceStat) : sourceStat;
				isDirectory = effectiveStat.isDirectory();
			} catch (error) {
				const preserved = clipboardResolved.get(source);
				if (preserved === undefined || (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR"))) {
					throw error;
				}
				sourcePath = preserved.targetPath;
				desiredName = preserved.name;
				isSymlink = true;
				isDirectory = (await stat(sourcePath)).isDirectory();
			}
			const targetName = await resolveCopyName(destDir, desiredName, isDirectory);
			const target = join(destDir, targetName);
			await copyTree(sourcePath, target, { dereference: isSymlink });
			steps.push({ kind: "created", path: target, make: { kind: "copy", from: isSymlink ? await realpath(sourcePath).catch(() => sourcePath) : sourcePath } });
		});
		if (steps.length > 0) record("copy", steps);
		return result;
	}

	async function move(paths: readonly string[], destDir: string): Promise<FsBatchResult> {
		const steps: FsUndoStep[] = [];
		const result = await runBatch(paths, async (source) => {
			let sourceStat: Stats | null = null;
			try {
				sourceStat = await lstat(source);
			} catch (error) {
				const preserved = clipboardResolved.get(source);
				if (preserved === undefined || (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR"))) {
					throw error;
				}
				const targetStat = await stat(preserved.targetPath);
				const target = join(destDir, await resolveCopyName(destDir, preserved.name, targetStat.isDirectory()));
				await copyTree(preserved.targetPath, target, { dereference: true });
				steps.push({ kind: "created", path: target, make: { kind: "copy", from: preserved.targetPath } });
				return;
			}
			if (sourceStat.isSymbolicLink()) {
				const effectiveStat = await stat(source).catch(() => sourceStat);
				const realTarget = await realpath(source).catch(() => source);
				const target = join(destDir, await resolveCopyName(destDir, basename(source), effectiveStat.isDirectory()));
				await copyTree(source, target, { dereference: true });
				await rm(source, { recursive: true, force: true });
				steps.push({ kind: "created", path: target, make: { kind: "copy", from: realTarget } });
				return;
			}
			const target = join(destDir, await resolveCopyName(destDir, basename(source), sourceStat.isDirectory()));
			await movePath(source, target);
			steps.push({ kind: "move", path: target, restoreDir: dirname(source) });
		});
		if (steps.length > 0) record("move", steps);
		return result;
	}

	/** Make a row that an undo removed, at exactly its old path; a retaken path fails. */
	async function recreate(path: string, make: FsUndoMake): Promise<void> {
		if (make.kind === "folder") {
			await mkdir(path);
		} else if (make.kind === "file") {
			await writeFile(path, newFileContents(make.format), { flag: "wx" });
		} else {
			if (await pathExists(path)) {
				throw new Error(t("main.fs.renameCollision", { name: basename(path) }));
			}
			await copyTree(make.from, path);
		}
	}

	/** Apply one step in its own direction and return the inverse step. */
	async function applyStep(step: FsUndoStep): Promise<FsUndoStep> {
		switch (step.kind) {
			case "created":
				await rm(step.path, { recursive: true });
				return { kind: "removed", path: step.path, make: step.make };
			case "removed":
				await recreate(step.path, step.make);
				return { kind: "created", path: step.path, make: step.make };
			case "move":
				return { kind: "move", path: await moveBack(step.path, step.restoreDir), restoreDir: dirname(step.path) };
			case "rename":
				return { kind: "rename", path: await renameTo(step.path, step.name), name: basename(step.path) };
			case "trash":
				return { kind: "restore", path: await putBackPayload(await payloadForSource(step.path), step.path) };
			case "restore":
				await trashOneAndRecord(step.path);
				return { kind: "trash", path: step.path };
		}
	}

	/**
	 * Walk one record from `source` to `target`: undo moves the newest record
	 * from the undo stack to the redo stack, redo the other way. A step that
	 * cannot be applied reports its path and verbatim reason; the steps that
	 * did apply stay reversible through the other stack. The record is consumed
	 * either way.
	 */
	async function replay(source: FsHistoryRecord[], target: FsHistoryRecord[]): Promise<FsUndoOutcome> {
		const entry = source.pop();
		if (entry === undefined) {
			return { ok: false, empty: true, failed: [] };
		}
		const inverse: FsUndoStep[] = [];
		const failed: FsOpError[] = [];
		for (const step of entry.steps) {
			try {
				inverse.push(await applyStep(step));
			} catch (error) {
				failed.push({ path: step.path, message: errorMessage(error) });
			}
		}
		if (inverse.length > 0) pushBounded(target, { operation: entry.operation, steps: inverse });
		return { ok: failed.length === 0, empty: false, failed, operation: entry.operation };
	}

	/**
	 * ⌘Z: undo the newest recorded operation. A created row is deleted; a
	 * move goes back to the folder it came from with Finder-style collision
	 * naming; a rename takes the old name back unless somebody retook it; a
	 * trash puts the item back where it was (Finder "Put Back"); a Put Back
	 * moves the row into the Trash again.
	 */
	const undo = (): Promise<FsUndoOutcome> => replay(undoStack, redoStack);

	/** ⇧⌘Z: apply the operation the last ⌘Z took back. */
	const redo = (): Promise<FsUndoOutcome> => replay(redoStack, undoStack);

	/** Record an output the renderer observed an Action produce (extract, compress): undo moves it to the Trash. */
	/** A browser upload keeps its own name, made safe and de-duplicated by Finder rules. */
	async function uploadFile(directory: string, name: string, data: Uint8Array): Promise<{ readonly path: string; readonly name: string }> {
		const safe = basename(name.trim().replace(/[/\\:\0]/gu, "-")) || "upload";
		const unique = await resolveCopyName(directory, safe, false);
		const target = join(directory, unique);
		// Not recorded in the undo history: replaying an upload would have to keep
		// the file's bytes in memory for every history entry.
		await writeFile(target, data, { flag: "wx" });
		return { path: target, name: unique };
	}

	async function readFileBytes(path: string): Promise<Uint8Array | null> {
		try {
			const info = await lstat(path);
			if (!info.isFile()) return null;
			return new Uint8Array(await readFile(path));
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return null;
			throw error;
		}
	}

	async function recordCreated(path: string, operation: FsRecordedOperation): Promise<void> {
		if (!isAbsolute(path)) {
			throw new Error(`Invalid path "${path}": expected an absolute path`);
		}
		await lstat(path);
		record(operation, [{ kind: "restore", path }]);
	}

	async function duplicate(paths: readonly string[]): Promise<FsBatchResult> {
		const steps: FsUndoStep[] = [];
		const result = await runBatch(paths, async (source) => {
			const sourceStat = await lstat(source);
			const isSymlink = sourceStat.isSymbolicLink();
			const effectiveStat = isSymlink ? await stat(source).catch(() => sourceStat) : sourceStat;
			const dir = dirname(source);
			const targetName = await resolveCopyName(dir, basename(source), effectiveStat.isDirectory());
			const target = join(dir, targetName);
			await copyTree(source, target, { dereference: isSymlink });
			steps.push({ kind: "created", path: target, make: { kind: "copy", from: isSymlink ? await realpath(source).catch(() => source) : source } });
		});
		if (steps.length > 0) record("duplicate", steps);
		return result;
	}

	/** Rename `path` to `newName` in its folder; a taken name (other than a case-only change) fails. Returns the new path. */
	async function renameTo(path: string, newName: string): Promise<string> {
		const target = join(dirname(path), newName);
		if (newName.toLowerCase() !== basename(path).toLowerCase() && (await pathExists(target))) {
			throw new FsRenameError("name-collision", t("main.fs.renameCollision", { name: newName }));
		}
		await fsRename(path, target);
		return target;
	}

	async function rename(path: string, newName: string): Promise<FsEntry> {
		if (newName.trim().length === 0) {
			throw new FsRenameError("invalid-name", t("main.fs.renameEmpty"));
		}
		if (newName.includes("/") || newName.includes("\\") || newName === "." || newName === "..") {
			throw new FsRenameError("invalid-name", t("main.fs.renameSeparator", { name: newName }));
		}
		const currentName = basename(path);
		if (newName === currentName) {
			throw new FsRenameError("name-collision", t("main.fs.renameCollision", { name: newName }));
		}
		const target = await renameTo(path, newName);
		record("rename", [{ kind: "rename", path: target, name: currentName }]);
		return buildFsEntry(target, platform);
	}

	async function createFolder(directory: string): Promise<{ readonly path: string; readonly name: string }> {
		// Non-recursive mkdir: the EEXIST collision is what drives the numbering,
		// so a folder that appears between two attempts is handled the same way.
		for (let attempt = 1; ; attempt += 1) {
			const name = untitledFolderName(attempt);
			const target = join(directory, name);
			try {
				await mkdir(target);
				record("createFolder", [{ kind: "created", path: target, make: { kind: "folder" } }]);
				return { path: target, name };
			} catch (error) {
				if (!hasErrorCode(error, "EEXIST")) throw error;
			}
		}
	}

	async function createFile(directory: string, format: NewFileFormatId): Promise<{ readonly path: string; readonly name: string }> {
		const { extension } = newFileFormat(format);
		const contents = newFileContents(format);
		// `wx` fails with EEXIST when the name is taken, which drives the
		// numbering; the exclusive create also avoids clobbering a file that
		// appears between two attempts.
		for (let attempt = 1; ; attempt += 1) {
			const name = untitledFileName(extension, attempt);
			const target = join(directory, name);
			try {
				await writeFile(target, contents, { flag: "wx" });
				record("createFile", [{ kind: "created", path: target, make: { kind: "file", format } }]);
				return { path: target, name };
			} catch (error) {
				if (!hasErrorCode(error, "EEXIST")) throw error;
			}
		}
	}

	return {
		enrichEntries,
		finderMetadata: finderMetadataFor,
		listDir,
		readEntries,
		// A typed location (the path bar) may differ from the disk in case or Unicode form.
		stat: async (path) => buildFsEntry(await onDiskPath(path), platform),
		details: deps.details ?? readFileDetails,
		previewIcon: (path, mtimeMs) =>
			iconProvider.preview({ path, ext: extname(path).slice(1).toLowerCase(), mtimeMs }),
		exists: async (path) => {
			try {
				await lstat(path);
				return true;
			} catch (error) {
				if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return false;
				throw error;
			}
		},
		search,
		locations,
		tags: () => finderTags.catalog(),
		setTags: (paths, change) => finderTags.set(paths, change),
		ejectLocation: (path) => places.eject(path),
		copy,
		move,
		duplicate,
		rename,
		undo,
		redo,
		recordCreated,
		uploadFile,
		readFileBytes,
		createFolder,
		createFile,
		createEvidenceFolder,
		removeEvidenceFolder,
		disposeEvidenceFolders,
		trash: async (paths) => {
			if (paths.length === 0) {
				return { ok: [], failed: [] };
			}
			// Record before the first item leaves: a step names where the item
			// came from, which is known before the move, so a ⌘Z landing while
			// the batch is still moving already finds the record instead of a
			// silent no-op. Items that fail drop out of the record afterwards,
			// and a batch that moves nothing takes the record back.
			const entry = record(
				"trash",
				paths.map((path): FsUndoStep => ({ kind: "trash", path })),
			);
			const result = await runBatch(paths, async (path) => {
				await trashOneAndRecord(path);
			});
			const moved = new Set(result.ok);
			entry.steps = entry.steps.filter((step) => moved.has(step.path));
			if (entry.steps.length === 0) discard(entry);
			return result;
		},
		restoreFromTrash,
		emptyTrash,
		reveal: async (path) => {
			deps.shell.showItemInFolder(toHandoffPath(path, platform));
		},
		quickLook: async (path) => {
			await recents.record(path);
		},
		open: async (path) => {
			const message = await deps.shell.openPath(toHandoffPath(path, platform));
			// Failures surface verbatim — the operator sees the real message.
			if (message !== "") {
				throw new Error(message);
			}
			await recents.record(path);
		},
		openUrl: async (text) => {
			const url = webUrl(text);
			if (url === null) throw new Error(t("main.fs.notWebUrl", { text }));
			await deps.shell.openExternal(url);
		},
		clipboardSet: async (clipboard) => {
			inAppClipboard = { op: clipboard.op, paths: [...clipboard.paths] };
			await rememberClipboardTargets(clipboard.paths);
			// The in-app clipboard keeps cut/copy and symlink targets; the OS clipboard only lets other apps paste the files.
			// A failed OS write must not break in-app copy/paste, so it is logged, not thrown.
			await deps.clipboard.writeFiles(clipboard.paths).catch((error: unknown) => console.error("[clipboard] OS file clipboard:", error));
		},
		clipboardGet: async () => inAppClipboard,
		copyPathsToClipboard: async (paths) => {
			deps.clipboard.writeText(paths.join("\n"));
		},
	};
}
