/**
 * What is still wrong with the index after the first run, for the surfaces the
 * Finder keeps on screen (sidebar block, banner above the file list, Settings
 * card). Onboarding's own screen reads `IndexingStatus`; this is the same fact
 * after the user has moved on, so it survives a relaunch and stays until the
 * index works again or the user dismisses it.
 */

import type { IndexFailure } from "./index-failure";

export const INDEX_PROBLEM_CHANNELS = {
	get: "indexProblem:get",
	changed: "indexProblem:changed",
	retry: "indexProblem:retry",
	dismiss: "indexProblem:dismiss",
} as const;

export interface IndexProblem {
	/** Why the last first-index or refresh run stopped; `null` when the index works. */
	readonly failure: IndexFailure | null;
	/** Files the last run finished without (read errors, parser timeouts, files MinSync skipped). */
	readonly skipped: number;
	/** When the run that left this behind ended; `null` when there is no problem. */
	readonly at: string | null;
	/** True while a retry started from the surfaces is running. */
	readonly retrying: boolean;
}

export const NO_INDEX_PROBLEM: IndexProblem = { failure: null, skipped: 0, at: null, retrying: false };

export function hasIndexProblem(problem: IndexProblem): boolean {
	return problem.failure !== null || problem.skipped > 0;
}

export interface IndexProblemBridge {
	get(): Promise<IndexProblem>;
	/** Pushed whenever the problem changes; returns the unsubscribe. */
	onChange(listener: (problem: IndexProblem) => void): () => void;
	/** Runs the local index again (downloading the on-device model first when it is missing); resolves when the run ends. */
	retry(): Promise<void>;
	/** Hides the problem until a run leaves a new one. */
	dismiss(): Promise<void>;
}
