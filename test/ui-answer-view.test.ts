import { describe, expect, it } from "vitest";
import { answerViewState } from "../src/renderer/src/state/answer-view";

describe("answerViewState", () => {
	it("shimmers before any Quick text while the run is live", () => {
		expect(answerViewState({ pending: true, quickReady: false, deepReady: false })).toEqual({ skeleton: true, narration: false, thinking: false });
	});

	it("keeps what the agent said it is doing on screen while the draft is withdrawn and the shimmer is back", () => {
		// A message that went on to call a tool is a progress note: its draft is taken back, its text arrives as progress.
		expect(answerViewState({ pending: true, quickReady: false, deepReady: false, hasProgress: true })).toEqual({
			skeleton: true,
			narration: true,
			thinking: false,
		});
	});

	it("shows the Thinking row once Quick landed and Deep is still pending", () => {
		expect(answerViewState({ pending: true, quickReady: true, deepReady: false })).toEqual({ skeleton: false, narration: false, thinking: true });
	});

	it("shows no narration once answer text exists: the Thinking row carries the progress then", () => {
		expect(answerViewState({ pending: true, quickReady: true, deepReady: false, hasProgress: true }).narration).toBe(false);
	});

	it("animates nothing once both answers are in", () => {
		expect(answerViewState({ pending: true, quickReady: true, deepReady: true })).toEqual({ skeleton: false, narration: false, thinking: false });
	});

	it("animates nothing after Stop clears the run, even with no answer and a progress note left over", () => {
		expect(answerViewState({ pending: false, quickReady: false, deepReady: false, hasProgress: true })).toEqual({
			skeleton: false,
			narration: false,
			thinking: false,
		});
	});
});
