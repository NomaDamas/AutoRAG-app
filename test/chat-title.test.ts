import { describe, expect, it, vi } from "vitest";
import { createChatTitler, parseTitle, titlePrompt } from "../src/main/chat-title";

describe("chat title", () => {
	it("takes the first line of the reply, without a label, quotes, or a closing period", () => {
		expect(parseTitle("\n제목: “환불 승인 절차”.\n설명은 생략")).toBe("환불 승인 절차");
		expect(parseTitle("**Refund approvals**")).toBe("Refund approvals");
		expect(parseTitle("  \n ")).toBeNull();
		expect(parseTitle("가".repeat(60))).toHaveLength(40);
	});

	it("asks in the interface language and sends only the start of a long answer", () => {
		const prompt = titlePrompt("q?", "a".repeat(5_000), "ja");
		expect(prompt).toContain("Japanese");
		expect(prompt.length).toBeLessThan(2_000);
	});

	it("resolves null instead of throwing when the model is not set up or fails", async () => {
		const titler = createChatTitler({
			resolveModel: vi.fn(async () => {
				throw new Error("no model");
			}),
			complete: vi.fn(),
			language: () => "ko",
		});
		await expect(titler("q", "a")).resolves.toBeNull();
	});
});
