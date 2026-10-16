import { describe, expect, it } from "vitest";
import { computeIndexingProgress } from "../src/main/onboarding-progress";

describe("computeIndexingProgress", () => {
	it("is idle at 0 and done at 100", () => {
		expect(computeIndexingProgress({ state: "idle", phase: null, processedFiles: 0, totalFiles: 0, phaseElapsedMs: 0 })).toEqual({
			progress: 0,
			remainingMinutes: null,
		});
		expect(computeIndexingProgress({ state: "success", phase: "finalizing", processedFiles: 10, totalFiles: 10, phaseElapsedMs: 0 })).toEqual({
			progress: 100,
			remainingMinutes: null,
		});
	});

	it("measures the read phase from processed/total, filling half the bar", () => {
		const half = computeIndexingProgress({ state: "running", phase: "parsed", processedFiles: 85, totalFiles: 170, phaseElapsedMs: 0 });
		expect(half.progress).toBe(25);
		expect(half.remainingMinutes).toBe(1);
		const done = computeIndexingProgress({ state: "running", phase: "parsed", processedFiles: 170, totalFiles: 170, phaseElapsedMs: 0 });
		expect(done.progress).toBe(50);
		expect(done.remainingMinutes).toBe(0);
	});

	it("has no estimate when the pre-scan found nothing", () => {
		expect(computeIndexingProgress({ state: "running", phase: "parsed", processedFiles: 0, totalFiles: 0, phaseElapsedMs: 0 })).toEqual({
			progress: 0,
			remainingMinutes: null,
		});
	});

	it("estimates later local phases from elapsed time against the local rate", () => {
		// 85 files ≈ 60s of local work; half elapsed = half of the phase's share.
		const minsync = computeIndexingProgress({ state: "running", phase: "minsync", processedFiles: 85, totalFiles: 85, phaseElapsedMs: 30_000 });
		expect(minsync.progress).toBe(72.5);
		expect(minsync.remainingMinutes).toBe(1);
		const finalizing = computeIndexingProgress({ state: "running", phase: "finalizing", processedFiles: 85, totalFiles: 85, phaseElapsedMs: 60_000 });
		expect(finalizing.progress).toBe(99);
	});

	it("never reaches 100 before success and drops the estimate on failure", () => {
		const stuck = computeIndexingProgress({ state: "running", phase: "minsync", processedFiles: 85, totalFiles: 85, phaseElapsedMs: 600_000 });
		expect(stuck.progress).toBe(95);
		const failed = computeIndexingProgress({ state: "failed", phase: "parsed", processedFiles: 10, totalFiles: 100, phaseElapsedMs: 0 });
		expect(failed.remainingMinutes).toBeNull();
		expect(failed.progress).toBe(5);
	});
});
