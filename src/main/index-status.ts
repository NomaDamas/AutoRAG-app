import { access, realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { AutoRAGLite, createDefaultParserRegistry, loadMirrorIndex, minSyncDocumentPath, minSyncWorkspaceRoot, type DefaultParserRegistryOptions } from "@autorag/librarian";
import { readRawConfigObject, resolveConfigPath, resolveConfigReadOnly, writeConfigObject } from "@autorag/librarian/core";
import { applyAppIndexing } from "./app-indexing";
import { t } from "../shared/i18n/core";
import type { IndexStatus } from "../shared/index-contract";

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

function isUnder(path: string, root: string): boolean {
	return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Jikji's own agent map; the librarian never treats it as a corpus source (mirror/sync.ts). */
const PRODUCT_ARTIFACT_FILE_NAMES = new Set([".jikji_agent_map.md"]);

export function createIndexStatusService(deps: IndexStatusServiceDeps): IndexStatusService {
	const input = { flags: {}, env: deps.env, cwd: deps.cwd };
	let refreshTail: Promise<void> = Promise.resolve();

	function configuredExclusions(raw: Record<string, unknown>, workspacePath: string): Promise<string[]> {
		if (!Array.isArray(raw.excludePaths)) return Promise.resolve([]);
		return Promise.all(
			raw.excludePaths
				.filter((value): value is string => typeof value === "string" && value.length > 0)
				.map((value) => canonical(isAbsolute(value) ? value : resolve(workspacePath, value))),
		);
	}

	async function snapshot(paths: readonly string[]): Promise<IndexStatus[]> {
		const raw = readRawConfigObject(resolveConfigPath(input).configPath);
		const config = await applyAppIndexing(resolveConfigReadOnly(input), raw);
		const [exclusions, roots] = await Promise.all([
			Promise.all((config.excludePaths ?? []).map(canonical)),
			Promise.all(config.searchPaths.map(canonical)),
		]);
		const index = loadMirrorIndex(config.workspacePath);
		const registry = createDefaultParserRegistry((config.parserOptions ?? {}) as DefaultParserRegistryOptions);
		const entries = new Map(Object.values(index.entries).map((entry) => [entry.sourcePath, entry]));
		const skips = new Map(Object.values(index.skipped ?? {}).map((entry) => [entry.sourcePath, entry]));
		const minSyncRoot = config.minSync?.workspacePath ?? minSyncWorkspaceRoot(config.workspacePath);
		return Promise.all(paths.map(async (path): Promise<IndexStatus> => {
			const real = await canonical(path);
			if (!roots.some((root) => isUnder(real, root))) {
				return { path, kind: "outside", excluded: false, toggleable: false, detail: t("main.indexStatus.outside") };
			}
			const exclusion = exclusions.find((candidate) => isUnder(real, candidate));
			const excluded = exclusion !== undefined;
			const toggleable = exclusion === undefined || exclusion === real;
			const entry = entries.get(real);
			const staged =
				entry !== undefined && (await access(minSyncDocumentPath(minSyncRoot, entry.virtualPath)).then(() => true, () => false));
			if (excluded) {
				return entry === undefined
					? {
							path,
							kind: "excluded",
							excluded,
							toggleable,
							detail: toggleable ? t("main.indexStatus.excluded") : t("main.indexStatus.parentExcluded"),
						}
					: { path, kind: "pending", excluded, toggleable, detail: t("main.indexStatus.excludedPending") };
			}
			if (registry.getForVirtualPath(real) === undefined || PRODUCT_ARTIFACT_FILE_NAMES.has(basename(real))) {
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
		}));
	}

	/** One refresh at a time; toggles made during a run coalesce into the next one. */
	function scheduleRefresh(): void {
		refreshTail = refreshTail.then(async () => {
			try {
				if (deps.refresh !== undefined) await deps.refresh();
				else {
					const raw = readRawConfigObject(resolveConfigPath(input).configPath);
					await new AutoRAGLite(await applyAppIndexing(resolveConfigReadOnly(input), raw)).refresh(false, { methods: ["parsed", "minsync"] });
				}
				deps.onRefreshed(null);
			} catch (error) {
				deps.onRefreshed(error instanceof Error ? error.message : String(error));
			}
		});
	}

	return {
		indexStatus: (paths) => snapshot(paths),
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
			scheduleRefresh();
			const [status] = await snapshot([path]);
			if (status === undefined) throw new Error(`No index status for ${path}`);
			return status;
		},
	};
}
