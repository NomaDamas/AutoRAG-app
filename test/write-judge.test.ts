import { MockBackend, type JevBackend } from "jev-use";
import { describe, expect, it, vi } from "vitest";
import { createWriteJudge } from "../src/main/agents/write-judge";

const question = { id: "q", type: "noul", question: "Does it write?" } as never;

describe("write judge: Jev first, the small model second, nothing when neither exists", () => {
	it("is absent when no decision backend can be built", async () => {
		const judge = createWriteJudge({ resolveBackends: async () => ({}) });
		await expect(judge("state", [question])).rejects.toThrow(/no decision model/iu);
	});

	it("asks the primary backend", async () => {
		const primary = new MockBackend({ q: { answer: 0.03, confidence: 0.95 } });
		const judge = createWriteJudge({ resolveBackends: async () => ({ primary }) });
		const result = await judge("state", [question]);
		expect(result.verdicts[0]?.id).toBe("q");
		expect(typeof result.verdicts[0]?.answer).toBe("number");
	});

	it("falls back to the second backend when the first fails", async () => {
		const broken: JevBackend = { name: "broken", judge: vi.fn(async () => { throw new Error("down"); }) } as never;
		const fallback = new MockBackend({ q: { answer: 0.9, confidence: 0.95 } });
		const judge = createWriteJudge({ resolveBackends: async () => ({ primary: broken, fallback }) });
		const result = await judge("state", [question]);
		expect(result.verdicts[0]?.answer).toBeGreaterThan(0.5);
		expect(broken.judge).toHaveBeenCalled();
	});

	it("resolves the backends once per config, not once per command", async () => {
		const resolve = vi.fn(async () => ({ primary: new MockBackend({ q: { answer: 0.1, confidence: 0.95 } }) }));
		const judge = createWriteJudge({ resolveBackends: resolve });
		await judge("a", [question]);
		await judge("b", [question]);
		expect(resolve).toHaveBeenCalledTimes(1);
	});
});
