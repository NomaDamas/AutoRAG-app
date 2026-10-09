import type { Dir } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ParserRegistry } from "@autorag/librarian";
import type { FolderScan } from "../shared/onboarding-contract";
import { DEFAULT_CODE_FOLDER_NAMES } from "../shared/settings-contract";

/**
 * The folder pre-scan behind the folders step. It walks each candidate the same
 * way the parsed refresh will (skipping code/dependency dirs, unsupported
 * extensions, and oversize sources) so the "N개 · X GB · 약 M분" the user sees
 * before committing matches what the first index actually processes.
 *
 * The walk is asynchronous and cancellable — a home folder can hold hundreds of
 * thousands of entries, and it must never block the Electron main thread that
 * every IPC and window event shares.
 */

/**
 * Directories the walk never descends into. The first block duplicates the
 * librarian's parsed-refresh skip set (it is not a public export); the rest are
 * the app's own code/dependency dirs, so the count never includes node_modules
 * or build output the index will exclude anyway.
 */
export const SCAN_SKIP_DIR_NAMES: Readonly<Record<string, true>> = {
	".autorag": true,
	".git": true,
	".jikji": true,
	".cache": true,
	".venv": true,
	"__pycache__": true,
	node_modules: true,
	dist: true,
	build: true,
	target: true,
	".Trash": true,
	".Spotlight-V100": true,
	".DocumentRevisions-V100": true,
	".fseventsd": true,
	CacheStorage: true,
	"Service Worker": true,
	"Code Cache": true,
	GPUCache: true,
	GrShaderCache: true,
	ShaderCache: true,
	...Object.fromEntries(DEFAULT_CODE_FOLDER_NAMES.map((name) => [name, true as const])),
};

/** Supported extensions (lower-case, with the leading dot) from a parser registry. */
export function supportedExtensionsFromRegistry(registry: ParserRegistry): Set<string> {
	const extensions = new Set<string>();
	for (const parser of registry.list()) {
		for (const extension of parser.extensions) extensions.add(extension.toLowerCase());
	}
	return extensions;
}

export interface FolderScanOptions {
	/** Lower-case extensions with the leading dot; a file with none is not corpus. */
	readonly supportedExtensions: ReadonlySet<string>;
	readonly skipDirNames?: Readonly<Record<string, true>>;
	/** Sources larger than this are not parsed by the refresh either. */
	readonly maxSourceBytes: number;
	/** Bound the walk so a giant tree cannot run unbounded. */
	readonly maxEntries?: number;
	/** How often running totals are pushed to the renderer. */
	readonly throttleMs?: number;
	/** Absolute paths of macOS/Windows cloud placeholders; excluded from `files`. */
	readonly datalessPaths?: ReadonlySet<string>;
	readonly now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 200_000;

/** Walk one folder and report supported, size-capped file totals. */
export async function scanFolder(
	root: string,
	options: FolderScanOptions,
	emit: (scan: FolderScan) => void,
	signal: AbortSignal,
): Promise<FolderScan> {
	const skip = options.skipDirNames ?? SCAN_SKIP_DIR_NAMES;
	const throttleMs = options.throttleMs ?? 150;
	const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
	const now = options.now ?? Date.now;
	const dataless = options.datalessPaths;
	let files = 0;
	let bytes = 0;
	let onlineOnly = 0;
	let scanned = 0;
	let lastEmit = 0;
	let error: string | null = null;

	const snapshot = (done: boolean): FolderScan => ({ path: root, files, bytes, onlineOnly, done, error });
	const emitThrottled = (): void => {
		const at = now();
		if (at - lastEmit < throttleMs) return;
		lastEmit = at;
		emit(snapshot(false));
	};

	const queue: string[] = [root];
	try {
		for (let head = 0; head < queue.length; head += 1) {
			if (signal.aborted) break;
			const dir = queue[head] as string;
			let handle: Dir;
			try {
				handle = await opendir(dir);
			} catch {
				continue;
			}
			for await (const entry of handle) {
				if (signal.aborted || scanned >= maxEntries) break;
				scanned += 1;
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					// Matches the refresh, which excludes every dot-folder (app-indexing).
					if (entry.name.startsWith(".") || skip[entry.name.toLowerCase()] === true) continue;
					queue.push(full);
					continue;
				}
				if (!entry.isFile()) continue;
				if (!options.supportedExtensions.has(extname(entry.name).toLowerCase())) continue;
				let size: number;
				try {
					size = (await stat(full)).size;
				} catch {
					continue;
				}
				if (size > options.maxSourceBytes) continue;
				if (dataless?.has(full) === true) onlineOnly += 1;
				else {
					files += 1;
					bytes += size;
				}
				emitThrottled();
			}
		}
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
	}
	if (signal.aborted) error = error ?? null;
	const final = snapshot(true);
	emit(final);
	return final;
}

export interface FolderScanCoordinatorDeps {
	readonly options: FolderScanOptions;
	/** macOS: absolute dataless-placeholder paths under a root (one batched `find`). */
	readonly listDatalessPaths?: (root: string) => Promise<ReadonlySet<string>>;
	readonly emit: (scan: FolderScan) => void;
}

export interface FolderScanCoordinator {
	/** Start (or re-emit) a scan per path; totals stream through `emit`. */
	start(paths: readonly string[]): Promise<void>;
	/** Re-emit a cached scan already finished; nothing when it never ran. */
	cached(path: string): FolderScan | undefined;
	/** Sum of the given folders' finished scans, for the indexing ETA denominator. */
	totalFiles(paths: readonly string[]): number;
	cancelAll(): void;
	dispose(): void;
}

export function createFolderScanCoordinator(deps: FolderScanCoordinatorDeps): FolderScanCoordinator {
	const results = new Map<string, FolderScan>();
	const running = new Map<string, AbortController>();

	async function run(path: string): Promise<void> {
		const controller = new AbortController();
		running.set(path, controller);
		try {
			const datalessPaths = deps.listDatalessPaths === undefined ? undefined : await deps.listDatalessPaths(path);
			await scanFolder(
				path,
				datalessPaths === undefined ? deps.options : { ...deps.options, datalessPaths },
				(scan) => {
					if (scan.done) results.set(path, scan);
					deps.emit(scan);
				},
				controller.signal,
			);
		} catch (error) {
			console.error(`[onboarding] folder scan failed for ${path}:`, error);
		} finally {
			running.delete(path);
		}
	}

	return {
		start: async (paths) => {
			for (const path of paths) {
				const cached = results.get(path);
				if (cached !== undefined) {
					deps.emit(cached);
					continue;
				}
				if (running.has(path)) continue;
				void run(path);
			}
		},
		cached: (path) => results.get(path),
		totalFiles: (paths) => {
			let total = 0;
			for (const path of paths) total += results.get(path)?.files ?? 0;
			return total;
		},
		cancelAll: () => {
			for (const controller of running.values()) controller.abort();
			running.clear();
		},
		dispose: () => {
			for (const controller of running.values()) controller.abort();
			running.clear();
			results.clear();
		},
	};
}
