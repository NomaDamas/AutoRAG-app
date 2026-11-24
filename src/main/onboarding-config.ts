import { isJsonObject } from "../shared/settings-contract";

/**
 * Writes the first run's choices into the shared AutoRAG config the CLI, TUI,
 * serve, and this app all resolve. Pure over its inputs (a raw config object in,
 * the next one out) so the merge rules — search paths replace, `excludePaths`
 * merge, the workspace path moves off the cwd seed, and keyword-only mode is an
 * explicit switch — are unit-testable without touching disk.
 *
 * The first index is keyword-only: no embedder block is written and
 * `appIndexing.semanticSearch` is set false. Dense embedding stays opt-in in
 * Settings, which writes its own embedder block.
 */

export interface ApplyIndexingConfigInput {
	readonly raw: Record<string, unknown>;
	readonly folders: readonly string[];
	/** Null keeps the existing `workspacePath`; a path replaces it. */
	readonly workspacePath: string | null;
	/** False writes keyword-only mode (`appIndexing.semanticSearch: false`); true removes the switch. Absent leaves it as is. */
	readonly semanticSearch?: boolean;
	/** Folders to leave out; kept after any exclusions the config already has. */
	readonly excludePaths?: readonly string[];
}

export function applyIndexingConfig(input: ApplyIndexingConfigInput): Record<string, unknown> {
	const raw = structuredClone(input.raw);
	raw.searchPaths = [...input.folders];
	if (input.excludePaths !== undefined && input.excludePaths.length > 0) {
		const existing = Array.isArray(raw.excludePaths) ? raw.excludePaths.filter((value): value is string => typeof value === "string") : [];
		raw.excludePaths = [...new Set([...existing, ...input.excludePaths])];
	}
	if (input.workspacePath !== null) raw.workspacePath = input.workspacePath;
	if (input.semanticSearch !== undefined) {
		const { semanticSearch: _previous, ...rest } = isJsonObject(raw.appIndexing) ? raw.appIndexing : {};
		const appIndexing = input.semanticSearch ? rest : { ...rest, semanticSearch: false };
		if (Object.keys(appIndexing).length > 0) raw.appIndexing = appIndexing;
		else delete raw.appIndexing;
	}
	return raw;
}
