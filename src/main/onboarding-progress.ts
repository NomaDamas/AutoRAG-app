import { LOCAL_FILES_PER_MINUTE, type IndexingPhase, type IndexingStatus } from "../shared/onboarding-contract";

/**
 * Phase → percent/remaining. The read phase is measured from the parsed mirror
 * (files actually handled); the later phases have no per-file work to count, so
 * their share of the bar is estimated from elapsed time against the same
 * files-per-minute the local ETA uses. Progress never reaches 100 until the
 * refresh reports success, so a slow tail never looks finished.
 */

export interface PhaseProgressInput {
	readonly state: IndexingStatus["state"];
	readonly phase: IndexingPhase | null;
	readonly processedFiles: number;
	readonly totalFiles: number;
	/** Time spent in the current phase. */
	readonly phaseElapsedMs: number;
}

export interface PhaseProgressResult {
	readonly progress: number;
	readonly remainingMinutes: number | null;
}

function clamp01(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	return value >= 1 ? 1 : value;
}

export function computeIndexingProgress(input: PhaseProgressInput): PhaseProgressResult {
	if (input.state === "success") return { progress: 100, remainingMinutes: null };
	if (input.state === "idle") return { progress: 0, remainingMinutes: null };
	const expectedMs = input.totalFiles > 0 ? (input.totalFiles / LOCAL_FILES_PER_MINUTE) * 60_000 : null;
	const ratio = expectedMs === null ? 0 : clamp01(input.phaseElapsedMs / expectedMs);
	const remainingFrom = (elapsed: number): number | null =>
		expectedMs === null ? null : Math.max(0, Math.ceil((expectedMs - elapsed) / 60_000));
	const result = ((): PhaseProgressResult => {
		switch (input.phase) {
			case "parsed": {
				const measured = input.totalFiles > 0 ? clamp01(input.processedFiles / input.totalFiles) * 50 : 0;
				const remaining =
					input.totalFiles > 0 ? Math.max(0, Math.ceil((input.totalFiles - input.processedFiles) / LOCAL_FILES_PER_MINUTE)) : null;
				return { progress: measured, remainingMinutes: remaining };
			}
			case "minsync":
				return { progress: 50 + 40 * ratio, remainingMinutes: remainingFrom(input.phaseElapsedMs) };
			case "datasources":
				return { progress: 90 + 7 * ratio, remainingMinutes: remainingFrom(input.phaseElapsedMs) };
			case "finalizing":
				return { progress: 97 + 2 * ratio, remainingMinutes: remainingFrom(input.phaseElapsedMs) };
			default:
				return { progress: 0, remainingMinutes: input.totalFiles > 0 ? Math.ceil(input.totalFiles / LOCAL_FILES_PER_MINUTE) : null };
		}
	})();
	// A failed run has no remaining estimate, even though its last phase is known.
	return input.state === "failed" ? { progress: result.progress, remainingMinutes: null } : result;
}
