import { describe, expect, it, vi } from "vitest";
import { createVersionDiffSummaryService, isVersionDiffSummaryRequest } from "../src/main/version-diff-summary";
import type { FsVersionDiffSummaryRequest } from "../src/shared/fs-contract";

const SAMPLE_REQUEST: FsVersionDiffSummaryRequest = {
	previousName: "roadmap_v1.md",
	currentName: "roadmap_v2.md",
	addedCount: 2,
	removedCount: 1,
	language: "ko",
	hunks: [
		{
			previousStart: 1,
			previousCount: 2,
			currentStart: 1,
			currentCount: 3,
			lines: [
				{ kind: "context", text: "# Q4 Roadmap", previousLine: 1, currentLine: 1 },
				{ kind: "removed", text: "Budget: 100M", previousLine: 2, currentLine: null },
				{ kind: "added", text: "Budget: 120M", previousLine: null, currentLine: 2 },
				{ kind: "added", text: "Added QA gate", previousLine: null, currentLine: 3 },
			],
		},
	],
};

describe("version-diff-summary service", () => {
	it("validates incoming IPC request payloads", () => {
		expect(isVersionDiffSummaryRequest(SAMPLE_REQUEST)).toBe(true);
		expect(isVersionDiffSummaryRequest(null)).toBe(false);
		expect(isVersionDiffSummaryRequest({ previousName: "a" })).toBe(false);
	});

	it("summarizes once with a concise prompt and caches subsequent identical requests", async () => {
		const calls: Array<{ readonly systemPrompt: string; readonly userPrompt: string }> = [];
		const complete = vi.fn(async (input: { readonly systemPrompt: string; readonly userPrompt: string }) => {
			calls.push(input);
			return "예산을 120M으로 조정하고 QA 게이트를 추가했습니다.";
		});
		const service = createVersionDiffSummaryService({ complete });

		const first = await service.summarize(SAMPLE_REQUEST);
		const second = await service.summarize(SAMPLE_REQUEST);

		expect(first.summary).toBe("예산을 120M으로 조정하고 QA 게이트를 추가했습니다.");
		expect(second).toEqual(first);
		expect(complete).toHaveBeenCalledTimes(1);
		const arg = calls[0];
		expect(arg?.systemPrompt.length).toBeLessThan(200);
		expect(arg?.userPrompt).toContain("+ Budget: 120M");
		expect(arg?.userPrompt).toContain("- Budget: 100M");
	});

	it("degrades silently to null when no sLLM model is available or completion fails", async () => {
		const noModel = createVersionDiffSummaryService({
			resolveModel: async () => undefined,
		});
		expect(await noModel.summarize(SAMPLE_REQUEST)).toEqual({ summary: null });

		const failing = createVersionDiffSummaryService({
			complete: async () => {
				throw new Error("network down");
			},
		});
		expect(await failing.summarize(SAMPLE_REQUEST)).toEqual({ summary: null });
	});
});
