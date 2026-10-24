import { describe, expect, it } from "vitest";
import { createInteractionHub } from "../src/main/interaction-hub";
import type { InteractionAnswer, InteractionClosed, InteractionRequest, QuestionRequest } from "../src/shared/interaction-contract";

function harness() {
	const requests: InteractionRequest[] = [];
	const closed: InteractionClosed[] = [];
	let counter = 0;
	const hub = createInteractionHub({
		emitRequest: (request) => requests.push(request),
		emitClosed: (event) => closed.push(event),
		newId: () => `r${++counter}`,
	});
	return { hub, requests, closed };
}

const question = {
	kind: "question",
	questions: [
		{
			question: "Which report?",
			options: [{ title: "Q3" }, { title: "Q4", description: "latest" }],
			allowMultiple: false,
			allowFreeform: false,
		},
	],
} as const;

const approval = {
	kind: "approval",
	reason: "",
	categories: ["delete"],
	call: "rm /tmp/a.pdf",
	sessionScope: "categories",
} as const;

describe("interaction hub", () => {
	it("opens a request for a run, lists it as pending, and resolves with the answer", async () => {
		const { hub, requests, closed } = harness();
		const answered = hub.open("run-1", question);
		expect(requests).toEqual([{ ...question, id: "r1", searchId: "run-1" }]);
		expect(hub.pending()).toHaveLength(1);

		const accepted = hub.answer("r1", { kind: "question", answers: [{ kind: "selection", selections: ["Q4"] }] });

		expect(accepted).toBe(true);
		await expect(answered).resolves.toEqual({ kind: "question", answers: [{ kind: "selection", selections: ["Q4"] }] });
		expect(closed).toEqual([{ id: "r1", searchId: "run-1", reason: "answered" }]);
		expect(hub.pending()).toHaveLength(0);
	});

	it("answers each request once: a second answer, or an unknown id, is refused", async () => {
		const { hub } = harness();
		const done = hub.open("run-1", approval);
		expect(hub.answer("r1", { kind: "approval", choice: "allow-once" })).toBe(true);
		await done;
		expect(hub.answer("r1", { kind: "approval", choice: "deny" })).toBe(false);
		expect(hub.answer("nope", { kind: "approval", choice: "deny" })).toBe(false);
	});

	it("refuses an answer whose shape does not belong to the request, and keeps the request open", () => {
		const { hub } = harness();
		void hub.open("run-1", approval);
		void hub.open("run-1", question);
		expect(hub.answer("r1", { kind: "question", answers: [] })).toBe(false);
		expect(hub.answer("r2", { kind: "approval", choice: "allow-once" })).toBe(false);
		// Wrong count of answers, an option that was never offered, several picks for a single choice, empty text.
		expect(hub.answer("r2", { kind: "question", answers: [] })).toBe(false);
		expect(hub.answer("r2", { kind: "question", answers: [{ kind: "selection", selections: ["Q9"] }] })).toBe(false);
		expect(hub.answer("r2", { kind: "question", answers: [{ kind: "selection", selections: ["Q3", "Q4"] }] })).toBe(false);
		expect(hub.answer("r2", { kind: "question", answers: [{ kind: "freeform", text: "anything" }] })).toBe(false);
		expect(hub.pending().map((request) => request.id)).toEqual(["r1", "r2"]);
	});

	it("accepts free text only where the question allows it, and never an empty one", async () => {
		const { hub } = harness();
		const done = hub.open("run-1", {
			kind: "question",
			questions: [{ question: "Name?", options: [], allowMultiple: false, allowFreeform: true }],
		});
		expect(hub.answer("r1", { kind: "question", answers: [{ kind: "freeform", text: "   " }] })).toBe(false);
		expect(hub.answer("r1", { kind: "question", answers: [{ kind: "freeform", text: " Ada " }] })).toBe(true);
		await expect(done).resolves.toEqual({ kind: "question", answers: [{ kind: "freeform", text: " Ada " }] });
	});

	it("takes several picks for a multiple-choice question and a null for a skipped one", async () => {
		const { hub } = harness();
		const done = hub.open("run-1", {
			kind: "question",
			questions: [
				{ question: "Which?", options: [{ title: "A" }, { title: "B" }], allowMultiple: true, allowFreeform: false },
				{ question: "And?", options: [{ title: "X" }], allowMultiple: false, allowFreeform: false },
			],
		});
		const answer: InteractionAnswer = { kind: "question", answers: [{ kind: "selection", selections: ["A", "B"] }, null] };
		expect(hub.answer("r1", answer)).toBe(true);
		await expect(done).resolves.toEqual(answer);
	});

	it("resolves a dismissal as a cancel and closes it as cancelled", async () => {
		const { hub, closed } = harness();
		const done = hub.open("run-1", question);
		expect(hub.answer("r1", { kind: "cancel" })).toBe(true);
		await expect(done).resolves.toEqual({ kind: "cancel" });
		expect(closed).toEqual([{ id: "r1", searchId: "run-1", reason: "cancelled" }]);
	});

	it("closes every open request of a run when it is stopped, and leaves other runs alone", async () => {
		const { hub, closed } = harness();
		const first = hub.open("run-1", question);
		const second = hub.open("run-1", approval);
		const other = hub.open("run-2", approval);

		hub.closeRun("run-1", "cancelled");

		await expect(first).resolves.toEqual({ kind: "cancel" });
		await expect(second).resolves.toEqual({ kind: "cancel" });
		expect(closed.map((event) => [event.id, event.reason])).toEqual([
			["r1", "cancelled"],
			["r2", "cancelled"],
		]);
		expect(hub.pending().map((request) => request.id)).toEqual(["r3"]);
		hub.answer("r3", { kind: "approval", choice: "deny" });
		await other;
	});

	it("closes a request when its abort signal fires, and never opens one for an aborted signal", async () => {
		const { hub, requests, closed } = harness();
		const controller = new AbortController();
		const done = hub.open("run-1", question, controller.signal);
		controller.abort();
		await expect(done).resolves.toEqual({ kind: "cancel" });
		expect(closed).toEqual([{ id: "r1", searchId: "run-1", reason: "cancelled" }]);

		const aborted = hub.open("run-1", question, AbortSignal.abort());
		await expect(aborted).resolves.toEqual({ kind: "cancel" });
		expect(requests).toHaveLength(1);
	});

	it("tells the window which questions are still open for the run (a panel that mounts late reads them)", () => {
		const { hub } = harness();
		void hub.open("run-1", question);
		void hub.open("run-2", approval);
		const open = hub.pending();
		expect(open.map((request) => [request.id, request.searchId, request.kind])).toEqual([
			["r1", "run-1", "question"],
			["r2", "run-2", "approval"],
		]);
		expect((open[0] as QuestionRequest).questions[0]?.question).toBe("Which report?");
	});
});
