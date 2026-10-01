import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
	AutoRAGLite,
	loadMirrorIndex,
	minSyncDocumentPath,
	minSyncWorkspaceRoot,
} from "@autorag/librarian";
import {
	readRawConfigObject,
	resolveConfigPath,
	resolveConfigReadOnly,
	writeConfigObject,
} from "@autorag/librarian/core";
import type { IndexStatus } from "../shared/index-contract";

function isUnder(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}/`);
}

function configuredExclusions(
	raw: Record<string, unknown>,
	workspacePath: string,
): string[] {
	if (!Array.isArray(raw.excludePaths)) return [];
	return raw.excludePaths
		.filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		)
		.map((value) =>
			isAbsolute(value) ? resolve(value) : resolve(workspacePath, value),
		);
}

export interface IndexStatusService {
	indexStatus(paths: readonly string[]): Promise<readonly IndexStatus[]>;
	setIndexExcluded(path: string, excluded: boolean): Promise<IndexStatus>;
}

export interface IndexStatusServiceDeps {
	readonly env: NodeJS.ProcessEnv;
	readonly cwd: string;
}

export function createIndexStatusService(
	deps: IndexStatusServiceDeps,
): IndexStatusService {
	const configPath = (): string =>
		resolveConfigPath({ flags: {}, env: deps.env, cwd: deps.cwd }).configPath;
	let refreshTail = Promise.resolve();

	function snapshot(paths: readonly string[]): readonly IndexStatus[] {
		const config = resolveConfigReadOnly({
			flags: {},
			env: deps.env,
			cwd: deps.cwd,
		});
		const raw = readRawConfigObject(configPath());
		const exclusions = configuredExclusions(raw, config.workspacePath);
		const index = loadMirrorIndex(config.workspacePath);
		const bySource = new Map(
			Object.values(index.entries).map((entry) => [entry.sourcePath, entry]),
		);
		const skippedBySource = new Map(
			Object.values(index.skipped ?? {}).map((entry) => [
				entry.sourcePath,
				entry,
			]),
		);
		const minSyncRoot =
			config.minSync?.enabled === false
				? undefined
				: (config.minSync?.workspacePath ??
					minSyncWorkspaceRoot(config.workspacePath));
		return paths.map((path): IndexStatus => {
			const absolute = resolve(path);
			const excluded = exclusions.find((candidate) =>
				isUnder(absolute, candidate),
			);
			const entry = bySource.get(absolute);
			const skipped = skippedBySource.get(absolute);
			if (excluded !== undefined) {
				return {
					path,
					kind: "excluded",
					detail:
						entry === undefined
							? "Excluded from AutoRAG indexing"
							: "Excluded; awaiting refresh",
					toggleable: excluded === absolute,
				};
			}
			if (entry !== undefined) {
				const staged =
					minSyncRoot === undefined ||
					existsSync(minSyncDocumentPath(minSyncRoot, entry.virtualPath));
				return {
					path,
					kind: staged ? "included" : "pending",
					detail: staged
						? "Included in AutoRAG MinSync"
						: "Parsed; awaiting MinSync staging",
					toggleable: true,
				};
			}
			if (skipped !== undefined) {
				return {
					path,
					kind: "skipped",
					detail: `Skipped: ${skipped.reason}`,
					toggleable: true,
				};
			}
			return {
				path,
				kind: "pending",
				detail: "Not indexed yet",
				toggleable: true,
			};
		});
	}

	async function refresh(): Promise<void> {
		const run = refreshTail.then(async () => {
			const config = resolveConfigReadOnly({
				flags: {},
				env: deps.env,
				cwd: deps.cwd,
			});
			await new AutoRAGLite(config).refresh(false, {
				methods: ["parsed", "minsync"],
			});
		});
		refreshTail = run.catch(() => undefined);
		await run;
	}

	return {
		indexStatus: async (paths) => snapshot(paths),
		setIndexExcluded: async (path, excluded) => {
			const absolute = resolve(path);
			const configFile = configPath();
			const raw = readRawConfigObject(configFile);
			const config = resolveConfigReadOnly({
				flags: {},
				env: deps.env,
				cwd: deps.cwd,
			});
			const current = configuredExclusions(raw, config.workspacePath);
			const next = excluded
				? [...new Set([...current, absolute])]
				: current.filter((candidate) => candidate !== absolute);
			if (next.length === 0) delete raw.excludePaths;
			else raw.excludePaths = next;
			writeConfigObject(configFile, raw);
			await refresh();
			const result = snapshot([absolute])[0];
			if (result === undefined)
				throw new Error(`Index status unavailable for ${absolute}`);
			return result;
		},
	};
}
