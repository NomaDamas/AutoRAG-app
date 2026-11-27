import { access, lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createDefaultParserRegistry, emptyMirrorIndex, loadMirrorIndex, minSyncDocumentPath, minSyncWorkspaceRoot, parsedMirrorRoot, type DefaultParserRegistryOptions, type ParsedMirrorEntry, type ParsedMirrorIndex } from "@autorag/librarian";
import { readRawConfigObject, resolveConfigPath, resolveConfigReadOnly, writeConfigObject } from "@autorag/librarian/core";
import { applyAppIndexing } from "./app-indexing";
import { refreshAutoragIndex } from "./index-refresh";
import { t } from "../shared/i18n/core";
import type { IndexStatus } from "../shared/index-contract";
import type { IndexMap } from "../shared/index-map-contract";
import { createExclusionMatcher } from "./path-exclusion";
import { isGlobExclusion } from "../shared/index-scope-edit";
import { buildIndexMap, scanIndexScope, type IndexScopeContext } from "./index-map";

/** Max concurrent filesystem probes inside `snapshot()` so a large folder never floods a single-spindle HDD. */
const SNAPSHOT_CONCURRENCY = 16;

type ParsedMirrorSkipEntry = NonNullable<ParsedMirrorIndex["skipped"]>[string];

interface CachedMirrorState {
	readonly workspacePath: string;
	readonly signature: string;
	readonly entries: ReadonlyMap<string, ParsedMirrorEntry>;
	readonly skips: ReadonlyMap<string, ParsedMirrorSkipEntry>;
}

interface CachedConfigState {
	readonly configPath: string;
	readonly signature: string;
	readonly workspacePath: string;
	readonly roots: readonly string[];
	readonly exclusions: readonly string[];
	readonly minSyncRoot: string;
	readonly indexable: (path: string, name: string) => boolean;
}

/**
 * Cheap disk signature of the MinSync parse stage directory (`.autorag/parsed/stage`).
 * Only a handful of files live here (`snapshot.json`, `journal.jsonl`, `lock`); statting
 * them lets `loadContext()` skip `spawnSync(minsync stage inspect)` and full-Map rebuilds
 * whenever nothing in the stage moved since the last read.
 */
async function stageSignature(workspacePath: string): Promise<string> {
	const stateDir = join(parsedMirrorRoot(workspacePath), "stage");
	let names: string[];
	try {
		names = await readdir(stateDir);
	} catch {
		return "missing";
	}
	names.sort();
	const parts = await Promise.all(
		names.map(async (name) => {
			if (name === "lock") return "lock";
			const info = await stat(join(stateDir, name)).catch(() => null);
			return info === null ? `${name}:-` : `${name}:${info.mtimeMs}:${info.size}`;
		}),
	);
	return parts.join("|");
}

async function fileSignature(filePath: string): Promise<string> {
	const info = await stat(filePath).catch(() => null);
	return info === null ? "missing" : `${info.mtimeMs}:${info.size}`;
}

/** Run `worker` over `items` with at most `concurrency` in flight, preserving input order. */
async function mapBounded<T, R>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (next < items.length) {
			const index = next;
			next += 1;
			results[index] = await worker(items[index]!);
		}
	});
	await Promise.all(runners);
	return results;
}

/**
 * The Finder index badge reads and writes the shared AutoRAG state — the same
 * config and workspace the CLI, TUI, and every agent resolve. Status comes from
 * the parsed mirror index and the MinSync staging tree; a toggle edits
 * `excludePaths` in the config and runs a parsed + MinSync refresh so the
 * exclusion actually leaves (or re-enters) the index.
 */
export interface IndexStatusService {
	indexStatus(paths: readonly string[]): Promise<readonly IndexStatus[]>;
	/** Saves the exclusion and returns at once; `onRefreshed` fires when the index caught up. */
	setIndexExcluded(path: string, excluded: boolean): Promise<IndexStatus>;
	/** Every file and folder under the search roots with what the index holds for it (Settings → 검색 범위 → 인덱싱 지도). */
	indexMap(): Promise<IndexMap>;
}

export interface IndexStatusServiceDeps {
	readonly env: NodeJS.ProcessEnv;
	readonly cwd: string;
	/** Called after each background refresh settles, with its error when it failed. */
	readonly onRefreshed: (error: string | null) => void;
	/** Test seam; production refreshes the real AutoRAGLite indexes. */
	readonly refresh?: () => Promise<void>;
}

/** The mirror records canonical paths (search roots are realpath-pinned); match them. */
function canonical(path: string): Promise<string> {
	return realpath(path).catch(() => resolve(path));
}

/** An exclusion entry as the index compares it: a path is canonical, a glob stays as written (it is not a place). */
function canonicalExclusion(entry: string): Promise<string> {
	return isGlobExclusion(entry) ? Promise.resolve(entry) : canonical(entry);
}

function isUnder(path: string, root: string): boolean {
	return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Jikji's own agent map; the librarian never treats it as a corpus source (mirror/sync.ts). */
const PRODUCT_ARTIFACT_FILE_NAMES = new Set([".jikji_agent_map.md"]);

export function createIndexStatusService(deps: IndexStatusServiceDeps): IndexStatusService {
	const input = { flags: {}, env: deps.env, cwd: deps.cwd };
	let refreshTail: Promise<void> = Promise.resolve();
	let cachedConfig: CachedConfigState | null = null;
	let cachedMirror: CachedMirrorState | null = null;
	let mirrorInFlight: Promise<CachedMirrorState> | null = null;

	function invalidateCaches(): void {
		cachedConfig = null;
		cachedMirror = null;
	}

	function configuredExclusions(raw: Record<string, unknown>, workspacePath: string): Promise<string[]> {
		if (!Array.isArray(raw.excludePaths)) return Promise.resolve([]);
		return Promise.all(
			raw.excludePaths
				.filter((value): value is string => typeof value === "string" && value.length > 0)
				.map((value) => (isGlobExclusion(value) ? Promise.resolve(value) : canonical(isAbsolute(value) ? value : resolve(workspacePath, value)))),
		);
	}

	async function loadConfigState(): Promise<CachedConfigState> {
		const configPath = resolveConfigPath(input).configPath;
		const signature = await fileSignature(configPath);
		if (cachedConfig !== null && cachedConfig.configPath === configPath && cachedConfig.signature === signature) {
			return cachedConfig;
		}
		const raw = readRawConfigObject(configPath);
		const config = await applyAppIndexing(resolveConfigReadOnly(input), raw);
		const [exclusions, roots] = await Promise.all([
			Promise.all((config.excludePaths ?? []).map(canonicalExclusion)),
			Promise.all(config.searchPaths.map(canonical)),
		]);
		const registry = createDefaultParserRegistry((config.parserOptions ?? {}) as DefaultParserRegistryOptions);
		cachedConfig = {
			configPath,
			signature,
			workspacePath: config.workspacePath,
			roots,
			exclusions,
			minSyncRoot: config.minSync?.workspacePath ?? minSyncWorkspaceRoot(config.workspacePath),
			indexable: (path, name) => registry.getForVirtualPath(path) !== undefined && !PRODUCT_ARTIFACT_FILE_NAMES.has(name),
		};
		return cachedConfig;
	}

	async function loadMirrorState(workspacePath: string): Promise<CachedMirrorState> {
		const signature = await stageSignature(workspacePath);
		if (cachedMirror !== null && cachedMirror.workspacePath === workspacePath && cachedMirror.signature === signature) {
			return cachedMirror;
		}
		if (mirrorInFlight !== null) {
			const settled = await mirrorInFlight;
			if (settled.workspacePath === workspacePath && settled.signature === signature) return settled;
		}
		const pending = (async (): Promise<CachedMirrorState> => {
			let index = emptyMirrorIndex();
			if (signature !== "missing") {
				try {
					index = loadMirrorIndex(workspacePath);
				} catch {
					// Missing or older MinSync binary: fall back to empty mirror state so Finder badges never throw.
				}
			}
			const next: CachedMirrorState = {
				workspacePath,
				signature,
				entries: new Map(Object.values(index.entries).map((entry) => [entry.sourcePath, entry])),
				skips: new Map(Object.values(index.skipped ?? {}).map((entry) => [entry.sourcePath, entry])),
			};
			cachedMirror = next;
			return next;
		})();
		mirrorInFlight = pending;
		try {
			return await pending;
		} finally {
			if (mirrorInFlight === pending) mirrorInFlight = null;
		}
	}

	async function loadContext(): Promise<IndexScopeContext> {
		const cfg = await loadConfigState();
		const mirror = await loadMirrorState(cfg.workspacePath);
		return {
			roots: cfg.roots,
			exclusions: cfg.exclusions,
			entries: mirror.entries,
			skips: mirror.skips,
			minSyncRoot: cfg.minSyncRoot,
			indexable: cfg.indexable,
		};
	}

	async function snapshot(paths: readonly string[]): Promise<IndexStatus[]> {
		if (paths.length === 0) return [];
		const { roots, exclusions, entries, skips, minSyncRoot, indexable } = await loadContext();
		const exclusionMatcher = createExclusionMatcher(exclusions);
		// Resolve each unique parent directory once instead of running `realpath` per file.
		// Non-symlink children inherit `join(realParent, basename)` directly; only symlinks call `realpath`.
		const realDirs = new Map<string, string>();
		const uniqueDirs = [...new Set(paths.map((filePath) => dirname(filePath)))];
		await mapBounded(uniqueDirs, SNAPSHOT_CONCURRENCY, async (dir) => {
			realDirs.set(dir, await canonical(dir));
		});
		const canonicalFile = async (filePath: string): Promise<string> => {
			const parent = realDirs.get(dirname(filePath));
			if (parent === undefined) return canonical(filePath);
			const info = await lstat(filePath).catch(() => null);
			if (info === null || info.isSymbolicLink()) return canonical(filePath);
			return join(parent, basename(filePath));
		};
		return mapBounded(paths, SNAPSHOT_CONCURRENCY, async (path): Promise<IndexStatus> => {
			const real = await canonicalFile(path);
			if (!roots.some((root) => isUnder(real, root))) {
				return { path, kind: "outside", excluded: false, toggleable: false, detail: t("main.indexStatus.outside") };
			}
			const exclusion = exclusionMatcher.find(real);
			const excluded = exclusion !== null;
			const toggleable = exclusion === null || (exclusion.kind === "path" && exclusion.entry === real);
			const entry = entries.get(real);
			// Both modes stage parsed files into MinSync (keyword-only as a sparse-only index): a file is in the index once staged.
			const staged = entry !== undefined && (await access(minSyncDocumentPath(minSyncRoot, entry.virtualPath)).then(() => true, () => false));
			if (excluded) {
				return entry === undefined
					? {
							path,
							kind: "excluded",
							excluded,
							toggleable,
							detail: exclusion?.kind === "glob" ? t("main.indexStatus.patternExcluded", { pattern: exclusion.entry }) : toggleable ? t("main.indexStatus.excluded") : t("main.indexStatus.parentExcluded"),
						}
					: { path, kind: "pending", excluded, toggleable, detail: t("main.indexStatus.excludedPending") };
			}
			if (!indexable(real, basename(real))) {
				return { path, kind: "unsupported", excluded, toggleable: false, detail: t("main.indexStatus.unsupported") };
			}
			if (staged) {
				return { path, kind: "included", excluded, toggleable, detail: t("main.indexStatus.included") };
			}
			if (entry !== undefined) {
				return { path, kind: "pending", excluded, toggleable, detail: t("main.indexStatus.parsedPending") };
			}
			const skip = skips.get(real);
			// `user-excluded` arrives with Marker-Inc-Korea/AutoRAG#1750; a just-cleared exclusion is pending, not skipped.
			const skipReason: string | undefined = skip?.reason;
			if (skipReason !== undefined && skipReason !== "user-excluded") {
				return { path, kind: "skipped", excluded, toggleable: false, detail: t("main.indexStatus.skipped", { reason: skipReason }) };
			}
			return { path, kind: "pending", excluded, toggleable, detail: t("main.indexStatus.notIndexed") };
		});
	}

	/** One refresh at a time; toggles made during a run coalesce into the next one. */
	function scheduleRefresh(): void {
		refreshTail = refreshTail.then(async () => {
			try {
				if (deps.refresh !== undefined) {
					await deps.refresh();
					invalidateCaches();
					deps.onRefreshed(null);
				} else {
					// The same guarded path as Settings and the background job: root check, stall watchdog, learned batch size.
					const outcome = await refreshAutoragIndex({ env: deps.env, cwd: deps.cwd });
					invalidateCaches();
					deps.onRefreshed(outcome.ok ? null : outcome.error);
				}
			} catch (error) {
				invalidateCaches();
				deps.onRefreshed(error instanceof Error ? error.message : String(error));
			}
		});
	}

	return {
		indexStatus: (paths) => snapshot(paths),
		indexMap: async () => buildIndexMap(await scanIndexScope(await loadContext())),
		setIndexExcluded: async (path, excluded) => {
			const real = await canonical(path);
			const configPath = resolveConfigPath(input).configPath;
			const raw = readRawConfigObject(configPath);
			const current = await configuredExclusions(raw, resolveConfigReadOnly(input).workspacePath);
			const next = excluded
				? [...new Set([...current, real])]
				: current.filter((candidate) => candidate !== real);
			if (next.length === 0) delete raw.excludePaths;
			else raw.excludePaths = next;
			writeConfigObject(configPath, raw);
			invalidateCaches();
			scheduleRefresh();
			const [status] = await snapshot([path]);
			if (status === undefined) throw new Error(`No index status for ${path}`);
			return status;
		},
	};
}
