import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { cp, lstat, mkdir, readdir, rename as fsRename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, win32 } from "node:path";
import {
	RECENTS_PATH,
	webUrl,
	type DirListing,
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
import type { FileNameSearchBackend } from "./file-name-search";
import { newFileContents } from "./file-templates";
import { createFinderMetadataResolver, type FinderMetadataLookup } from "./finder-metadata";
import { createIconProvider, type IconProvider } from "./file-icon";
import { createOsKindResolver } from "./file-kind";
import { readFileDetails } from "./file-details";
import { buildFsEntry, errorMessage, hasErrorCode, isAvailable, pathExists, resolveCopyName } from "./fs-entry";
import { createPlaces, type Places } from "./places";
import { isRecycleBinDir, readRecycleBinName } from "./recycle-bin";
import { createRecentsStore, type RecentsStore } from "./recents-store";

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
	/** Defaults to the platform resolver (mdls on macOS, the registry on Windows). */
	readonly osKind?: OsKindLookup;
	/** Defaults to the platform icon provider (native Quick Look thumbnails on macOS/Windows). */
	readonly icons?: IconProvider;
	/** Defaults to the real stat + EXIF reader; tests inject a stub. */
	readonly details?: (path: string) => Promise<FsFileDetails>;
	/** Defaults to the macOS extended-attribute + Spotlight resolver; tests may inject one. */
	readonly finderMetadata?: FinderMetadataLookup;
	/** Defaults to the OS places for `homeDir`; production injects one with Electron's known-folder paths. */
	readonly places?: Places;
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
		const parked = join(dirname(path), `.${basename(path)}.${randomUUID().slice(0, 8)}.dazzi-trash`);
		try {
			await fsRename(path, parked);
		} catch {
			throw error;
		}
		try {
			await fsRename(parked, path);
		} catch (restoreError) {
			throw new Error(`${errorMessage(error)} (임시 이름 ${basename(parked)}에서 되돌리지 못했습니다: ${errorMessage(restoreError)})`);
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
	readonly results: FsSearchResult[];
}

function compareEntries(a: FsEntry, b: FsEntry): number {
	if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
	return a.name.localeCompare(b.name);
}

/** Compare paths across platforms: the Windows index reports backslash paths. */
function normalizeSlashes(path: string): string {
	return path.replace(/\\/g, "/");
}

/** Attach the OS-reported kind to one entry; a failed lookup keeps the letter/fallback kind. */
async function applyOsKind(entry: FsEntry, lookup: OsKindLookup): Promise<FsEntry> {
	if (entry.kind !== "file") return entry;
	try {
		return { ...entry, osKind: await lookup(entry.path, entry.ext) };
	} catch (error) {
		console.warn(`fs:osKind failed for ${entry.path}: ${errorMessage(error)}`);
		return entry;
	}
}

/** OS tile icons for a batch's files; the provider batches one call per listing. */
async function resolveIcons(targets: readonly FsEnrichmentTarget[], provider: IconProvider): Promise<ReadonlyMap<string, string>> {
	const files = targets
		.filter((target) => target.kind === "file")
		.map((target) => ({ path: target.path, ext: target.ext, modifiedAt: target.modifiedAt }));
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

async function walkForSearch(dir: string, depth: number, context: SearchContext): Promise<void> {
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
		const fullPath = join(dir, dirent.name);
		if (dirent.name.toLowerCase().includes(context.needle)) {
			try {
				context.results.push({
					entry: await buildFsEntry(fullPath),
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

export function createFsService(deps: FsServiceDeps): FsCoreBridge {
	const platform = deps.platform ?? process.platform;
	const home = deps.homeDir ?? homedir();
	const recents = deps.recents ?? createRecentsStore({ directory: join(home, "recents") });
	const osKind: OsKindLookup = deps.osKind ?? createOsKindResolver().kindFor;
	const finderMetadata = deps.finderMetadata ?? createFinderMetadataResolver();
	const iconProvider: IconProvider = deps.icons ?? createIconProvider();
	const places = deps.places ?? createPlaces({ homeDir: home, platform });
	const recycleBin = deps.recycleBin ?? isRecycleBinDir;
	// In-app clipboard lives in main-process memory only.
	let inAppClipboard: FsClipboard | null = null;
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
			modifiedAt: target.modifiedAt,
			osKind: kinds[index] ?? null,
			iconUrl: icons.get(target.path) ?? null,
		}));
	}

	async function finderMetadataFor(targets: readonly FsEnrichmentTarget[]): Promise<readonly FsFinderEnrichment[]> {
		const results = await Promise.all(
			targets.map(async (target): Promise<FsFinderEnrichment | null> => {
				const finder = await finderMetadata(target.path);
				if (finder === null) return null;
				return {
					path: target.path,
					modifiedAt: target.modifiedAt,
					finder: { ...finder, createdAt: finder.createdAt ?? target.createdAt ?? null },
				};
			}),
		);
		return results.filter((result) => result !== null);
	}

	async function buildListingEntries(dirents: readonly Dirent[], path: string): Promise<FsEntry[]> {
		const entries: FsEntry[] = [];
		for (let index = 0; index < dirents.length; index += 64) {
			const batch = dirents.slice(index, index + 64);
			const built = await Promise.all(
				batch.map(async (dirent) => {
					const fullPath = join(path, dirent.name);
					try {
						return await buildFsEntry(fullPath);
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

	async function listDir(path: string): Promise<DirListing> {
		if (path === RECENTS_PATH) {
			// The recents store already lists most-recent first; sorting by
			// name would destroy that order.
			return { path, entries: await recentEntries() };
		}
		const dirents = await readdir(path, { withFileTypes: true });
		if (recycleBin(path)) {
			return { path, entries: await recycleBinEntries(path, dirents) };
		}
		const entries = await buildListingEntries(dirents, path);
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
						return { path, entry: await buildFsEntry(path) };
					} catch (error) {
						if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
							return { path, entry: null };
						}
						throw error;
					}
				}),
			);
			for (const item of resolved) {
				if (item.entry === null) removed.push(item.path);
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
				entries.push(await buildFsEntry(stored));
			} catch (error) {
				if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR")) {
					console.warn(`fs:listDir ${RECENTS_PATH} skipping ${stored}: ${errorMessage(error)}`);
				}
			}
		}
		return entries;
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
	async function search(query: string, options?: FsSearchOptions): Promise<readonly FsSearchResult[]> {
		const needle = query.trim().toLowerCase();
		if (needle.length === 0) return [];
		const rawScope = options?.scope?.trim();
		const scope = rawScope !== undefined && rawScope.length > 0 ? rawScope : undefined;
		const backend = deps.fileNameSearch;
		if (backend !== undefined) {
			try {
				const paths = await backend.search(query, scope);
				if (paths !== null) return indexedHits(paths);
			} catch (error) {
				console.warn(`fs:search index failed, walking instead: ${errorMessage(error)}`);
			}
		}
		return walkSearch(needle, scope);
	}

	/** Turn index paths into rows, attributing each to its location by longest prefix. */
	async function indexedHits(paths: readonly string[]): Promise<readonly FsSearchResult[]> {
		const known = (await locations()).filter((location) => location.path !== RECENTS_PATH);
		const results: FsSearchResult[] = [];
		for (const path of paths) {
			if (results.length >= SEARCH_MAX_RESULTS) break;
			try {
				results.push({ entry: await buildFsEntry(path), location: searchLocation(path, known) });
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

	async function walkSearch(needle: string, scope: string | undefined): Promise<readonly FsSearchResult[]> {
		const results: FsSearchResult[] = [];
		if (scope !== undefined) {
			// The "파일 이름" chip scopes to the folder in view, which may sit
			// outside the scanned places (e.g. inside a mounted disk).
			const known = (await locations()).filter((location) => location.path !== RECENTS_PATH);
			await walkForSearch(scope, 0, { needle, location: searchLocation(scope, known), results });
			return results;
		}
		for (const location of await locations()) {
			// Recents is virtual and whole disks are too large to walk; only scanned places count.
			if (!location.available || !location.scanned) continue;
			await walkForSearch(location.path, 0, { needle, location: location.name, results });
			if (results.length >= SEARCH_MAX_RESULTS) break;
		}
		return results;
	}

	/** One undo step of the most recent copy/move/create operation, consumed by ⌘Z. */
	interface FsUndoStep {
		readonly kind: "copy" | "move" | "create";
		/** The row the transfer created (copy/create) or now occupies (move). */
		readonly path: string;
		/** The folder a move took the row from; "" for copy and create steps. */
		readonly restoreDir: string;
	}

	/** Undo record of the most recent successful copy/move transfer. */
	let lastUndoSteps: readonly FsUndoStep[] | null = null;

	async function copy(paths: readonly string[], destDir: string): Promise<FsBatchResult> {
		const steps: FsUndoStep[] = [];
		const result = await runBatch(paths, async (source) => {
			const sourceStat = await lstat(source);
			const targetName = await resolveCopyName(destDir, basename(source), sourceStat.isDirectory());
			const target = join(destDir, targetName);
			await cp(source, target, { recursive: true });
			steps.push({ kind: "copy", path: target, restoreDir: "" });
		});
		if (steps.length > 0) lastUndoSteps = steps;
		return result;
	}

	async function move(paths: readonly string[], destDir: string): Promise<FsBatchResult> {
		const steps: FsUndoStep[] = [];
		const result = await runBatch(paths, async (source) => {
			const sourceStat = await lstat(source);
			const target = join(destDir, await resolveCopyName(destDir, basename(source), sourceStat.isDirectory()));
			try {
				await fsRename(source, target);
			} catch (error) {
				// Cross-device move: copy the tree, then remove the source.
				if (!hasErrorCode(error, "EXDEV")) throw error;
				await cp(source, target, { recursive: true });
				await rm(source, { recursive: true, force: true });
			}
			steps.push({ kind: "move", path: target, restoreDir: dirname(source) });
		});
		if (steps.length > 0) lastUndoSteps = steps;
		return result;
	}

	/**
	 * Undo the most recent recorded operation (⌘Z). A copy or create step
	 * deletes the row it created; a move step puts the row back into the folder
	 * it came from, with Finder-style collision naming when the original name
	 * was retaken in the meantime. The record is consumed by the call.
	 */
	async function undo(): Promise<FsUndoOutcome> {
		const steps = lastUndoSteps;
		lastUndoSteps = null;
		if (steps === null || steps.length === 0) {
			return { ok: false, empty: true, failed: [] };
		}
		const failed: FsOpError[] = [];
		for (const step of steps) {
			try {
				if (step.kind === "copy" || step.kind === "create") {
					await rm(step.path, { recursive: true });
				} else {
					const stepStat = await lstat(step.path);
					const back = join(step.restoreDir, await resolveCopyName(step.restoreDir, basename(step.path), stepStat.isDirectory()));
					try {
						await fsRename(step.path, back);
					} catch (error) {
						if (!hasErrorCode(error, "EXDEV")) throw error;
						await cp(step.path, back, { recursive: true });
						await rm(step.path, { recursive: true, force: true });
					}
				}
			} catch (error) {
				failed.push({ path: step.path, message: errorMessage(error) });
			}
		}
		return { ok: failed.length === 0, empty: false, failed };
	}

	async function duplicate(paths: readonly string[]): Promise<FsBatchResult> {
		return runBatch(paths, async (source) => {
			const sourceStat = await lstat(source);
			const dir = dirname(source);
			const targetName = await resolveCopyName(dir, basename(source), sourceStat.isDirectory());
			await cp(source, join(dir, targetName), { recursive: true });
		});
	}

	async function rename(path: string, newName: string): Promise<FsEntry> {
		if (newName.trim().length === 0) {
			throw new FsRenameError("invalid-name", "Invalid name: the new name must not be empty");
		}
		if (newName.includes("/") || newName.includes("\\") || newName === "." || newName === "..") {
			throw new FsRenameError("invalid-name", `Invalid name "${newName}": path separators are not allowed`);
		}
		const dir = dirname(path);
		const currentName = basename(path);
		if (newName === currentName) {
			throw new FsRenameError("name-collision", `A file or folder named "${newName}" already exists`);
		}
		const target = join(dir, newName);
		if (newName.toLowerCase() !== currentName.toLowerCase() && (await pathExists(target))) {
			throw new FsRenameError("name-collision", `A file or folder named "${newName}" already exists`);
		}
		await fsRename(path, target);
		return applyOsKind(await buildFsEntry(target), osKind);
	}

	async function createFolder(directory: string): Promise<{ readonly path: string; readonly name: string }> {
		// Non-recursive mkdir: the EEXIST collision is what drives the numbering,
		// so a folder that appears between two attempts is handled the same way.
		for (let attempt = 1; ; attempt += 1) {
			const name = untitledFolderName(attempt);
			const target = join(directory, name);
			try {
				await mkdir(target);
				lastUndoSteps = [{ kind: "create", path: target, restoreDir: "" }];
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
				lastUndoSteps = [{ kind: "create", path: target, restoreDir: "" }];
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
		stat: async (path) => applyOsKind(await buildFsEntry(path), osKind),
		details: deps.details ?? readFileDetails,
		previewIcon: (path, modifiedAt) =>
			iconProvider.preview({ path, ext: extname(path).slice(1).toLowerCase(), modifiedAt }),
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
		ejectLocation: (path) => places.eject(path),
		copy,
		move,
		duplicate,
		rename,
		undo,
		createFolder,
		createFile,
		trash: (paths) => runBatch(paths, (path) => trashOne(path, platform, (target) => deps.shell.trashItem(target))),
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
			if (url === null) throw new Error(`웹 주소가 아닙니다: ${text}`);
			await deps.shell.openExternal(url);
		},
		clipboardSet: async (clipboard) => {
			inAppClipboard = { op: clipboard.op, paths: [...clipboard.paths] };
		},
		clipboardGet: async () => inAppClipboard,
		copyPathsToClipboard: async (paths) => {
			deps.clipboard.writeText(paths.join("\n"));
		},
	};
}
