import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * What a chat's conversation does to the model's view of it (issue #389), as the AI Search panel needs to show it.
 *
 * pi summarises the earlier turns when the conversation no longer fits the model: on its own when the context crosses
 * its threshold, and after a request the provider refused as too long, which it then retries once. The librarian's
 * context guard then holds every request to the model's budget (after such a refusal, to half the refused request) by
 * cutting the largest content, the newest tool result included; the session keeps it whole, only the request is cut.
 */
export type ContextEvent =
	/** pi began summarising the earlier turns. */
	| { readonly type: "compaction_start" }
	/** The summary replaced the earlier turns (`compacted`), or pi could not write it, or it was stopped. */
	| { readonly type: "compaction_end"; readonly compacted: boolean }
	/**
	 * A model request carried only part of these messages: tool results by call id, and user messages (a question's
	 * prompt holds the baseline evidence searched for it) by timestamp.
	 */
	| { readonly type: "request_cut"; readonly toolCallIds: readonly string[]; readonly userMessages: readonly number[] };

function textLength(message: AgentMessage): number {
	if (message.role !== "user" && message.role !== "toolResult") return 0;
	if (typeof message.content === "string") return message.content.length;
	let length = 0;
	for (const block of message.content) if (block.type === "text") length += block.text.length;
	return length;
}

/** The text length of each user message by timestamp; a timestamp two messages share (seeded turns do) maps to `null`. */
function userLengths(messages: readonly AgentMessage[]): Map<number, number | null> {
	const lengths = new Map<number, number | null>();
	for (const message of messages) {
		if (message.role === "user") lengths.set(message.timestamp, lengths.has(message.timestamp) ? null : textLength(message));
	}
	return lengths;
}

/**
 * The tool results and user messages `sent` carries less text of than the conversation (`held`) has. Every other step
 * before a request only adds (memory, steer framing, an image's stand-in text), so a shorter one was cut. A tool result
 * is paired by its call id; a user message by its timestamp, and only where that timestamp names one message on each
 * side, so two messages of one millisecond are never compared with each other.
 */
export function cutMessages(held: readonly AgentMessage[], sent: readonly AgentMessage[]): { toolCallIds: string[]; userMessages: number[] } {
	const tools = new Map<string, number>();
	for (const message of held) if (message.role === "toolResult") tools.set(message.toolCallId, textLength(message));
	const toolCallIds: string[] = [];
	for (const message of sent) {
		if (message.role !== "toolResult") continue;
		const whole = tools.get(message.toolCallId);
		if (whole !== undefined && textLength(message) < whole) toolCallIds.push(message.toolCallId);
	}
	const heldUsers = userLengths(held);
	const userMessages: number[] = [];
	for (const [timestamp, length] of userLengths(sent)) {
		const whole = heldUsers.get(timestamp);
		if (length !== null && whole !== undefined && whole !== null && length < whole) userMessages.push(timestamp);
	}
	return { toolCallIds, userMessages };
}

/**
 * Reports `session`'s {@link ContextEvent}s to `report` until the returned stop function runs.
 *
 * Compaction comes from the session's own events. What a request carries is only seen at the agent's context step,
 * where the extensions' context handlers (the guard among them) and pi's own projections have all run; so that step is
 * wrapped here, the way pi wraps it for its projections, and passes every request on unchanged.
 */
export function watchContext(session: AgentSession, report: (event: ContextEvent) => void): () => void {
	let watching = true;
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "compaction_start") report({ type: "compaction_start" });
		else if (event.type === "compaction_end") report({ type: "compaction_end", compacted: event.result !== undefined });
	});
	const agent = session.agent;
	const previous = agent.transformContext;
	agent.transformContext = async (messages, signal) => {
		const sent = previous === undefined ? messages : await previous(messages, signal);
		if (watching) {
			const cut = cutMessages(messages, sent);
			if (cut.toolCallIds.length > 0 || cut.userMessages.length > 0) report({ type: "request_cut", ...cut });
		}
		return sent;
	};
	return () => {
		watching = false;
		unsubscribe();
	};
}
