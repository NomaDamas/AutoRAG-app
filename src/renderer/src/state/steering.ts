/**
 * Steering a running AI Search. A message sent while a run streams corrects
 * that run (Enter) or waits as the next question (⌥Enter); the librarian
 * delivers a steer before the run's next model request. The panel shows each
 * steer as a user bubble that pulses until a model request takes it.
 */
import type { ChatMessage, ChatMessageAssistant, ChatMessageUser, SteerTiming } from "../../../shared/search-contract";

export type ComposerAction = "ask" | "steer" | "queue";

/** What sending the composer does: a new question when idle, else steer (Enter) or queue (⌥Enter). */
export function composerAction({ searching, altKey }: { readonly searching: boolean; readonly altKey: boolean }): ComposerAction {
	if (!searching) return "ask";
	return altKey ? "queue" : "steer";
}

export interface SteerItem {
	readonly id: string;
	readonly text: string;
	readonly timing: SteerTiming;
	/** pending: sent, no model request took it yet; delivered: the model has it; dropped: the run ended first. */
	readonly status: "pending" | "delivered" | "dropped";
}

/** A model request took every steer sent so far. Returns the same list when none was waiting. */
export function deliverSteers(items: readonly SteerItem[]): readonly SteerItem[] {
	if (!items.some((item) => item.status === "pending")) return items;
	return items.map((item) => (item.status === "pending" ? { ...item, status: "delivered" } : item));
}

/** The run ended (answered, failed, or stopped): a steer still waiting will never reach it. */
export function settleSteers(items: readonly SteerItem[]): readonly SteerItem[] {
	if (!items.some((item) => item.status === "pending")) return items;
	return items.map((item) => (item.status === "pending" ? { ...item, status: "dropped" } : item));
}

/** A stored chat: its question, the steers its run took, and its answer. */
export function restoreChat(messages: readonly ChatMessage[]): {
	readonly question: ChatMessageUser | null;
	readonly steers: readonly SteerItem[];
	readonly assistant: ChatMessageAssistant | null;
} {
	let question: ChatMessageUser | null = null;
	const steers: SteerItem[] = [];
	let assistant: ChatMessageAssistant | null = null;
	for (const message of messages) {
		if (message.role === "assistant") assistant = message;
		else if (message.steer === undefined) question = message;
		// A stored steer was accepted by its run, which then answered with it.
		else steers.push({ id: message.at, text: message.text, timing: message.steer, status: "delivered" });
	}
	return { question, steers, assistant };
}
