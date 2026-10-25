import { describe, expect, it } from "vitest";
import { answerViewState } from "../src/renderer/src/state/answer-view";

describe("answerViewState", () => {
	it("shimmers while the run is live and no answer text has started, whatever the Quick answer is doing", () => {
		expect(answerViewState({ pending: true, deepReady: false })).toEqual({ shimmer: true });
	});

	it("stops shimmering once the Deep answer has text: the answer itself is what moves then", () => {
		expect(answerViewState({ pending: true, deepReady: true })).toEqual({ shimmer: false });
	});

	it("animates nothing after Stop clears the run, with no answer at all", () => {
		expect(answerViewState({ pending: false, deepReady: false })).toEqual({ shimmer: false });
	});

	it("animates nothing for a finished run", () => {
		expect(answerViewState({ pending: false, deepReady: true })).toEqual({ shimmer: false });
	});
});
