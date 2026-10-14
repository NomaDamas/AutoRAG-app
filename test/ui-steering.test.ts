import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/shared/search-contract";
import { composerAction, deliverSteers, restoreChat, settleSteers, type SteerItem } from "../src/renderer/src/state/steering";

const item = (text: string, status: SteerItem["status"], timing: SteerItem["timing"] = "after-quick"): SteerItem => ({
	id: text,
	text,
	timing,
	status,
});

describe("composerAction", () => {
	it("asks a new question when no search runs, with or without ⌥", () => {
		expect(composerAction({ searching: false, altKey: false })).toBe("ask");
		expect(composerAction({ searching: false, altKey: true })).toBe("ask");
	});

	it("steers the running search on Enter and queues the next question on ⌥Enter", () => {
		expect(composerAction({ searching: true, altKey: false })).toBe("steer");
		expect(composerAction({ searching: true, altKey: true })).toBe("queue");
	});
});

describe("steer delivery", () => {
	it("marks every waiting steer delivered once a model request took them, and leaves earlier ones alone", () => {
		const before = [item("a", "delivered"), item("b", "pending"), item("c", "pending")];
		expect(deliverSteers(before).map((steer) => steer.status)).toEqual(["delivered", "delivered", "delivered"]);
	});

	it("keeps the same list when nothing waits, so the view does not re-render", () => {
		const settled = [item("a", "delivered")];
		expect(deliverSteers(settled)).toBe(settled);
	});

	it("drops a steer still waiting when the run ends, so nothing keeps pulsing", () => {
		const items = [item("a", "delivered"), item("b", "pending")];
		expect(settleSteers(items).map((steer) => steer.status)).toEqual(["delivered", "dropped"]);
	});
});

describe("restoreChat", () => {
	it("splits a stored chat into turns, each with its question, the steers its run took, and its answer", () => {
		const messages: ChatMessage[] = [
			{ role: "user", text: "When is the launch?", attachments: [], at: "t0" },
			{ role: "user", text: "Only last week.", attachments: [], at: "t1", steer: "before-quick" },
			{ role: "assistant", sessionId: "s1", quick: null, deep: null, stopped: false, at: "t2" },
			{ role: "user", text: "And the budget?", attachments: [], at: "t3" },
			{ role: "user", text: "Use the June plan.", attachments: [], at: "t4", steer: "after-quick" },
			{ role: "assistant", sessionId: "s2", quick: null, deep: null, stopped: false, at: "t5" },
		];

		const turns = restoreChat(messages);

		expect(turns.map((turn) => turn.question.text)).toEqual(["When is the launch?", "And the budget?"]);
		expect(turns.map((turn) => turn.assistant?.sessionId)).toEqual(["s1", "s2"]);
		expect(turns.map((turn) => turn.steers.map(({ text, timing, status }) => [text, timing, status]))).toEqual([
			[["Only last week.", "before-quick", "delivered"]],
			[["Use the June plan.", "after-quick", "delivered"]],
		]);
	});

	it("keeps a last question that has no answer yet", () => {
		const turns = restoreChat([{ role: "user", text: "Pending?", attachments: [], at: "t0" }]);

		expect(turns).toHaveLength(1);
		expect(turns[0]?.assistant).toBeNull();
	});
});
