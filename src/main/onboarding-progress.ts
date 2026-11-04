import { NONE_FILES_PER_MINUTE, NONE_MIN_MINUTES } from "../shared/onboarding-contract";

/**
 * The first index is keyword-only, so the bar it fills has one measurable worker
 * at a time: the parsed mirror reads (and lists) each source, then MinSync's
 * bundled SPLADE encoder writes the sparse index. There is no dense embedding
 * phase, so the read share of the bar is larger than the old local/cloud layout
 * and the SPLADE tail is measured either from MinSync's own crash-resume log
 * (committed files) or, before anything is committed, from elapsed time against
 * the same keyword-only rate the ETA uses. Progress never reaches 100 here: the
 * run's success is the only 100, so a slow tail never looks finished.
 */

/** Phases of the keyword-only refresh, as `refresh-progress.json` reports them. */
export type IndexingRunPhase = "parsed" | "minsync" | "finalizing";

/** Only the three states that change the bar; anything else is treated as running. */
export type IndexingRunState = "idle" | "running" | "success" | "failed";

export interface IndexingProgressInput {
	readonly state: IndexingRunState;
	readonly phase: IndexingRunPhase | null;
	/** Files the parsed mirror has handled (read or skipped). */
	readonly processedFiles: number;
	/** Files the pre-scan expects the first index to read (left-out folders already subtracted). */
	readonly totalFiles: number;
	/** Files MinSync has already committed during `minsync` (`progress.jsonl`). */
	readonly minsyncFiles: number;
	/** Time spent in the current phase. */
	readonly phaseElapsedMs: number;
}

export interface IndexingProgressResult {
	readonly progress: number;
	readonly remainingMinutes: number | null;
}

function clamp01(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	return value >= 1 ? 1 : value;
}

export function computeIndexingProgress(input: IndexingProgressInput): IndexingProgressResult {
	if (input.state === "success") return { progress: 100, remainingMinutes: null };
	if (input.state === "idle") return { progress: 0, remainingMinutes: null };
	const totalFiles = Math.max(0, input.totalFiles);
	const processedFiles = Math.max(0, input.processedFiles);
	const minsyncFiles = Math.max(0, input.minsyncFiles);
	// Before the pre-scan reports a total there is no ceiling to measure against, so the ETA is the floor the folder walk alone costs.
	const expectedMs = totalFiles > 0 ? (totalFiles / NONE_FILES_PER_MINUTE) * 60_000 : null;
	const ratio = expectedMs === null ? 0 : clamp01(input.phaseElapsedMs / expectedMs);
	const remainingFrom = (elapsed: number): number | null => (expectedMs === null ? null : Math.max(0, Math.ceil((expectedMs - elapsed) / 60_000)));
	const result = ((): IndexingProgressResult => {
		switch (input.phase) {
			case "parsed": {
				if (totalFiles === 0) return { progress: 0, remainingMinutes: NONE_MIN_MINUTES };
				const measured = clamp01(processedFiles / totalFiles) * 60;
				return { progress: measured, remainingMinutes: Math.max(0, Math.ceil((totalFiles - processedFiles) / NONE_FILES_PER_MINUTE)) };
			}
			case "minsync": {
				// MinSync's own committed files are the exact measure; before any is committed, elapsed time against the rate is the best estimate.
				const measuredRatio = minsyncFiles > 0 ? clamp01(minsyncFiles / Math.max(processedFiles, totalFiles)) : 0;
				if (measuredRatio > 0) {
					const minsyncTotal = Math.max(processedFiles, totalFiles);
					return {
						progress: 60 + 35 * measuredRatio,
						remainingMinutes: Math.max(0, Math.ceil((minsyncTotal - minsyncFiles) / NONE_FILES_PER_MINUTE)),
					};
				}
				return { progress: 60 + 35 * ratio, remainingMinutes: remainingFrom(input.phaseElapsedMs) };
			}
			case "finalizing":
				return { progress: 95 + 4 * ratio, remainingMinutes: remainingFrom(input.phaseElapsedMs) };
			default:
				return { progress: 0, remainingMinutes: totalFiles > 0 ? Math.ceil(totalFiles / NONE_FILES_PER_MINUTE) : NONE_MIN_MINUTES };
		}
	})();
	// A failed run has no remaining estimate, even though its last phase is known.
	return input.state === "failed" ? { progress: Math.min(result.progress, 99), remainingMinutes: null } : result;
}
