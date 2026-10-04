import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { AutoRAGLite, loadMirrorIndex, minSyncDocumentPath, minSyncWorkspaceRoot } from "@autorag/librarian";
import { readRawConfigObject, resolveConfigPath, resolveConfigReadOnly, writeConfigObject } from "@autorag/librarian/core";
import { applyAppIndexing } from "./app-indexing";
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
function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function isUnder(path: string, root: string): boolean {
	return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

export function createIndexStatusService(deps: IndexStatusServiceDeps): IndexStatusService {
	const input = { flags: {}, env: deps.env, cwd: deps.cwd };
	let refreshTail: Promise<void> = Promise.resolve();

	function configuredExclusions(raw: Record<string, unknown>, workspacePath: string): string[] {
		if (!Array.isArray(raw.excludePaths)) return [];
		return raw.excludePaths
			.filter((value): value is string => typeof value === "string" && value.length > 0)
			.map((value) => canonical(isAbsolute(value) ? value : resolve(workspacePath, value)));
	}

	function snapshot(paths: readonly string[]): IndexStatus[] {
		const raw = readRawConfigObject(resolveConfigPath(input).configPath);
		const config = applyAppIndexing(resolveConfigReadOnly(input), raw);
		const exclusions = (config.excludePaths ?? []).map(canonical);
		const roots = config.searchPaths.map(canonical);
		const index = loadMirrorIndex(config.workspacePath);
		const entries = new Map(Object.values(index.entries).map((entry) => [entry.sourcePath, entry]));
		const skips = new Map(Object.values(index.skipped ?? {}).map((entry) => [entry.sourcePath, entry]));
		const minSyncRoot =
			config.minSync?.enabled === false ? null : (config.minSync?.workspacePath ?? minSyncWorkspaceRoot(config.workspacePath));
		return paths.map((path): IndexStatus => {
			const real = canonical(path);
			if (!roots.some((root) => isUnder(real, root))) {
				return { path, kind: "outside", excluded: false, toggleable: false, detail: "AutoRAG 검색 경로 밖의 파일" };
			}
			const exclusion = exclusions.find((candidate) => isUnder(real, candidate));
			const excluded = exclusion !== undefined;
			const toggleable = exclusion === undefined || exclusion === real;
			const entry = entries.get(real);
			const staged = entry !== undefined && (minSyncRoot === null || existsSync(minSyncDocumentPath(minSyncRoot, entry.virtualPath)));
			if (excluded) {
				return entry === undefined
					? { path, kind: "excluded", excluded, toggleable, detail: toggleable ? "인덱싱에서 제외됨" : "상위 폴더가 인덱싱에서 제외됨" }
					: { path, kind: "pending", excluded, toggleable, detail: "제외 저장됨 · 다음 새로고침에서 인덱스에서 빠짐" };
			}
			if (staged) {
				return { path, kind: "included", excluded, toggleable, detail: "MinSync 인덱스에 포함됨" };
			}
			if (entry !== undefined) {
				return { path, kind: "pending", excluded, toggleable, detail: "파싱됨 · MinSync 반영 대기" };
			}
			const skip = skips.get(real);
			// `user-excluded` arrives with Marker-Inc-Korea/AutoRAG#1750; a just-cleared exclusion is pending, not skipped.
			const skipReason: string | undefined = skip?.reason;
			if (skipReason !== undefined && skipReason !== "user-excluded") {
				return { path, kind: "skipped", excluded, toggleable, detail: `새로고침에서 건너뜀 (${skipReason})` };
			}
			return { path, kind: "pending", excluded, toggleable, detail: "아직 인덱싱되지 않음" };
		});
	}

	/** One refresh at a time; toggles made during a run coalesce into the next one. */
	function scheduleRefresh(): void {
		refreshTail = refreshTail.then(async () => {
			try {
				if (deps.refresh !== undefined) await deps.refresh();
				else {
					const raw = readRawConfigObject(resolveConfigPath(input).configPath);
					await new AutoRAGLite(applyAppIndexing(resolveConfigReadOnly(input), raw)).refresh(false, { methods: ["parsed", "minsync"] });
				}
				deps.onRefreshed(null);
			} catch (error) {
				deps.onRefreshed(error instanceof Error ? error.message : String(error));
			}
		});
	}

	return {
		indexStatus: async (paths) => snapshot(paths),
		setIndexExcluded: async (path, excluded) => {
			const real = canonical(path);
			const configPath = resolveConfigPath(input).configPath;
			const raw = readRawConfigObject(configPath);
			const current = configuredExclusions(raw, resolveConfigReadOnly(input).workspacePath);
			const next = excluded
				? [...new Set([...current, real])]
				: current.filter((candidate) => candidate !== real);
			if (next.length === 0) delete raw.excludePaths;
			else raw.excludePaths = next;
			writeConfigObject(configPath, raw);
			scheduleRefresh();
			const [status] = snapshot([path]);
			if (status === undefined) throw new Error(`No index status for ${path}`);
			return status;
		},
	};
}
