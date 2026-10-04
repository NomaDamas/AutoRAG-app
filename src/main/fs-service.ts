import type { Dirent } from "node:fs";
import { cp, lstat, mkdir, readdir, rename as fsRename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import {
	RECENTS_PATH,
	type DirListing,
	type FsUndoOutcome,
	type FsBatchResult,
	type FsCoreBridge,
	type FsClipboard,
	type FsEntriesPatch,
	type FsEnrichmentTarget,
	type FsEntry,
	type FsEntryEnrichment,
	type FsFileDetails,
	type FsLocation,
	type FsOpError,
	type FsSearchResult,
} from "../shared/fs-contract";
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
 * Finder's new-folder naming for the Nth mkdir attempt: the first free name is
 * "untitled folder", then "untitled folder 2", "untitled folder 3", … The
 * caller retries with the next attempt only when mkdir reports EEXIST, so the
 * numbering matches exactly the names already on disk.
 */
export function untitledFolderName(attempt: number): string {
	return attempt === 1 ? "untitled folder" : `untitled folder ${attempt}`;
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

/** Attach OS kinds to a batch; the resolver dedupes one query per extension. */
function enrichOsKinds(entries: readonly FsEntry[], lookup: OsKindLookup): Promise<FsEntry[]> {
	return Promise.all(entries.map((entry) => applyOsKind(entry, lookup)));
}

/** OS tile icons for a batch's files; the provider batches one call per listing. */
async function resolveIcons(entries: readonly FsEntry[], provider: IconProvider): Promise<ReadonlyMap<string, string>> {
	const targets = entries
		.filter((entry) => entry.kind === "file")
		.map((entry) => ({ path: entry.path, ext: entry.ext, modifiedAt: entry.modifiedAt }));
	if (targets.length === 0) return new Map();
	return provider.icons(targets);
}

/** A file the OS produced no icon for keeps its letter tile. */
function withIcon(entry: FsEntry, icons: ReadonlyMap<string, string>): FsEntry {
	const url = icons.get(entry.path);
	return url === undefined ? entry : { ...entry, iconUrl: url };
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
	const home = deps.homeDir ?? homedir();
	const recents = deps.recents ?? createRecentsStore({ directory: join(home, "recents") });
	const osKind: OsKindLookup = deps.osKind ?? createOsKindResolver().kindFor;
	const finderMetadata = deps.finderMetadata ?? createFinderMetadataResolver();
	const iconProvider: IconProvider = deps.icons ?? createIconProvider();
	const places = deps.places ?? createPlaces({ homeDir: home });
	const recycleBin = deps.recycleBin ?? isRecycleBinDir;
	// In-app clipboard lives in main-process memory only.
	let inAppClipboard: FsClipboard | null = null;
	/** Resolve OS metadata and optional thumbnails without blocking listDir. */
	async function annotateEntries(entries: readonly FsEntry[], thumbnails: boolean): Promise<FsEntry[]> {
		const [icons, enriched, finders] = await Promise.all([
			thumbnails ? resolveIcons(entries, iconProvider) : Promise.resolve(new Map<string, string>()),
			enrichOsKinds(entries, osKind),
			Promise.all(entries.map((entry) => finderMetadata(entry.path))),
		]);
		return enriched.map((entry, index) => {
			const finder = finders[index];
			const withMetadata =
				finder === null || finder === undefined
					? entry
					: { ...entry, finder: { ...finder, createdAt: finder.createdAt ?? entry.createdAt ?? null } };
			return withIcon(withMetadata, icons);
		});
	}

	async function enrichEntries(
		targets: readonly FsEnrichmentTarget[],
		thumbnails: boolean,
	): Promise<readonly FsEntryEnrichment[]> {
		const base = targets.map((target) => ({
			name: basename(target.path),
			path: target.path,
			kind: target.kind,
			ext: target.ext,
			size: null,
			modifiedAt: target.modifiedAt,
			...(target.createdAt === undefined ? {} : { createdAt: target.createdAt }),
			isSymlink: false,
			osKind: null,
			iconUrl: null,
		} satisfies FsEntry));
		const enriched = await annotateEntries(base, thumbnails);
		return enriched.map((entry) => ({
			path: entry.path,
			modifiedAt: entry.modifiedAt,
			osKind: entry.osKind,
			iconUrl: entry.iconUrl,
			...(entry.finder === undefined ? {} : { finder: entry.finder }),
		}));
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

	async function search(query: string): Promise<readonly FsSearchResult[]> {
		const needle = query.trim().toLowerCase();
		if (needle.length === 0) return [];
		const results: FsSearchResult[] = [];
		for (const location of await locations()) {
			// Recents is virtual and whole disks are too large to walk; only scanned places count.
			if (!location.available || !location.scanned) continue;
			await walkForSearch(location.path, 0, { needle, location: location.name, results });
			if (results.length >= SEARCH_MAX_RESULTS) break;
		}
		return results;
	}

	/** One undo step of the most recent copy/move transfer, consumed by ⌘Z. */
	interface FsUndoStep {
		readonly kind: "copy" | "move";
		/** The row the transfer created (copy) or now occupies (move). */
		readonly path: string;
		/** The folder a move took the row from; "" for copy steps. */
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
	 * Undo the most recent recorded transfer (⌘Z). A copy step deletes the row
	 * the copy created; a move step puts the row back into the folder it came
	 * from, with Finder-style collision naming when the original name was
	 * retaken in the meantime. The record is consumed by the call.
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
				if (step.kind === "copy") {
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
				return { path: target, name };
			} catch (error) {
				if (!hasErrorCode(error, "EEXIST")) throw error;
			}
		}
	}

	return {
		enrichEntries,
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
		trash: (paths) => runBatch(paths, (path) => deps.shell.trashItem(path)),
		reveal: async (path) => {
			deps.shell.showItemInFolder(path);
		},
		quickLook: async (path) => {
			await recents.record(path);
		},
		open: async (path) => {
			const message = await deps.shell.openPath(path);
			// Failures surface verbatim — the operator sees the real message.
			if (message !== "") {
				throw new Error(message);
			}
			await recents.record(path);
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
