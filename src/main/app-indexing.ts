import type { Dirent } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { CliConfig } from "@autorag/librarian/core";
import { isJsonObject } from "../shared/settings-contract";

/**
 * App-owned indexing policy: automatically omit code/dependency directories
 * (node_modules, .git, build output, virtualenvs, caches) from every retrieval
 * method the app triggers. The user config carries the opt-out and the folder
 * list so it survives across surfaces; the librarian itself never sees these
 * keys.
 */

/** Directories that are almost never corpus, only code/dependency noise. */
export const DEFAULT_CODE_FOLDER_NAMES: readonly string[] = [
	".git",
	"node_modules",
	".venv",
	"venv",
	"target",
	"dist",
	"build",
	"coverage",
	"__pycache__",
];

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

/** Bound the walk so a giant tree cannot run unbounded. */
const MAX_SCANNED_ENTRIES = 20_000;
const MAX_DEPTH = 12;

/**
 * Collect directories whose name is in `names`; never follows symlinks and guards cycles.
 * Asynchronous: the walk reads up to 20k entries, which must never block the
 * Electron main thread (every IPC and window event shares it).
 */
async function discoverNamedDirectories(root: string, names: ReadonlySet<string>, result: Set<string>): Promise<void> {
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
			if (names.has(entry.name.toLowerCase())) {
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

/** Where automatic exclusions can and cannot be forwarded. */
export interface AppIndexingCapabilities {
	readonly parsed: boolean;
	readonly minsync: boolean;
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

/**
 * Resolve the config the app actually runs with: parsed/MinSync get absolute
 * `excludePaths`, Jikji gets `--exclude` globs. Existing exclusion values are
 * kept, so adding this feature never drops a user's earlier exclusions.
 */
export async function applyAppIndexing(config: CliConfig, raw: Record<string, unknown>): Promise<CliConfig> {
	const settings = readAppIndexing(raw);
	const excluded = new Set<string>(config.excludePaths ?? []);
	// AutoRAG's own state directories are product output, never corpus.
	for (const root of [...config.searchPaths, config.workspacePath]) excluded.add(join(root, ".autorag"));
	if (settings.excludeCodeFolders) {
		const nameSet = new Set(settings.codeFolderNames.map((name) => name.toLowerCase()));
		const found = new Set<string>();
		for (const root of config.searchPaths) await discoverNamedDirectories(root, nameSet, found);
		for (const dir of found) excluded.add(dir);
	}
	const excludePaths = [...excluded];

	let jikji = config.jikji;
	if (settings.excludeCodeFolders && jikji !== false && jikji !== undefined) {
		const globs = settings.codeFolderNames.map((name) => `**/${name}/**`);
		const existing = Array.isArray(jikji.exclude) ? jikji.exclude.filter((value): value is string => typeof value === "string") : [];
		jikji = { ...jikji, exclude: [...new Set([...existing, ...globs])] };
	}
	return jikji === undefined ? { ...config, excludePaths } : { ...config, excludePaths, jikji };
}
