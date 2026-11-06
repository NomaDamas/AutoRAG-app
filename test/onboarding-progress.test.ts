import { describe, expect, it } from "vitest";
import { computeIndexingProgress } from "../src/main/onboarding-progress";

const base = { state: "running", minsyncFiles: 0, phaseElapsedMs: 0 } as const;

describe("computeIndexingProgress", () => {
	it("is idle at 0 and done at 100", () => {
		expect(computeIndexingProgress({ ...base, state: "idle", phase: null, processedFiles: 0, totalFiles: 0 })).toEqual({
			progress: 0,
			remainingMinutes: null,
		});
		expect(computeIndexingProgress({ ...base, state: "success", phase: "finalizing", processedFiles: 10, totalFiles: 10 })).toEqual({
			progress: 100,
			remainingMinutes: null,
		});
	});

	it("measures the read phase from processed/total and fills 60% of the bar", () => {
		const half = computeIndexingProgress({ ...base, phase: "parsed", processedFiles: 225, totalFiles: 450 });
		expect(half.progress).toBe(30);
		expect(half.remainingMinutes).toBe(1);
		const done = computeIndexingProgress({ ...base, phase: "parsed", processedFiles: 450, totalFiles: 450 });
		expect(done.progress).toBe(60);
		expect(done.remainingMinutes).toBe(0);
	});

	it("shows the floor estimate before the pre-scan reports a total", () => {
		expect(computeIndexingProgress({ ...base, phase: "parsed", processedFiles: 0, totalFiles: 0 })).toEqual({ progress: 0, remainingMinutes: 8 });
		expect(computeIndexingProgress({ ...base, phase: null, processedFiles: 0, totalFiles: 0 })).toEqual({ progress: 0, remainingMinutes: 8 });
	});

	it("measures the SPLADE tail from MinSync's committed files over what the read produced", () => {
		const half = computeIndexingProgress({ ...base, phase: "minsync", processedFiles: 100, totalFiles: 100, minsyncFiles: 50, phaseElapsedMs: 5_000 });
		expect(half.progress).toBe(77.5);
		expect(half.remainingMinutes).toBe(1);
	});

	it("falls back to elapsed time against the keyword-only rate before MinSync commits anything", () => {
		// 450 files ≈ 60s of keyword work; half elapsed = half of the SPLADE share.
		const half = computeIndexingProgress({ ...base, phase: "minsync", processedFiles: 450, totalFiles: 450, minsyncFiles: 0, phaseElapsedMs: 30_000 });
		expect(half.progress).toBe(77.5);
		expect(half.remainingMinutes).toBe(1);
	});

	it("completes in the last few percent during finalizing, estimated from elapsed time", () => {
		expect(computeIndexingProgress({ ...base, phase: "finalizing", processedFiles: 450, totalFiles: 450, phaseElapsedMs: 30_000 }).progress).toBe(97);
		expect(computeIndexingProgress({ ...base, phase: "finalizing", processedFiles: 450, totalFiles: 450, phaseElapsedMs: 600_000 }).progress).toBe(99);
	});

	it("never reaches 100 before success and drops the estimate on failure", () => {
		const stuck = computeIndexingProgress({ ...base, phase: "minsync", processedFiles: 450, totalFiles: 450, minsyncFiles: 0, phaseElapsedMs: 600_000 });
		expect(stuck.progress).toBe(95);
		const failed = computeIndexingProgress({ ...base, state: "failed", phase: "parsed", processedFiles: 45, totalFiles: 450 });
		expect(failed.progress).toBe(6);
		expect(failed.remainingMinutes).toBeNull();
	});
});
