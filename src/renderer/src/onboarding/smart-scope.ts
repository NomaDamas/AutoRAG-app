/**
 * The folders step's smart-indexing state: which AI proposals count, what they
 * save, what the first index is told, and where a run stands. Pure over the
 * draft's `smartScope`, so the screen, the saved draft and the indexing request
 * all read the same answer.
 *
 * A proposal belongs to the selected folder it lies under (`root`); once the
 * user unselects that folder its proposals neither show nor apply.
 */

import type { EmbedMode } from "../../../shared/onboarding-contract";
import type { SmartExclusion, SmartIndexingEvent } from "../../../shared/smart-indexing-contract";
import { etaMinutes } from "./flow";

/**
 * Whether the scan step has to run the AI: it never has, or a folder selected now was not
 * part of the analysis the proposals came from. Unselecting folders never needs one (their
 * proposals just stop showing); selecting a folder the AI never looked at does.
 */
export function needsAnalysis(
	selected: readonly string[],
	analysed: readonly string[] | undefined,
	scope: readonly SmartExclusion[] | undefined,
): boolean {
	if (scope === undefined || analysed === undefined) return true;
	return selected.some((path) => !analysed.includes(path));
}

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

/** `path` lies strictly inside `root` (either separator: the renderer sees Windows paths too). */
function isInside(root: string, path: string): boolean {
	const rest = path.slice(root.length);
	return path.startsWith(root) && (rest.startsWith("/") || rest.startsWith("\\"));
}

export type AddExclusionStatus = "added" | "isRoot" | "outside" | "covered";

/**
 * Leaves out a folder the user picked. It must lie inside a selected folder and
 * not already be covered by a left-out one. A folder the AI proposed but the user
 * kept comes back as excluded; a wider folder replaces the entries inside it. Its
 * size is measured afterwards (`setScopeMeasure`), so it starts at zero.
 */
export function addExclusion(
	scope: readonly SmartExclusion[] | undefined,
	path: string,
	selectedRoots: readonly string[],
): { readonly status: AddExclusionStatus; readonly scope: readonly SmartExclusion[] } {
	const current = scope ?? [];
	if (selectedRoots.includes(path)) return { status: "isRoot", scope: current };
	const root = selectedRoots.find((candidate) => isInside(candidate, path));
	if (root === undefined) return { status: "outside", scope: current };
	if (current.some((item) => item.excluded && (item.path === path || isInside(item.path, path)))) return { status: "covered", scope: current };
	if (current.some((item) => item.path === path)) return { status: "added", scope: setScopeExcluded(current, path, true) };
	const kept = current.filter((item) => !isInside(path, item.path));
	return { status: "added", scope: [...kept, { path, root, reason: "", files: 0, bytes: 0, excluded: true }] };
}

/** Records the measured files and size of one entry; the same list comes back when the entry is gone. */
export function setScopeMeasure(scope: readonly SmartExclusion[], path: string, files: number, bytes: number): readonly SmartExclusion[] {
	if (!scope.some((item) => item.path === path)) return scope;
	return scope.map((item) => (item.path === path ? { ...item, files, bytes } : item));
}

export interface EtaSaving {
	readonly before: number;
	readonly after: number;
	/** Whole percent of the time saved; 0 when nothing changes. */
	readonly percent: number;
}

/** First-index minutes with and without the left-out files, for the policy bar's "was → now". */
export function etaSaving(totalFiles: number, excludedFiles: number, mode: EmbedMode): EtaSaving {
	const before = etaMinutes(totalFiles, mode);
	const after = etaMinutes(Math.max(0, totalFiles - excludedFiles), mode);
	return { before, after, percent: after < before ? Math.round(((before - after) / before) * 100) : 0 };
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
