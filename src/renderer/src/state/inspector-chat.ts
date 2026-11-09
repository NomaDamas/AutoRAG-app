/**
 * The inspector's AI chat: AI Search shown beside the file list instead of in
 * its own tab. It is not a second kind of conversation. A chat the inspector
 * starts is an ordinary AI Search chat with an ordinary `chatId`: the main
 * process stores it in the same history, it carries the same title rules, and
 * ⤢ opens the same chat in an AI Search tab, where it continues.
 *
 * Each folder tab holds at most one inspector chat. The selection (one file,
 * or every file of a multi-selection) is context, not a filter: each item is
 * attached to the next question only the first time it enters the chat, so
 * asking again about the same file, or coming back to a file the chat already
 * has, attaches nothing. The Info view's composer only types: it shows no
 * attachment cards, and adding files means selecting them together or going
 * to the chat view, whose composer shows the cards with their ×.
 *
 * The inspector lets go of its chat (the chat itself stays in history) on New
 * chat, after {@link INSPECTOR_CHAT_IDLE_MS} without a question, and when the
 * tab closes. Changing the selection, moving between folders, and going back
 * to the Info view keep it.
 */

import type { AnswerPhase, ChatAttachment, ChatMessage } from "../../../shared/search-contract";
import { restoreChat } from "./steering";

/** A chat with no question for this long is no longer the inspector's: the next question starts a new one. */
export const INSPECTOR_CHAT_IDLE_MS = 30 * 60_000;

export interface InspectorTurn {
	readonly question: string;
	/** Files the question brought into the chat: the selection's items that were new to it. */
	readonly attachments: readonly ChatAttachment[];
	/** The latest answer phase that arrived: Deep when there is one, else Quick. */
	readonly answer: AnswerPhase | null;
	/** Answer text streamed so far, before `answer` lands. */
	readonly draft: string;
	readonly error: string | null;
	readonly stopped: boolean;
}

export interface InspectorChat {
	readonly chatId: string;
	readonly turns: readonly InspectorTurn[];
	/** Epoch ms of the last question or answer, here or in the AI Search tab showing the same chat. */
	readonly updatedAt: number;
}

export interface InspectorChatTab {
	readonly chat: InspectorChat | null;
	readonly mode: "info" | "chat";
	/** The chat was let go for being idle: the Info view points at the history once. */
	readonly expired: boolean;
	/** The items the person removed from the next question with the attachment cards' ×. */
	readonly dismissed: readonly string[];
}

export const EMPTY_INSPECTOR_CHAT_TAB: InspectorChatTab = { chat: null, mode: "info", expired: false, dismissed: [] };

/** The tab as it should be shown at `now`: an idle chat that is not running is let go. */
export function liveInspectorTab(tab: InspectorChatTab, now: number, running: boolean): InspectorChatTab {
	if (tab.chat === null || running || now - tab.chat.updatedAt <= INSPECTOR_CHAT_IDLE_MS) return tab;
	return { chat: null, mode: "info", expired: true, dismissed: [] };
}

/** Every local file and folder the chat has been given so far. */
export function chatContext(chat: InspectorChat | null): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const turn of chat?.turns ?? []) for (const att of turn.attachments) ids.add(att.id);
	return ids;
}

/**
 * What the next question carries of `targets` (the selection): the items the chat does not have yet and the person
 * did not take off with ×. A first question always carries the whole selection.
 */
export function pendingAttachments(tab: InspectorChatTab, targets: readonly ChatAttachment[]): readonly ChatAttachment[] {
	if (tab.chat === null) return targets;
	const context = chatContext(tab.chat);
	return targets.filter((target) => !tab.dismissed.includes(target.id) && !context.has(target.id));
}

/** The stored chat as inspector turns: the latest phase of each answer. */
export function turnsFromHistory(messages: readonly ChatMessage[]): readonly InspectorTurn[] {
	return restoreChat(messages).map((turn) => {
		const answer = turn.assistant?.deep ?? turn.assistant?.quick ?? null;
		return {
			question: turn.question.text,
			attachments: turn.question.attachments,
			answer,
			draft: answer?.answer ?? "",
			error: null,
			stopped: turn.assistant?.stopped ?? false,
		};
	});
}

/** Replace the chat's last turn. */
export function updateLastTurn(chat: InspectorChat, change: (turn: InspectorTurn) => InspectorTurn): InspectorChat {
	const last = chat.turns[chat.turns.length - 1];
	if (last === undefined) return chat;
	return { ...chat, turns: [...chat.turns.slice(0, -1), change(last)] };
}

/** How many questions the chat holds. */
export function questionCount(chat: InspectorChat | null): number {
	return chat?.turns.length ?? 0;
}
