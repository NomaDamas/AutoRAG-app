import { describe, expect, it } from "vitest";
import { answerViewState } from "../src/renderer/src/state/answer-view";

describe("answerViewState", () => {
	it("shimmers before any Quick text while the run is live", () => {
		expect(answerViewState({ pending: true, quickReady: false, deepReady: false })).toEqual({ skeleton: true, thinking: false });
	});

	it("shows the Thinking row once Quick landed and Deep is still pending", () => {
		expect(answerViewState({ pending: true, quickReady: true, deepReady: false })).toEqual({ skeleton: false, thinking: true });
	});

	it("animates nothing once both answers are in", () => {
		expect(answerViewState({ pending: true, quickReady: true, deepReady: true })).toEqual({ skeleton: false, thinking: false });
	});

	it("animates nothing after Stop clears the run, even with no answer", () => {
		expect(answerViewState({ pending: false, quickReady: false, deepReady: false })).toEqual({ skeleton: false, thinking: false });
	});
});
