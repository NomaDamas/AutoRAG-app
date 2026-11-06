import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatAttachment, SearchStreamEvent } from "../../../shared/search-contract";
import { summaryRequest, type SummaryLanguage } from "../state/ai-summary";
import {
	EMPTY_INSPECTOR_CHAT_TAB,
	liveInspectorTab,
	turnsFromHistory,
	updateLastTurn,
	type InspectorChat,
	type InspectorChatTab,
} from "../state/inspector-chat";

export interface InspectorChats {
	/** Tab `tabId`'s inspector chat as of `now` (an idle chat already let go). */
	tab(tabId: number, now: number): InspectorChatTab;
	/** The tab whose inspector chat has a run streaming, if any: one run at a time. */
	readonly runningTab: number | null;
	/**
	 * Ask `text` in the tab's chat (starting one when it has none), with `attachment` when the chat lacks it. False when
	 * nothing was sent: another inspector run is still streaming.
	 */
	ask(tabId: number, text: string, attachment: ChatAttachment | null): boolean;
	/** "요약": the summary prompt AI Search uses, about `attachment`. */
	summarize(tabId: number, attachment: ChatAttachment): boolean;
	/** Stop the inspector run that is streaming, whichever tab asked it. */
	stop(): void;
	setMode(tabId: number, mode: "info" | "chat"): void;
	/** × on the attachment card: leave `id` out of the next question. */
	dismiss(tabId: number, id: string): void;
	/** New chat: the inspector lets go of its chat; history keeps it. */
	reset(tabId: number): void;
	/** Re-read the chat from history, so questions asked in an AI Search tab show here too. */
	refresh(tabId: number): void;
	/** Forget the chats of tabs that no longer exist. */
	prune(liveTabIds: readonly number[]): void;
}

const autorag = window.autorag;

/** The window's inspector chats, one per folder tab; see `state/inspector-chat.ts`. */
export function useInspectorChats(language: SummaryLanguage): InspectorChats {
	const [tabs, setTabs] = useState<ReadonlyMap<number, InspectorChatTab>>(new Map());
	const tabsRef = useRef(tabs);
	tabsRef.current = tabs;
	const runRef = useRef<{ readonly tabId: number; readonly searchId: string } | null>(null);
	const [runningTab, setRunningTab] = useState<number | null>(null);

	const change = useCallback((tabId: number, edit: (tab: InspectorChatTab) => InspectorChatTab) => {
		setTabs((current) => {
			const next = new Map(current);
			next.set(tabId, edit(current.get(tabId) ?? EMPTY_INSPECTOR_CHAT_TAB));
			return next;
		});
	}, []);
	const changeChat = useCallback(
		(tabId: number, edit: (chat: InspectorChat) => InspectorChat) =>
			change(tabId, (tab) => (tab.chat === null ? tab : { ...tab, chat: edit(tab.chat) })),
		[change],
	);

	useEffect(() => {
		const unsubscribe = autorag.search.onEvent?.((event: SearchStreamEvent) => {
			const run = runRef.current;
			if (run === null || event.searchId !== run.searchId) return;
			const { tabId } = run;
			const finish = (): void => {
				runRef.current = null;
				setRunningTab(null);
				changeChat(tabId, (chat) => ({ ...chat, updatedAt: Date.now() }));
			};
			switch (event.type) {
				case "quick-draft":
				case "deep-draft":
					changeChat(tabId, (chat) => updateLastTurn(chat, (turn) => ({ ...turn, draft: event.text })));
					break;
				case "quick":
					changeChat(tabId, (chat) =>
						// Deep supersedes Quick; a Quick never replaces a Deep that already landed.
						updateLastTurn(chat, (turn) => (turn.answer !== null ? turn : { ...turn, answer: event.phase, draft: event.phase.answer })),
					);
					break;
				case "deep":
					changeChat(tabId, (chat) => updateLastTurn(chat, (turn) => ({ ...turn, answer: event.phase, draft: event.phase.answer })));
					break;
				case "error":
					changeChat(tabId, (chat) => updateLastTurn(chat, (turn) => ({ ...turn, error: event.message })));
					finish();
					break;
				case "cancelled":
					changeChat(tabId, (chat) => updateLastTurn(chat, (turn) => ({ ...turn, stopped: true })));
					finish();
					break;
				case "done":
					finish();
					break;
				default:
					break;
			}
		});
		return unsubscribe;
	}, [changeChat]);

	const tab = useCallback(
		(tabId: number, now: number) => liveInspectorTab(tabs.get(tabId) ?? EMPTY_INSPECTOR_CHAT_TAB, now, runningTab === tabId),
		[tabs, runningTab],
	);

	const ask = useCallback(
		(tabId: number, text: string, attachment: ChatAttachment | null) => {
			const question = text.trim();
			if (question.length === 0 || runRef.current !== null) return false;
			const current = liveInspectorTab(tabsRef.current.get(tabId) ?? EMPTY_INSPECTOR_CHAT_TAB, Date.now(), false);
			const chatId = current.chat?.chatId ?? crypto.randomUUID();
			const searchId = crypto.randomUUID();
			const attachments = attachment === null ? [] : [attachment];
			const chat: InspectorChat = {
				chatId,
				updatedAt: Date.now(),
				turns: [...(current.chat?.turns ?? []), { question, attachments, answer: null, draft: "", error: null, stopped: false }],
			};
			change(tabId, () => ({ chat, mode: "chat", expired: false, dismissed: null }));
			runRef.current = { tabId, searchId };
			setRunningTab(tabId);
			autorag.search.start(searchId, chatId, question, attachments).catch((error: unknown) => {
				if (runRef.current?.searchId !== searchId) return;
				runRef.current = null;
				setRunningTab(null);
				const message = error instanceof Error ? error.message : String(error);
				changeChat(tabId, (next) => updateLastTurn(next, (turn) => ({ ...turn, error: message })));
			});
			return true;
		},
		[change, changeChat],
	);

	const summarize = useCallback(
		(tabId: number, attachment: ChatAttachment) => {
			const request = summaryRequest(language, [], [attachment]);
			return ask(tabId, request.prompt, attachment);
		},
		[ask, language],
	);

	const stop = useCallback(() => {
		const run = runRef.current;
		if (run !== null) void autorag.search.cancel(run.searchId);
	}, []);

	const setMode = useCallback((tabId: number, mode: "info" | "chat") => change(tabId, (tab) => ({ ...tab, mode })), [change]);
	const dismiss = useCallback((tabId: number, id: string) => change(tabId, (tab) => ({ ...tab, dismissed: id })), [change]);
	const reset = useCallback(
		(tabId: number) => {
			if (runRef.current?.tabId === tabId) return;
			change(tabId, () => EMPTY_INSPECTOR_CHAT_TAB);
		},
		[change],
	);

	const refresh = useCallback(
		(tabId: number) => {
			const chat = tabsRef.current.get(tabId)?.chat ?? null;
			if (chat === null || runRef.current?.tabId === tabId) return;
			void autorag.search
				.historyGet(chat.chatId)
				.then((record) => {
					if (record === null || runRef.current?.tabId === tabId) return;
					const turns = turnsFromHistory(record.messages);
					if (turns.length < chat.turns.length) return;
					const stored = Date.parse(record.updatedAt);
					changeChat(tabId, (current) =>
						current.chatId !== chat.chatId ? current : { ...current, turns, updatedAt: Number.isFinite(stored) ? Math.max(stored, current.updatedAt) : current.updatedAt },
					);
				})
				.catch((error: unknown) => console.error("inspector chat refresh failed", error));
		},
		[changeChat],
	);

	const prune = useCallback((liveTabIds: readonly number[]) => {
		const live = new Set(liveTabIds);
		setTabs((current) => {
			if ([...current.keys()].every((id) => live.has(id))) return current;
			const next = new Map(current);
			for (const id of current.keys()) if (!live.has(id) && runRef.current?.tabId !== id) next.delete(id);
			return next;
		});
	}, []);

	return { tab, runningTab, ask, summarize, stop, setMode, dismiss, reset, refresh, prune };
}
