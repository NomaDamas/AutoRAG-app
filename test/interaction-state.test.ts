import { describe, expect, it } from "vitest";
import type { ApprovalRequest, Question, QuestionRequest } from "../src/shared/interaction-contract";
import {
	allowOnceAnswer,
	allowSessionAnswer,
	answeredCount,
	approvalAnswer,
	approvalHeadlineKey,
	approvalReasonVisible,
	buildAnswer,
	canSubmit,
	cancelAnswer,
	categoryKey,
	closeRequest,
	denyAnswer,
	denyWithNoteAnswer,
	draftAnswer,
	draftAt,
	frontRequest,
	initialQuestionState,
	mergePending,
	modeDescriptionKey,
	modeLabelKey,
	openRequest,
	selectOption,
	sessionAllowKey,
	setFreeform,
	setFreeformOpen,
	setStep,
} from "../src/renderer/src/state/interaction";

const question = (patch: Partial<Question> = {}): Question => ({
	question: "Which?",
	options: [],
	allowMultiple: false,
	allowFreeform: true,
	...patch,
});

const questionRequest = (questions: readonly Question[], patch: Partial<QuestionRequest> = {}): QuestionRequest => ({
	kind: "question",
	id: "q1",
	searchId: "s1",
	questions,
	...patch,
});

const approvalRequest = (patch: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
	kind: "approval",
	id: "a1",
	searchId: "s1",
	reason: "",
	categories: [],
	call: "rm -rf build",
	sessionScope: "all",
	...patch,
});

describe("interaction request queue", () => {
	it("adds a request once, so a replayed onRequest never doubles it", () => {
		const request = approvalRequest();
		const queue = openRequest(openRequest([], request), request);
		expect(queue).toHaveLength(1);
		expect(queue[0]).toBe(request);
	});

	it("folds pending() in FIFO order and dedupes by id against what is already open", () => {
		const first = questionRequest([question()], { id: "q1" });
		const second = approvalRequest({ id: "a1" });
		const queue = mergePending([first, second], [second, approvalRequest({ id: "a2" })]);
		expect(queue.map((request) => request.id)).toEqual(["q1", "a1", "a2"]);
	});

	it("returns the same queue when nothing is open or nothing matched, so the view does not re-render", () => {
		const queue = [approvalRequest()];
		expect(mergePending(queue, [])).toBe(queue);
		expect(closeRequest(queue, "missing")).toBe(queue);
	});

	it("drops a request by id and keeps the rest in order", () => {
		const queue = [approvalRequest({ id: "a1" }), approvalRequest({ id: "a2" })];
		expect(closeRequest(queue, "a1").map((request) => request.id)).toEqual(["a2"]);
	});

	it("shows only the requests of one search, oldest first", () => {
		const queue = [
			approvalRequest({ id: "a1", searchId: "s1" }),
			questionRequest([question()], { id: "q9", searchId: "s2" }),
			approvalRequest({ id: "a2", searchId: "s1" }),
		];
		expect(frontRequest(queue, "s1")?.id).toBe("a1");
		// The next one of that search is shown once the front is answered.
		expect(frontRequest(closeRequest(queue, "a1"), "s1")?.id).toBe("a2");
		// A panel that is not the run's shows nothing of another search.
		expect(frontRequest(queue, "s3")).toBeNull();
	});
});

describe("approval mode labels", () => {
	it("names a label and a description key per mode", () => {
		expect(modeLabelKey("ask")).toBe("interaction.mode.ask.label");
		expect(modeLabelKey("auto")).toBe("interaction.mode.auto.label");
		expect(modeLabelKey("full")).toBe("interaction.mode.full.label");
		expect(modeDescriptionKey("full")).toBe("interaction.mode.full.desc");
	});
});

describe("approval gate labels", () => {
	it("asks whether the call may run in ask (sessionScope all) and whether the change may proceed otherwise", () => {
		expect(approvalHeadlineKey(approvalRequest({ sessionScope: "all" }))).toBe("interaction.approval.headlineRun");
		expect(approvalHeadlineKey(approvalRequest({ sessionScope: "categories" }))).toBe("interaction.approval.headlineChange");
		expect(approvalHeadlineKey(approvalRequest({ sessionScope: "unclassified" }))).toBe("interaction.approval.headlineChange");
	});

	it("names the session-allow label after what the allowance covers", () => {
		expect(sessionAllowKey(approvalRequest({ sessionScope: "categories" }))).toBe("interaction.allowSession.categories");
		expect(sessionAllowKey(approvalRequest({ sessionScope: "unclassified" }))).toBe("interaction.allowSession.unclassified");
		expect(sessionAllowKey(approvalRequest({ sessionScope: "all" }))).toBe("interaction.allowSession.all");
	});

	it("maps every change category to its translated chip key", () => {
		expect(categoryKey("delete")).toBe("interaction.category.delete");
		expect(categoryKey("unclear")).toBe("interaction.category.unclear");
	});

	it("hides the reason when it is empty, just the tool name (ask), or the call itself", () => {
		expect(approvalReasonVisible(approvalRequest({ sessionScope: "categories", reason: "  " }))).toBe(false);
		expect(approvalReasonVisible(approvalRequest({ sessionScope: "all", reason: "shell" }))).toBe(false);
		expect(approvalReasonVisible(approvalRequest({ sessionScope: "categories", reason: "rm -rf build" }))).toBe(false);
		expect(approvalReasonVisible(approvalRequest({ sessionScope: "categories", reason: "removes the build output" }))).toBe(true);
	});
});

describe("approval answers", () => {
	it("builds each choice, and trims the deny note without requiring one", () => {
		expect(allowOnceAnswer()).toEqual({ kind: "approval", choice: "allow-once" });
		expect(allowSessionAnswer()).toEqual({ kind: "approval", choice: "allow-session" });
		expect(denyAnswer()).toEqual({ kind: "approval", choice: "deny" });
		expect(denyWithNoteAnswer("  work on a copy  ")).toEqual({ kind: "approval", choice: "deny-with-note", note: "work on a copy" });
		expect(denyWithNoteAnswer("   ")).toEqual({ kind: "approval", choice: "deny-with-note", note: "" });
		expect(approvalAnswer("deny")).toEqual({ kind: "approval", choice: "deny" });
	});

	it("has one shared cancel value for dismissals", () => {
		expect(cancelAnswer()).toEqual({ kind: "cancel" });
		expect(cancelAnswer()).toBe(cancelAnswer());
	});
});

describe("question answer machine", () => {
	it("starts every question empty and expands the freeform row for a question with no options", () => {
		const state = initialQuestionState(
			questionRequest([question({ options: [{ title: "A" }] }), question({ options: [] })]),
		);
		expect(state.step).toBe(0);
		expect(state.drafts).toEqual([
			{ selections: [], freeform: "", freeformOpen: false },
			{ selections: [], freeform: "", freeformOpen: true },
		]);
	});

	it("replaces the pick on a single-choice question and toggles it on a multiple one", () => {
		const single = question({ options: [{ title: "A" }, { title: "B" }] });
		let state = initialQuestionState(questionRequest([single]));
		state = selectOption(state, single, 0, "A");
		state = selectOption(state, single, 0, "B");
		expect(draftAt(state, 0).selections).toEqual(["B"]);

		const multiple = question({ options: [{ title: "A" }, { title: "B" }], allowMultiple: true });
		let multi = initialQuestionState(questionRequest([multiple]));
		multi = selectOption(multi, multiple, 0, "A");
		multi = selectOption(multi, multiple, 0, "B");
		multi = selectOption(multi, multiple, 0, "A");
		expect(draftAt(multi, 0).selections).toEqual(["B"]);
	});

	it("returns a pick in the question's option order, whatever order it was picked", () => {
		const q = question({ options: [{ title: "A" }, { title: "B" }, { title: "C" }], allowMultiple: true });
		let state = initialQuestionState(questionRequest([q]));
		state = selectOption(state, q, 0, "C");
		state = selectOption(state, q, 0, "A");
		expect(draftAnswer(q, draftAt(state, 0))).toEqual({ kind: "selection", selections: ["A", "C"] });
	});

	it("lets a typed answer win over a pick and never sends an empty freeform text", () => {
		const q = question({ options: [{ title: "A" }] });
		let state = initialQuestionState(questionRequest([q]));
		expect(draftAnswer(q, draftAt(state, 0))).toBeNull();
		state = selectOption(state, q, 0, "A");
		state = setFreeform(state, 0, "   ");
		expect(draftAnswer(q, draftAt(state, 0))).toEqual({ kind: "selection", selections: ["A"] });
		state = setFreeform(state, 0, "  another way  ");
		expect(draftAnswer(q, draftAt(state, 0))).toEqual({ kind: "freeform", text: "another way" });
	});

	it("expands and collapses the freeform row", () => {
		let state = initialQuestionState(questionRequest([question({ options: [{ title: "A" }] })]));
		expect(draftAt(state, 0).freeformOpen).toBe(false);
		state = setFreeformOpen(state, 0, true);
		expect(draftAt(state, 0).freeformOpen).toBe(true);
	});

	it("builds one ordered entry per question, null for a skipped one", () => {
		const request = questionRequest([
			question({ options: [{ title: "A" }] }),
			question({ options: [{ title: "B" }], allowMultiple: true }),
			question({ options: [] }),
		]);
		let state = initialQuestionState(request);
		state = selectOption(state, request.questions[0]!, 0, "A");
		state = setFreeform(state, 2, "own words");
		expect(buildAnswer(request, state)).toEqual({
			kind: "question",
			answers: [
				{ kind: "selection", selections: ["A"] },
				null,
				{ kind: "freeform", text: "own words" },
			],
		});
		expect(answeredCount(request, state)).toBe(2);
		expect(canSubmit(request, state)).toBe(true);
	});

	it("cannot submit a request with nothing answered", () => {
		const request = questionRequest([question({ options: [{ title: "A" }] })]);
		const state = initialQuestionState(request);
		expect(answeredCount(request, state)).toBe(0);
		expect(canSubmit(request, state)).toBe(false);
	});

	it("clamps the step to the questions the batch has and keeps the same state when nothing moves", () => {
		const request = questionRequest([question(), question(), question()]);
		const state = initialQuestionState(request);
		expect(setStep(state, 9, 3).step).toBe(2);
		expect(setStep(state, -4, 3).step).toBe(0);
		expect(setStep(state, 0, 3)).toBe(state);
	});
});
