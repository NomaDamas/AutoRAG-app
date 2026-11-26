/**
 * Steering a running AI Search. A message sent while a run streams is sorted (`sortFollowUp`) into a correction of
 * that run or the next question; ⌥Enter makes it the next question outright. A correction is held for a few seconds
 * before it is sent, since a sent one cannot be taken back; the librarian delivers it before the run's next model
 * request.
 */
import type { ChatMessage, ChatMessageAssistant, ChatMessageUser, FollowUpKind, SteerTiming } from "../../../shared/search-contract";

export type ComposerAction = "ask" | "steer" | "queue";

/** What sending the composer does: a new question when idle, else sort and perhaps steer (Enter) or queue (⌥Enter). */
export function composerAction({ searching, altKey }: { readonly searching: boolean; readonly altKey: boolean }): ComposerAction {
	if (!searching) return "ask";
	return altKey ? "queue" : "steer";
}

export interface SteerItem {
	readonly id: string;
	readonly text: string;
	readonly timing: SteerTiming;
	/** held: not sent yet, it can still be postponed or cancelled; pending: sent, no model request took it yet; delivered: the model has it; dropped: the run ended first. */
	readonly status: "held" | "pending" | "delivered" | "dropped";
}

/** A model request took every steer sent so far. Returns the same list when none was waiting. */
export function deliverSteers(items: readonly SteerItem[]): readonly SteerItem[] {
	if (!items.some((item) => item.status === "pending")) return items;
	return items.map((item) => (item.status === "pending" ? { ...item, status: "delivered" } : item));
}

/** The run ended (answered, failed, or stopped): a steer sent but not taken will never reach it. A held one was never sent: the caller moves it. */
export function settleSteers(items: readonly SteerItem[]): readonly SteerItem[] {
	if (!items.some((item) => item.status === "pending")) return items;
	return items.map((item) => (item.status === "pending" ? { ...item, status: "dropped" } : item));
}

/** How long a correction stays in the app, where it can still be postponed or cancelled. */
export const STEER_HOLD_MS = 3_000;
/** A sort that has not answered by now counts as the next question. */
export const SORT_TIMEOUT_MS = 8_000;

/**
 * What to do with a message sent during a run: `next` as soon as that is known (also when the sort fails or takes too
 * long), `steer` only once the hold has passed, so the person has had their chance to stop it.
 */
export async function sortFollowUp(classify: () => Promise<FollowUpKind>): Promise<FollowUpKind> {
	const after = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
	const held = after(STEER_HOLD_MS);
	const kind = await Promise.race([
		Promise.resolve().then(classify).catch((): FollowUpKind => "next"),
		after(SORT_TIMEOUT_MS).then((): FollowUpKind => "next"),
	]);
	if (kind === "steer") await held;
	return kind;
}

/** One stored turn: its question, the steers its run took, and its answer (null while unanswered). */
export interface RestoredTurn {
	readonly question: ChatMessageUser;
	readonly steers: readonly SteerItem[];
	readonly assistant: ChatMessageAssistant | null;
}

/** A stored chat split into its turns, oldest first. A turn starts at each user message that is not a steer. */
export function restoreChat(messages: readonly ChatMessage[]): readonly RestoredTurn[] {
	const turns: { question: ChatMessageUser; steers: SteerItem[]; assistant: ChatMessageAssistant | null }[] = [];
	for (const message of messages) {
		const turn = turns[turns.length - 1];
		if (message.role === "user" && message.steer === undefined) {
			turns.push({ question: message, steers: [], assistant: null });
		} else if (turn === undefined) {
			continue;
		} else if (message.role === "assistant") {
			turn.assistant = message;
		} else if (message.steer !== undefined) {
			// A stored steer was accepted by its run, which then answered with it.
			turn.steers.push({ id: message.at, text: message.text, timing: message.steer, status: "delivered" });
		}
	}
	return turns;
}
