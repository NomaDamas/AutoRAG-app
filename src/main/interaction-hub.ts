import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
	type ApprovalRequest,
	type InteractionAnswer,
	type InteractionClosed,
	type InteractionRequest,
	type Question,
	type QuestionAnswer,
	type QuestionRequest,
} from "../shared/interaction-contract";

/**
 * The open requests of the running searches: what the agent asked the person and has not been answered yet.
 *
 * A request is opened by the agent side (the `ask_user` tool, the file-change gate's dialogs) and resolved by
 * the window's answer, by the person dismissing it, by the run's abort signal, or by the run ending. The hub
 * knows nothing of Electron: the window is reached through the two `emit` callbacks.
 */

export type RequestBody = Omit<QuestionRequest, "id" | "searchId"> | Omit<ApprovalRequest, "id" | "searchId">;

export interface InteractionHubDeps {
	readonly emitRequest: (request: InteractionRequest) => void;
	readonly emitClosed: (event: InteractionClosed) => void;
	readonly newId?: () => string;
}

export interface InteractionHub {
	/** Opens a request for run `searchId`. Resolves with the answer, or `{ kind: "cancel" }` when it was dismissed or closed unanswered. */
	open(searchId: string, body: RequestBody, signal?: AbortSignal): Promise<InteractionAnswer>;
	/**
	 * The window's answer, which arrives over IPC and is checked here. False when the request is gone or the answer
	 * does not fit it (the request then stays open).
	 */
	answer(id: string, answer: unknown): boolean;
	pending(): readonly InteractionRequest[];
	/** Closes every open request of a run, unanswered. */
	closeRun(searchId: string, reason: "cancelled" | "ended"): void;
}

interface Open {
	readonly request: InteractionRequest;
	readonly resolve: (answer: InteractionAnswer) => void;
	readonly dispose: () => void;
}

const CANCEL: InteractionAnswer = { kind: "cancel" };

const questionAnswerSchema = Type.Union([
	Type.Object({ kind: Type.Literal("selection"), selections: Type.Array(Type.String()), comment: Type.Optional(Type.String()) }),
	Type.Object({ kind: Type.Literal("freeform"), text: Type.String() }),
]);

/** What the window may send back: the contract's {@link InteractionAnswer}, checked at the IPC boundary. */
const answerSchema = Type.Union([
	Type.Object({ kind: Type.Literal("cancel") }),
	Type.Object({
		kind: Type.Literal("approval"),
		choice: Type.Union([Type.Literal("allow-once"), Type.Literal("allow-session"), Type.Literal("deny"), Type.Literal("deny-with-note")]),
		note: Type.Optional(Type.String()),
	}),
	Type.Object({ kind: Type.Literal("question"), answers: Type.Array(Type.Union([questionAnswerSchema, Type.Null()])) }),
]);

function fitsSelection(question: Question, answer: Extract<QuestionAnswer, { kind: "selection" }>): boolean {
	const picks = answer.selections;
	if (picks.length === 0) return false;
	if (!question.allowMultiple && picks.length !== 1) return false;
	// A pick is an offered title; the person's own words arrive as a freeform answer, never as a selection.
	return picks.every((pick) => question.options.some((option) => option.title === pick));
}

function fitsQuestion(question: Question, answer: QuestionAnswer | null): boolean {
	if (answer === null) return true;
	if (answer.kind === "selection") return fitsSelection(question, answer);
	return (question.allowFreeform || question.options.length === 0) && answer.text.trim() !== "";
}

function fits(request: InteractionRequest, answer: InteractionAnswer): boolean {
	if (answer.kind === "cancel") return true;
	if (request.kind === "approval") return answer.kind === "approval";
	if (answer.kind !== "question" || answer.answers.length !== request.questions.length) return false;
	return request.questions.every((question, index) => fitsQuestion(question, answer.answers[index] ?? null));
}

export function createInteractionHub(deps: InteractionHubDeps): InteractionHub {
	const open = new Map<string, Open>();
	const newId = deps.newId ?? randomUUID;

	function close(id: string, answer: InteractionAnswer, reason: InteractionClosed["reason"]): void {
		const entry = open.get(id);
		if (entry === undefined) return;
		open.delete(id);
		entry.dispose();
		entry.resolve(answer);
		deps.emitClosed({ id, searchId: entry.request.searchId, reason });
	}

	return {
		open: (searchId, body, signal) => {
			if (signal?.aborted === true) return Promise.resolve(CANCEL);
			const request: InteractionRequest = { ...body, id: newId(), searchId };
			return new Promise<InteractionAnswer>((resolve) => {
				const onAbort = (): void => close(request.id, CANCEL, "cancelled");
				signal?.addEventListener("abort", onAbort, { once: true });
				open.set(request.id, { request, resolve, dispose: () => signal?.removeEventListener("abort", onAbort) });
				deps.emitRequest(request);
			});
		},
		answer: (id, value) => {
			const entry = open.get(id);
			if (entry === undefined || !Value.Check(answerSchema, value) || !fits(entry.request, value)) return false;
			close(id, value, value.kind === "cancel" ? "cancelled" : "answered");
			return true;
		},
		pending: () => [...open.values()].map((entry) => entry.request),
		closeRun: (searchId, reason) => {
			for (const [id, entry] of [...open]) {
				if (entry.request.searchId === searchId) close(id, CANCEL, reason);
			}
		},
	};
}
