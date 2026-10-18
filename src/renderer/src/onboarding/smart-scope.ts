/**
 * The folders step's smart-indexing state: which AI proposals count, what they
 * save, what the first index is told, and where a run stands. Pure over the
 * draft's `smartScope`, so the screen, the saved draft and the indexing request
 * all read the same answer.
 *
 * A proposal belongs to the selected folder it lies under (`root`); once the
 * user unselects that folder its proposals neither show nor apply.
 */

import type { SmartExclusion, SmartIndexingEvent } from "../../../shared/smart-indexing-contract";

export function visibleScope(scope: readonly SmartExclusion[] | undefined, selectedRoots: readonly string[]): readonly SmartExclusion[] {
	return (scope ?? []).filter((item) => selectedRoots.includes(item.root));
}

export interface ExcludedTotals {
	readonly folders: number;
	readonly files: number;
	readonly bytes: number;
}

export function excludedTotals(scope: readonly SmartExclusion[] | undefined, selectedRoots: readonly string[]): ExcludedTotals {
	let folders = 0;
	let files = 0;
	let bytes = 0;
	for (const item of visibleScope(scope, selectedRoots)) {
		if (!item.excluded) continue;
		folders += 1;
		files += item.files;
		bytes += item.bytes;
	}
	return { folders, files, bytes };
}

/** What `startIndexing` carries: the folders to leave out and the files the pre-scans counted in them. */
export function indexingExclusions(
	scope: readonly SmartExclusion[] | undefined,
	selectedRoots: readonly string[],
): { readonly excludePaths: readonly string[]; readonly excludedFiles: number } {
	const excluded = visibleScope(scope, selectedRoots).filter((item) => item.excluded);
	return { excludePaths: excluded.map((item) => item.path), excludedFiles: excluded.reduce((sum, item) => sum + item.files, 0) };
}

export function setScopeExcluded(scope: readonly SmartExclusion[], path: string, excluded: boolean): readonly SmartExclusion[] {
	return scope.map((item) => (item.path === path ? { ...item, excluded } : item));
}

/** Where the analysis stands; its proposals live in the draft, not here. */
export type SmartRun =
	| { readonly status: "idle" }
	| { readonly status: "running"; readonly runId: string; /** The folder or file the agent is looking at, once it said. */ readonly current: string | null }
	| { readonly status: "done" }
	| { readonly status: "error"; readonly message: string };

export const initialSmartRun: SmartRun = { status: "idle" };

/** Applies one main-process event; events of another run, or arriving with no run going, change nothing. */
export function reduceSmartRun(state: SmartRun, event: SmartIndexingEvent): SmartRun {
	if (state.status !== "running" || event.runId !== state.runId) return state;
	switch (event.type) {
		case "exploring":
			return { status: "running", runId: state.runId, current: event.path };
		case "result":
			return { status: "done" };
		case "error":
			return { status: "error", message: event.message };
		case "cancelled":
			return initialSmartRun;
	}
}
