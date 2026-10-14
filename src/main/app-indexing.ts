import type { Dirent } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { CliConfig } from "@autorag/librarian/core";
import { DEFAULT_CODE_FOLDER_NAMES, isJsonObject } from "../shared/settings-contract";
import { embedderKind, learnedBatchSize } from "./embedding-batch";
import { withIndexingPoliciesApplied } from "./indexing-policy";

/**
 * App-owned indexing policy: automatically omit code/dependency directories
 * (node_modules, .git, build output, virtualenvs, caches) and every dot-folder
 * from each retrieval method the app triggers. Dot-folders are always omitted,
 * with no setting; the code-folder opt-out and folder list live in the user
 * config so they survive across surfaces, and the librarian itself never sees
 * these keys. The librarian only skips a short built-in list of directory names
 * and matches excluded paths by exact directory, so the app finds the
 * directories itself and hands them over as `excludePaths`.
 */

export interface AppIndexingSettings {
	readonly excludeCodeFolders: boolean;
	readonly codeFolderNames: readonly string[];
}

/** Read `appIndexing` from a raw config object, applying defaults. */
export function readAppIndexing(raw: Record<string, unknown>): AppIndexingSettings {
	const block = isJsonObject(raw.appIndexing) ? raw.appIndexing : {};
	const excludeCodeFolders = typeof block.excludeCodeFolders === "boolean" ? block.excludeCodeFolders : true;
	const names =
		Array.isArray(block.codeFolderNames) && block.codeFolderNames.every((name) => typeof name === "string" && name.length > 0)
			? (block.codeFolderNames as string[])
			: [...DEFAULT_CODE_FOLDER_NAMES];
	return { excludeCodeFolders, codeFolderNames: names };
}

/**
 * Runaway guards for the discovery walk, not tuning knobs. The librarian's own
 * refresh walks every file with no limit, so an exclusion list built from a
 * truncated walk silently lets everything past the cut through: a 20k-entry cap
 * found 87 of the 284 dot-folders under one real Downloads folder.
 */
const MAX_SCANNED_ENTRIES = 2_000_000;
const MAX_DEPTH = 64;

/** How long a finished walk is reused by callers that are not a refresh (every search and index badge asks). */
const DISCOVERY_TTL_MS = 5 * 60_000;

/**
 * Collect directories to exclude; never follows symlinks and guards cycles.
 * Asynchronous: the walk reads every directory entry, which must never block the
 * Electron main thread (every IPC and window event shares it).
 */
async function discoverExcludedDirectories(root: string, names: ReadonlySet<string>, result: Set<string>): Promise<void> {
	const queue: Array<{ readonly dir: string; readonly depth: number }> = [{ dir: root, depth: 0 }];
	const visitedRealPaths = new Set<string>();
	let scanned = 0;
	for (let head = 0; head < queue.length && scanned < MAX_SCANNED_ENTRIES; head += 1) {
		const current = queue[head];
		if (current === undefined) break;
		let entries: Dirent[];
		try {
			entries = await readdir(current.dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (scanned >= MAX_SCANNED_ENTRIES) break;
			scanned += 1;
			if (!entry.isDirectory()) continue;
			const child = join(current.dir, entry.name);
			if (names.has(entry.name.toLowerCase()) || entry.name.startsWith(".")) {
				result.add(child);
				continue;
			}
			if (current.depth >= MAX_DEPTH) continue;
			let real: string;
			try {
				real = await realpath(child);
			} catch {
				continue;
			}
			if (visitedRealPaths.has(real)) continue;
			visitedRealPaths.add(real);
			queue.push({ dir: child, depth: current.depth + 1 });
		}
	}
}

const discoveryCache = new Map<string, { readonly at: number; readonly found: Promise<readonly string[]> }>();

/** Drop every remembered walk (tests, and anything that changed the folder tree on purpose). */
export function clearDiscoveryCache(): void {
	discoveryCache.clear();
}

/**
 * Directories to exclude under `roots`. A refresh walks fresh; every other
 * caller reuses a recent walk of the same roots and rules, and concurrent
 * callers share the one walk in flight.
 */
function discoverExcluded(roots: readonly string[], names: ReadonlySet<string>, fresh: boolean): Promise<readonly string[]> {
	const key = JSON.stringify([[...roots].sort(), [...names].sort()]);
	const cached = discoveryCache.get(key);
	if (!fresh && cached !== undefined && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.found;
	const found = (async (): Promise<readonly string[]> => {
		const result = new Set<string>();
		for (const root of roots) await discoverExcludedDirectories(root, names, result);
		return [...result];
	})();
	discoveryCache.set(key, { at: Date.now(), found });
	found.catch(() => {
		if (discoveryCache.get(key)?.found === found) discoveryCache.delete(key);
	});
	return found;
}

/** Where automatic exclusions can and cannot be forwarded. */
export interface AppIndexingCapabilities {
	readonly parsed: boolean;
	readonly minsync: boolean;
	/** Jikji already skips dot-folders by default (verified: it only descends into them with `--include-hidden`). */
	readonly jikji: boolean;
	/** Everything stores only `.autorag` excludes; arbitrary folders are not forwarded. */
	readonly everything: boolean;
	/** FSearch stores only `.autorag` excludes; arbitrary folders are not forwarded. */
	readonly fsearch: boolean;
}

export const APP_INDEXING_CAPABILITIES: AppIndexingCapabilities = {
	parsed: true,
	minsync: true,
	jikji: true,
	everything: false,
	fsearch: false,
};

export interface ApplyAppIndexingOptions {
	/** Walk the search paths again instead of reusing a recent walk. Refreshes pass true. */
	readonly fresh?: boolean;
}

/**
 * Resolve the config the app actually runs with: parsed/MinSync get absolute
 * `excludePaths`, Jikji gets `--exclude` globs, and the features the app never
 * runs (OCR, Jikji's media index) are pinned off, see `indexing-policy`.
 * Existing exclusion values are kept, so adding this feature never drops a
 * user's earlier exclusions.
 */
export async function applyAppIndexing(
	input: CliConfig,
	raw: Record<string, unknown>,
	options: ApplyAppIndexingOptions = {},
): Promise<CliConfig> {
	const config = withIndexingPoliciesApplied(input);
	const settings = readAppIndexing(raw);
	const excluded = new Set<string>(config.excludePaths ?? []);
	// AutoRAG's own state directories are product output, never corpus.
	for (const root of [...config.searchPaths, config.workspacePath]) excluded.add(join(root, ".autorag"));
	const names = settings.excludeCodeFolders ? settings.codeFolderNames.map((name) => name.toLowerCase()) : [];
	const found = await discoverExcluded(config.searchPaths, new Set(names), options.fresh === true);
	for (const dir of found) excluded.add(dir);
	const excludePaths = [...excluded];

	let jikji = config.jikji;
	if (settings.excludeCodeFolders && jikji !== false && jikji !== undefined) {
		const globs = settings.codeFolderNames.map((name) => `**/${name}/**`);
		const existing = Array.isArray(jikji.exclude) ? jikji.exclude.filter((value): value is string => typeof value === "string") : [];
		jikji = { ...jikji, exclude: [...new Set([...existing, ...globs])] };
	}
	const withExcludes = jikji === undefined ? { ...config, excludePaths } : { ...config, excludePaths, jikji };
	return withLearnedEmbeddingBatch(withExcludes, raw);
}

/**
 * A refresh that once timed out on the embedding gateway learned a smaller batch
 * for this embedder kind (see `embedding-batch`); every later run starts there.
 */
function withLearnedEmbeddingBatch(config: CliConfig, raw: Record<string, unknown>): CliConfig {
	const embedder = config.minSync?.embedder;
	const learned = learnedBatchSize(raw, embedderKind(embedder));
	if (learned === null) return config;
	return { ...config, minSync: { ...config.minSync, embedder: { ...embedder, batchSize: learned } } };
}
