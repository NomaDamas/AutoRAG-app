import { describe, expect, it } from "vitest";
import { createAskUserTool } from "../src/main/ask-user-tool";
import type { RunInteraction } from "../src/main/host-ui";
import type { InteractionAnswer } from "../src/shared/interaction-contract";

type Body = Parameters<RunInteraction["open"]>[0];

function bound(answer: InteractionAnswer | ((body: Body, signal?: AbortSignal) => Promise<InteractionAnswer>)): {
	run: RunInteraction;
	opened: Body[];
} {
	const opened: Body[] = [];
	return {
		opened,
		run: {
			open: async (body, signal) => {
				opened.push(body);
				return typeof answer === "function" ? answer(body, signal) : answer;
			},
		},
	};
}

async function ask(run: RunInteraction | undefined, params: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
	const tool = createAskUserTool(() => run);
	const result = await tool.execute("call-1", params as never, signal);
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

describe("ask_user tool", () => {
	it("is the tool the librarian's prompt describes: named ask_user, with a question and optional choices", () => {
		const tool = createAskUserTool(() => undefined);
		expect(tool.name).toBe("ask_user");
		expect(tool.parameters).toMatchObject({
			properties: {
				question: expect.anything(),
				questions: expect.anything(),
				context: expect.anything(),
				options: expect.anything(),
				allowMultiple: expect.anything(),
				allowFreeform: expect.anything(),
			},
		});
	});

	it("opens one question with its options and tells the model which one the person picked", async () => {
		const { run, opened } = bound({ kind: "question", answers: [{ kind: "selection", selections: ["Q4"] }] });
		const text = await ask(run, {
			question: "Which report?",
			context: "Found two",
			options: [{ title: "Q3" }, { title: "Q4", description: "latest" }, "Q5"],
		});

		expect(text).toBe("User answered: Q4");
		expect(opened).toEqual([
			{
				kind: "question",
				questions: [
					{
						question: "Which report?",
						context: "Found two",
						options: [{ title: "Q3" }, { title: "Q4", description: "latest" }, { title: "Q5" }],
						allowMultiple: false,
						allowFreeform: true,
					},
				],
			},
		]);
	});

	it("reports several picks joined, and a written answer as typed", async () => {
		const many = bound({ kind: "question", answers: [{ kind: "selection", selections: ["A", "B"] }] });
		expect(await ask(many.run, { question: "Which?", options: ["A", "B"], allowMultiple: true })).toBe("User answered: A, B");
		const written = bound({ kind: "question", answers: [{ kind: "freeform", text: "the blue one" }] });
		expect(await ask(written.run, { question: "Which?", options: ["A"] })).toBe("User answered: the blue one");
	});

	it("asks an open question as text only", async () => {
		const { run, opened } = bound({ kind: "question", answers: [{ kind: "freeform", text: "Ada" }] });
		expect(await ask(run, { question: "Your name?" })).toBe("User answered: Ada");
		expect(opened[0]).toMatchObject({ questions: [{ options: [], allowFreeform: true }] });
	});

	it("says the person cancelled, without inventing an answer", async () => {
		const { run } = bound({ kind: "cancel" });
		expect(await ask(run, { question: "Which?", options: ["A"] })).toBe("User cancelled the question");
		const skipped = bound({ kind: "question", answers: [null] });
		expect(await ask(skipped.run, { question: "Which?", options: ["A"] })).toBe("User cancelled the question");
	});

	it("asks 2-4 independent questions together and reports each answer, with skipped ones marked", async () => {
		const { run, opened } = bound({
			kind: "question",
			answers: [{ kind: "selection", selections: ["PDF"] }, null],
		});
		const text = await ask(run, {
			question: "Before I organize",
			questions: [
				{ question: "Which format?", options: ["PDF", "DOCX"], allowFreeform: false },
				{ question: "Which folder?" },
			],
		});

		expect(opened[0]).toMatchObject({
			kind: "question",
			heading: "Before I organize",
			questions: [{ question: "Which format?" }, { question: "Which folder?" }],
		});
		expect(text).toBe(
			["Before I organize", "User answered 1 of 2 questions:", "1. Which format? → PDF", "2. Which folder? → (skipped)"].join("\n"),
		);
		const cancelled = bound({ kind: "cancel" });
		expect(
			await ask(cancelled.run, { questions: [{ question: "One?", options: ["a"] }, { question: "Two?", options: ["b"] }] }),
		).toBe("User cancelled the questions");
	});

	it("rejects calls the model has to correct, with a message that says how", async () => {
		const { run } = bound({ kind: "cancel" });
		await expect(ask(run, {})).rejects.toThrow(/question/);
		await expect(ask(run, { question: "Which?", options: [{ nonsense: true }] })).rejects.toThrow(/malformed/);
		await expect(ask(run, { questions: [{ question: "Only one?" }] })).rejects.toThrow(/2-4/);
		const five = Array.from({ length: 5 }, (_, index) => ({ question: `Q${index}?` }));
		await expect(ask(run, { questions: five })).rejects.toThrow(/at most 4/);
		await expect(
			ask(run, { questions: [{ question: "Same?" }, { question: "same?" }] }),
		).rejects.toThrow(/distinct/);
		await expect(ask(run, { question: "Which?", questions: [{ question: "A?" }, { question: "B?" }], options: ["x"] })).rejects.toThrow(/top level/);
	});

	it("fails with a reason when no run is bound, so the model decides for itself instead of waiting", async () => {
		await expect(ask(undefined, { question: "Which?" })).rejects.toThrow(/nobody|no one|no person/i);
	});

	it("closes the question when the run is stopped or the timeout passes", async () => {
		const stopped = new AbortController();
		const waiting = bound(
			(_body, signal) =>
				new Promise<InteractionAnswer>((resolve) => {
					signal?.addEventListener("abort", () => resolve({ kind: "cancel" }), { once: true });
				}),
		);
		const pending = ask(waiting.run, { question: "Which?", options: ["A"] }, stopped.signal);
		stopped.abort();
		expect(await pending).toBe("User cancelled the question");

		const timed = bound(
			(_body, signal) =>
				new Promise<InteractionAnswer>((resolve) => {
					signal?.addEventListener("abort", () => resolve({ kind: "cancel" }), { once: true });
				}),
		);
		expect(await ask(timed.run, { question: "Which?", options: ["A"], timeout: 20 })).toBe("User cancelled the question");
	});
});
