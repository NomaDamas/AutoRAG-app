/**
 * The inspector's AI chat: AI Search shown beside the file list instead of in
 * its own tab. It is not a second kind of conversation. A chat the inspector
 * starts is an ordinary AI Search chat with an ordinary `chatId`: the main
 * process stores it in the same history, it carries the same title rules, and
 * ⤢ opens the same chat in an AI Search tab, where it continues.
 *
 * Each folder tab holds at most one inspector chat: the one it last showed.
 * A question typed in the Info view always starts a new chat about the
 * selection; "이어서 대화" goes back to the tab's chat as it was, and the chat
 * view's own composer continues it. The chat view's title opens the recent AI
 * Search history, so any earlier chat can become the tab's chat again.
 *
 * In the chat view the selection is context, not a filter: each item is
 * attached to the next question only the first time it enters the chat, so
 * asking again about the same file, or coming back to a file the chat already
 * has, attaches nothing. The Info view's composer only types: it shows no
 * attachment cards.
 *
 * The inspector lets go of its chat (the chat itself stays in history) on New
 * chat and when the tab closes. Changing the selection, moving between
 * folders, and going back to the Info view keep it.
 */

import type { AnswerPhase, ChatAttachment, ChatMessage } from "../../../shared/search-contract";
import { restoreChat } from "./steering";

export interface InspectorTurn {
	readonly question: string;
	/** Files the question brought into the chat: the selection's items that were new to it. */
	readonly attachments: readonly ChatAttachment[];
	/** The latest answer phase that arrived: Deep when there is one, else Quick. */
	readonly answer: AnswerPhase | null;
	/** Answer text streamed so far, before `answer` lands. */
	readonly draft: string;
	/** What the agent says it is doing (its note before a tool call); shown with the shimmer until an answer phase lands. */
	readonly progress: string;
	readonly error: string | null;
	readonly stopped: boolean;
}

export interface InspectorChat {
	readonly chatId: string;
	readonly turns: readonly InspectorTurn[];
	/** Epoch ms of the last question or answer, here or in the AI Search tab showing the same chat. */
	readonly updatedAt: number;
	/** The stored chat's title, for a chat opened from the history menu; a chat started here shows the selection. */
	readonly title?: string;
}

export interface InspectorChatTab {
	readonly chat: InspectorChat | null;
	readonly mode: "info" | "chat";
	/** Epoch ms the person last had the chat in front of them; an answer that landed after it is still unread. */
	readonly seenAt: number;
	/** The items the person removed from the next question with the attachment cards' ×. */
	readonly dismissed: readonly string[];
}

export const EMPTY_INSPECTOR_CHAT_TAB: InspectorChatTab = { chat: null, mode: "info", seenAt: 0, dismissed: [] };

export type AgeUnit = "now" | "minutes" | "hours" | "days" | "months" | "years";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago `at` was, in the largest whole unit: "이어서 대화 · 5분 전", "· 2시간 전", "· 3일 전", "· 1달 전", "· 1년 전". */
export function relativeAge(at: number, now: number): { readonly unit: AgeUnit; readonly count: number } {
	const elapsed = Math.max(0, now - at);
	if (elapsed < MINUTE) return { unit: "now", count: 0 };
	if (elapsed < HOUR) return { unit: "minutes", count: Math.floor(elapsed / MINUTE) };
	if (elapsed < DAY) return { unit: "hours", count: Math.floor(elapsed / HOUR) };
	const days = Math.floor(elapsed / DAY);
	if (days < 30) return { unit: "days", count: days };
	if (days < 365) return { unit: "months", count: Math.floor(days / 30) };
	return { unit: "years", count: Math.floor(days / 365) };
}

/** An answer landed in the tab's chat since the person last looked at it: "이어서 대화" carries a dot. */
export function hasUnreadAnswer(tab: InspectorChatTab): boolean {
	return tab.chat !== null && tab.mode === "info" && tab.chat.updatedAt > tab.seenAt;
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
			progress: "",
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
