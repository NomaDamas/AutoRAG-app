/**
 * What an index run has measurably done, stage by stage. One computation
 * (`index-progress.ts`) fills it; the first-run indexing screen, the sidebar
 * activity entry and Settings > Indexing all read this same shape, so they can
 * never disagree about how far along a run is.
 *
 * Nothing here is estimated from elapsed time. Every count is a number a
 * process wrote down (the librarian's `refresh-progress.json`, MinSync's
 * `progress.jsonl`, the parsed mirror), and the remaining-time estimate comes
 * from the rate those counts actually moved at.
 */

/** The four stages of a run that embeds, in order: find files, read them, embed them into the search index, tidy up. */
export const INDEX_STAGES = ["discover", "parse", "embed", "finalize"] as const;
/**
 * The stages of a keyword-only run (semantic search off). MinSync still goes through every file, building a sparse
 * keyword index, so its stage counts files like the embedding one does; it only has a name of its own.
 */
export const KEYWORD_INDEX_STAGES = ["discover", "parse", "keyword", "finalize"] as const;
export type IndexStageId = (typeof INDEX_STAGES)[number] | (typeof KEYWORD_INDEX_STAGES)[number];

/** The stages of a run, in order; `embedding` is false for keyword-only. */
export function indexStagesFor(embedding: boolean): readonly IndexStageId[] {
	return embedding ? INDEX_STAGES : KEYWORD_INDEX_STAGES;
}

/** The stages that go through the files one by one: reading them, and MinSync's. Discovery and the tidy-up have nothing to count. */
export function isFileCountStage(id: IndexStageId | null): boolean {
	return id === "parse" || id === "embed" || id === "keyword";
}

export type IndexStageState = "pending" | "running" | "done";

/**
 * Files the stage has dealt with, in the stage's own unit (always files, never
 * a mix of files and documents). `done`, `skipped` and `failed` are disjoint,
 * so `done + skipped + failed <= total` whenever `total` is known.
 */
export interface IndexStageCounts {
	/** Finished and usable. */
	readonly done: number;
	/** Deliberately left out (unsupported type, excluded, too large). */
	readonly skipped: number;
	/** Tried and failed; the next run retries them. */
	readonly failed: number;
	/** `null` until the process reports how many there are. */
	readonly total: number | null;
}

export interface IndexStageBytes {
	/** Bytes of the files counted in `IndexStageCounts.done`. */
	readonly done: number;
	/** `null` when the size of the whole stage is not known. */
	readonly total: number | null;
}

export interface IndexStageProgress {
	readonly id: IndexStageId;
	readonly state: IndexStageState;
	/** `null` for a stage that has nothing to count (the final tidy-up). */
	readonly counts: IndexStageCounts | null;
	readonly bytes: IndexStageBytes | null;
	/** Measured completion of this stage, 0..1; `null` while it cannot be measured. */
	readonly fraction: number | null;
}

/**
 * `calculating`: not enough movement has been observed to project an end.
 * `estimated`: `etaMinutes` is projected from the rate of the last few minutes.
 * `none`: there is nothing to project (idle, finished, failed, or a stage with no counts).
 */
export type IndexEtaState = "none" | "calculating" | "estimated";

export interface IndexActivityPulse {
	/** When the finished count last rose (ISO); `null` before the first completion was seen. */
	readonly lastCompletedAt: string | null;
	/** The newest sign of life from the process doing the work (ISO), e.g. MinSync's 5 s heartbeat. */
	readonly heartbeatAt: string | null;
	/** Name of the file most recently finished; `null` when the source does not say. */
	readonly lastFile: string | null;
	/** No file finished for a long while although some remain; the run may be stuck. */
	readonly stalled: boolean;
}

export interface IndexProgressSnapshot {
	/** The stage in progress; `null` when nothing runs. */
	readonly stage: IndexStageId | null;
	readonly stages: readonly IndexStageProgress[];
	/**
	 * Position on a bar for the whole run, 0..1: finished stages plus the measured part of the running one,
	 * each on a fixed share of the bar (a layout choice, never a time estimate). Reaches 1 only when the run ends.
	 */
	readonly fraction: number;
	/** True while the running stage cannot be measured: draw the bar as indeterminate rather than at `fraction`. */
	readonly indeterminate: boolean;
	readonly etaState: IndexEtaState;
	/** Whole minutes left in the running stage (at least 1 while work remains); `null` unless `etaState` is `estimated`. */
	readonly etaMinutes: number | null;
	readonly pulse: IndexActivityPulse;
}
