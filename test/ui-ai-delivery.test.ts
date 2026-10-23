import { describe, expect, it, vi } from "vitest";
import { deliverToDock, mergeDelivery, type AiDeliveryTarget } from "../src/renderer/src/state/ai-delivery";
import type { ChatAttachment } from "../src/shared/search-contract";

function target(): AiDeliveryTarget & { readonly calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		prefill: vi.fn((text: string) => void calls.push(`prefill:${text}`)),
		sendQuery: vi.fn((text: string) => void calls.push(`send:${text}`)),
		attach: vi.fn((atts: readonly ChatAttachment[]) => void calls.push(`attach:${atts.length}`)),
		summarize: vi.fn((atts: readonly ChatAttachment[]) => void calls.push(`summarize:${atts.length}`)),
		focusComposer: vi.fn(() => void calls.push("focus")),
	};
}

const file = (id: string): ChatAttachment => ({ kind: "file", id, name: id });

describe("a draft for the AI Search composer", () => {
	it("only fills the composer: nothing is sent, so the person writes the rest and presses Enter", () => {
		const dock = target();
		deliverToDock(dock, mergeDelivery(null, { draft: "이 자동화 규칙을 수정해줘 — x. 바꿀 내용: " }));
		expect(dock.calls).toEqual(["prefill:이 자동화 규칙을 수정해줘 — x. 바꿀 내용: "]);
		expect(dock.sendQuery).not.toHaveBeenCalled();
		expect(dock.summarize).not.toHaveBeenCalled();
	});

	it("keeps a draft's trailing space, where the person starts typing", () => {
		const merged = mergeDelivery(null, { draft: "만들어줘: " });
		expect(merged.draft).toBe("만들어줘: ");
	});

	it("loses to an explicit query: a question that is sent is not also left in the composer", () => {
		const dock = target();
		deliverToDock(dock, mergeDelivery(mergeDelivery(null, { draft: "초안" }), { query: "질문" }));
		expect(dock.calls).toEqual(["send:질문"]);
	});

	it("never leaks into an AI 요약 run, which sends its own prompt", () => {
		const dock = target();
		deliverToDock(dock, mergeDelivery(mergeDelivery(null, { summarize: [file("/a.pdf")] }), { draft: "초안" }));
		expect(dock.calls).toEqual(["summarize:1"]);
	});

	it("attaches dropped files first, then fills the draft", () => {
		const dock = target();
		deliverToDock(dock, mergeDelivery(null, { attach: [file("/a.pdf")], draft: "초안" }));
		expect(dock.calls).toEqual(["attach:1", "prefill:초안"]);
	});

	it("takes the latest draft when two arrive before the tab is ready", () => {
		const merged = mergeDelivery(mergeDelivery(null, { draft: "첫째" }), { draft: "둘째" });
		expect(merged.draft).toBe("둘째");
	});

	it("only focuses the composer when there is nothing to deliver", () => {
		const dock = target();
		deliverToDock(dock, mergeDelivery(null, {}));
		expect(dock.calls).toEqual(["focus"]);
	});

	it("still delivers an attachment, a query, and a summary exactly as before", () => {
		const attached = target();
		deliverToDock(attached, mergeDelivery(null, { attach: [file("/a.pdf")] }));
		expect(attached.calls).toEqual(["attach:1", "focus"]);
		const asked = target();
		deliverToDock(asked, mergeDelivery(null, { attach: [file("/a.pdf")], query: "q" }));
		expect(asked.calls).toEqual(["attach:1", "send:q"]);
	});
});
