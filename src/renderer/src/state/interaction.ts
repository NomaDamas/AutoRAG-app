/**
 * Pure state for the interaction dock (librarian v2.12): the open-request queue
 * a panel holds for its searches, the answer state machine for `ask_user`
 * questions, and the label/scope helpers for the file-change gate.
 *
 * No React and no JSX here (the dock's icons and layout live in
 * `components/InteractionDock.tsx`), so the queue semantics, the answer shape,
 * and the gate's label selection are all covered by unit tests.
 */

import {
	type ApprovalChoice,
	type ApprovalMode,
	type ApprovalRequest,
	type ChangeCategory,
	type InteractionAnswer,
	type InteractionRequest,
	type Question,
	type QuestionAnswer,
	type QuestionRequest,
} from "../../../shared/interaction-contract";

// ------------------------------------------------------------ request queue

/** Open interaction requests, oldest first. A search shows its own head while later ones wait. */
export type InteractionQueue = readonly InteractionRequest[];

export const EMPTY_QUEUE: InteractionQueue = [];

/**
 * Add a request unless the queue already holds its id. `onRequest` can replay a
 * request `pending()` already delivered, and a new request repeats neither.
 */
export function openRequest(queue: InteractionQueue, request: InteractionRequest): InteractionQueue {
	return queue.some((open) => open.id === request.id) ? queue : [...queue, request];
}

/** Fold the requests `pending()` reports into the queue, id-deduped, order preserved. */
export function mergePending(queue: InteractionQueue, requests: readonly InteractionRequest[]): InteractionQueue {
	let next = queue;
	for (const request of requests) next = openRequest(next, request);
	return next;
}

/** Drop a request by id: it was answered, cancelled, or its run ended first. */
export function closeRequest(queue: InteractionQueue, id: string): InteractionQueue {
	return queue.some((open) => open.id === id) ? queue.filter((open) => open.id !== id) : queue;
}

/** The request one search shows: the oldest still open for it, else null. */
export function frontRequest(queue: InteractionQueue, searchId: string): InteractionRequest | null {
	return queue.find((open) => open.searchId === searchId) ?? null;
}

// ------------------------------------------------------------- mode labels

export type ModeLabelKey = "interaction.mode.ask.label" | "interaction.mode.auto.label" | "interaction.mode.full.label";

export type ModeDescriptionKey = "interaction.mode.ask.desc" | "interaction.mode.auto.desc" | "interaction.mode.full.desc";

export function modeLabelKey(mode: ApprovalMode): ModeLabelKey {
	return `interaction.mode.${mode}.label`;
}

export function modeDescriptionKey(mode: ApprovalMode): ModeDescriptionKey {
	return `interaction.mode.${mode}.desc`;
}

// --------------------------------------------------------- approval labels

export type ApprovalHeadlineKey =
	| "interaction.approval.headlineChange"
	| "interaction.approval.headlineRun"
	| "interaction.approval.headlineUnclassified";

export type SessionAllowKey =
	| "interaction.allowSession.categories"
	| "interaction.allowSession.unclassified"
	| "interaction.allowSession.all";

export type CategoryKey = `interaction.category.${ChangeCategory}`;

/**
 * The card's headline. `sessionScope` is `all` only in `ask`, where nothing was
 * classified on purpose: the question is whether the call may run at all.
 * `unclassified` is a call the judgement model could not read (unreachable, no
 * credential): nothing is known about it, so the card must not claim it changes
 * files. Otherwise the gate flagged a change to existing files and asks whether
 * it may proceed.
 */
export function approvalHeadlineKey(request: ApprovalRequest): ApprovalHeadlineKey {
	switch (request.sessionScope) {
		case "all":
			return "interaction.approval.headlineRun";
		case "unclassified":
			return "interaction.approval.headlineUnclassified";
		case "categories":
			return "interaction.approval.headlineChange";
	}
}

/** What "allow for this session" covers, as the label key for that scope. */
export function sessionAllowKey(request: ApprovalRequest): SessionAllowKey {
	switch (request.sessionScope) {
		case "categories":
			return "interaction.allowSession.categories";
		case "unclassified":
			return "interaction.allowSession.unclassified";
		case "all":
			return "interaction.allowSession.all";
	}
}

/** The translated chip label for one change category the gate flagged. */
export function categoryKey(category: ChangeCategory): CategoryKey {
	return `interaction.category.${category}`;
}

/**
 * The gate's `reason` is English model text. In `ask` (`sessionScope: "all"`) it
 * only names the tool, so it is noise beside the call that already shows it; the
 * judgement model's reason in `auto` is the sentence worth reading. For a call
 * that could not be classified the reason is a configuration or transport error
 * (a missing key, a timeout), never a sentence for the person: it is replaced by
 * {@link approvalNoteKey}. Never show an empty line.
 */
export function approvalReasonVisible(request: ApprovalRequest): boolean {
	const reason = request.reason.trim();
	return reason.length > 0 && request.sessionScope === "categories" && reason !== request.call.trim();
}

/** The app's own sentence for why a call could not be classified; null when the card has nothing to add. */
export function approvalNoteKey(request: ApprovalRequest): "interaction.approval.noteUnclassified" | null {
	return request.sessionScope === "unclassified" ? "interaction.approval.noteUnclassified" : null;
}

// ------------------------------------------------------------ answer shapes

/** One stable value for the person's dismissal, so a dock keyed on a request can reuse it. */
export const CANCEL_ANSWER: InteractionAnswer = { kind: "cancel" };

export function cancelAnswer(): InteractionAnswer {
	return CANCEL_ANSWER;
}

export function approvalAnswer(choice: ApprovalChoice, note?: string): InteractionAnswer {
	return note === undefined ? { kind: "approval", choice } : { kind: "approval", choice, note };
}

export function allowOnceAnswer(): InteractionAnswer {
	return approvalAnswer("allow-once");
}

export function allowSessionAnswer(): InteractionAnswer {
	return approvalAnswer("allow-session");
}

export function denyAnswer(): InteractionAnswer {
	return approvalAnswer("deny");
}

/** `deny-with-note`; an empty note is allowed, so it is only trimmed, never required. */
export function denyWithNoteAnswer(note: string): InteractionAnswer {
	return approvalAnswer("deny-with-note", note.trim());
}

// ------------------------------------------------- question answer machine

export interface QuestionDraft {
	/** Titles picked so far; a single-choice question holds at most one. */
	readonly selections: readonly string[];
	readonly freeform: string;
	/** The "Write your own answer" row is expanded (a question with no options starts expanded). */
	readonly freeformOpen: boolean;
}

export interface QuestionState {
	/** Index of the question the batch shows. */
	readonly step: number;
	/** One draft per question of the request, in order. */
	readonly drafts: readonly QuestionDraft[];
}

const EMPTY_DRAFT: QuestionDraft = { selections: [], freeform: "", freeformOpen: false };

export function initialQuestionState(request: QuestionRequest): QuestionState {
	return {
		step: 0,
		drafts: request.questions.map((question) => (question.options.length === 0 ? { ...EMPTY_DRAFT, freeformOpen: true } : EMPTY_DRAFT)),
	};
}

function updateDraft(state: QuestionState, index: number, change: (draft: QuestionDraft) => QuestionDraft): QuestionState {
	return { ...state, drafts: state.drafts.map((draft, position) => (position === index ? change(draft) : draft)) };
}

/** Pick an option: a multiple-choice question toggles the pick, a single-choice one replaces it. */
export function selectOption(state: QuestionState, question: Question, index: number, title: string): QuestionState {
	return updateDraft(state, index, (draft) => {
		if (!question.allowMultiple) return { ...draft, selections: [title] };
		const selected = draft.selections.includes(title);
		return { ...draft, selections: selected ? draft.selections.filter((item) => item !== title) : [...draft.selections, title] };
	});
}

export function setFreeform(state: QuestionState, index: number, text: string): QuestionState {
	return updateDraft(state, index, (draft) => ({ ...draft, freeform: text }));
}

export function setFreeformOpen(state: QuestionState, index: number, open: boolean): QuestionState {
	return updateDraft(state, index, (draft) => ({ ...draft, freeformOpen: open }));
}

/** Move the batch's step, clamped to the questions it has. */
export function setStep(state: QuestionState, step: number, count: number): QuestionState {
	const clamped = Math.max(0, Math.min(step, Math.max(0, count - 1)));
	return clamped === state.step ? state : { ...state, step: clamped };
}

export function draftAt(state: QuestionState, index: number): QuestionDraft {
	return state.drafts[index] ?? EMPTY_DRAFT;
}

/**
 * One question's answer: a typed answer wins over a pick (the freeform row is an
 * alternative), a pick is returned in the order the question lists its options,
 * and an untouched question is null (a skipped question in a batch). An empty
 * freeform text is never sent.
 */
export function draftAnswer(question: Question, draft: QuestionDraft): QuestionAnswer | null {
	const text = draft.freeform.trim();
	if (text.length > 0) return { kind: "freeform", text };
	const ordered = question.options.filter((option) => draft.selections.includes(option.title)).map((option) => option.title);
	return ordered.length > 0 ? { kind: "selection", selections: ordered } : null;
}

/** The request's answer: one entry per question, in order, `null` for a skipped question. */
export function buildAnswer(request: QuestionRequest, state: QuestionState): InteractionAnswer {
	return { kind: "question", answers: request.questions.map((question, index) => draftAnswer(question, draftAt(state, index))) };
}

/** How many of the request's questions hold an answer. */
export function answeredCount(request: QuestionRequest, state: QuestionState): number {
	return request.questions.reduce((count, question, index) => (draftAnswer(question, draftAt(state, index)) === null ? count : count + 1), 0);
}

/** Whether the explicit Submit may send at all: at least one question answered. */
export function canSubmit(request: QuestionRequest, state: QuestionState): boolean {
	return answeredCount(request, state) > 0;
}
