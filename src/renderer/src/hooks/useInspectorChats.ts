import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatAttachment, SearchStreamEvent } from "../../../shared/search-contract";
import { summaryRequest, type SummaryLanguage } from "../state/ai-summary";
import {
	addSteer,
	deliverTurnSteers,
	EMPTY_INSPECTOR_CHAT_TAB,
	newTurn,
	removeSteer,
	settleTurnSteers,
	steerTiming,
	turnsFromHistory,
	updateLastTurn,
	type InspectorChat,
	type InspectorChatTab,
} from "../state/inspector-chat";

export interface InspectorChats {
	/** Tab `tabId`'s inspector chat. */
	tab(tabId: number): InspectorChatTab;
	/** The tab whose inspector chat has a run streaming, if any: one run at a time. */
	readonly runningTab: number | null;
	/** The streaming run's id: the agent's questions and approvals name it (`frontRequest`). */
	readonly runSearchId: string | null;
	/**
	 * Ask `text` with `attachments`: in the tab's chat (starting one when it has none), or, `fresh`, in a new chat
	 * (the Info view's composer). False when nothing was sent: another inspector run is still streaming. `viewingFolder` is
	 * the folder open in the tab when nothing is selected: the agent is told it as a hint, not as a limit.
	 */
	ask(tabId: number, text: string, attachments: readonly ChatAttachment[], fresh?: boolean, viewingFolder?: string): boolean;
	/** "요약": the summary prompt AI Search uses, about `targets`; it carries `attachments`. */
	summarize(tabId: number, targets: readonly ChatAttachment[], attachments: readonly ChatAttachment[], fresh?: boolean): boolean;
	/** Make the stored chat `chatId` the tab's chat and show it (the chat title's history menu). */
	open(tabId: number, chatId: string): void;
	/**
	 * Correct the tab's streaming run with `text` (Enter in the composer): the run takes it before its next model request.
	 * A run that no longer takes steers queues the text as the next question. False when the tab has no run streaming.
	 */
	steer(tabId: number, text: string): boolean;
	/** ⌥Enter during a run: `text` is asked as the tab's next question once the run ends. */
	queue(tabId: number, text: string): void;
	/** Cancel the queued question at `index`. */
	unqueue(tabId: number, index: number): void;
	/** Stop the inspector run that is streaming, whichever tab asked it; the questions queued behind it are dropped. */
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
	const [running, setRunning] = useState<{ readonly tabId: number; readonly searchId: string } | null>(null);
	const runningTab = running?.tabId ?? null;

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
				setRunning(null);
				const now = Date.now();
				changeChat(tabId, settleTurnSteers);
				// An answer that lands while the chat is on screen is read; one that lands behind the Info view is not.
				change(tabId, (tab) => (tab.chat === null ? tab : { ...tab, chat: { ...tab.chat, updatedAt: now }, seenAt: tab.mode === "chat" ? now : tab.seenAt }));
			};
			switch (event.type) {
				case "progress":
					changeChat(tabId, (chat) => updateLastTurn(chat, (turn) => ({ ...turn, progress: event.text })));
					break;
				case "steer-delivered":
					changeChat(tabId, deliverTurnSteers);
					break;
				case "quick-draft":
					changeChat(tabId, (chat) => updateLastTurn(chat, (turn) => ({ ...turn, quickDraft: event.text })));
					break;
				case "deep-draft":
					changeChat(tabId, (chat) => updateLastTurn(chat, (turn) => ({ ...turn, deepDraft: event.text })));
					break;
				case "quick":
					changeChat(tabId, (chat) =>
						updateLastTurn(chat, (turn) => ({ ...turn, quick: event.phase, quickDraft: event.phase.answer, deepDraft: turn.deep === null ? "" : turn.deepDraft, progress: "" })),
					);
					break;
				case "deep":
					changeChat(tabId, (chat) =>
						updateLastTurn(chat, (turn) => ({
							...turn,
							deep: event.phase,
							deepDraft: event.phase.answer,
							deepElapsed: turn.startedAt === 0 ? null : Date.now() - turn.startedAt,
							progress: "",
						})),
					);
					break;
				case "error":
					changeChat(tabId, (chat) => updateLastTurn(chat, (turn) => ({ ...turn, error: event.message })));
					finish();
					break;
				case "cancelled":
					changeChat(tabId, (chat) => updateLastTurn(chat, (turn) => ({ ...turn, stopped: true })));
					change(tabId, (tab) => (tab.queued.length === 0 ? tab : { ...tab, queued: [] }));
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
	}, [change, changeChat]);

	const tab = useCallback((tabId: number) => tabs.get(tabId) ?? EMPTY_INSPECTOR_CHAT_TAB, [tabs]);

	const ask = useCallback(
		(tabId: number, text: string, attachments: readonly ChatAttachment[], fresh = false, viewingFolder?: string) => {
			const question = text.trim();
			if (question.length === 0 || runRef.current !== null) return false;
			const previous = fresh ? null : (tabsRef.current.get(tabId)?.chat ?? null);
			const chatId = previous?.chatId ?? crypto.randomUUID();
			const searchId = crypto.randomUUID();
			const now = Date.now();
			const chat: InspectorChat = {
				chatId,
				updatedAt: now,
				turns: [...(previous?.turns ?? []), newTurn(question, attachments, now)],
			};
			change(tabId, (tab) => ({ ...tab, chat, mode: "chat", seenAt: now, dismissed: [] }));
			runRef.current = { tabId, searchId };
			setRunning({ tabId, searchId });
			autorag.search.start(searchId, chatId, question, attachments, viewingFolder).catch((error: unknown) => {
				if (runRef.current?.searchId !== searchId) return;
				runRef.current = null;
				setRunning(null);
				const message = error instanceof Error ? error.message : String(error);
				changeChat(tabId, (next) => updateLastTurn(next, (turn) => ({ ...turn, error: message })));
			});
			return true;
		},
		[change, changeChat],
	);

	// Questions queued during a run are asked one by one, in the same chat, once the run has ended.
	useEffect(() => {
		if (running !== null) return;
		for (const [tabId, tab] of tabs) {
			const next = tab.queued[0];
			if (next === undefined || tab.chat === null) continue;
			change(tabId, (current) => ({ ...current, queued: current.queued.slice(1) }));
			ask(tabId, next, []);
			return;
		}
	}, [running, tabs, change, ask]);

	const steer = useCallback(
		(tabId: number, text: string) => {
			const run = runRef.current;
			const trimmed = text.trim();
			if (run === null || run.tabId !== tabId || trimmed === "" || tabsRef.current.get(tabId)?.chat == null) return false;
			const id = crypto.randomUUID();
			changeChat(tabId, (chat) => addSteer(chat, { id, text: trimmed, timing: steerTiming(chat), status: "pending" }));
			// A run past its last model request, or one that is gone, does not take it: the text is asked as the next question.
			const refused = (): void => {
				changeChat(tabId, (chat) => removeSteer(chat, id));
				change(tabId, (tab) => ({ ...tab, queued: [...tab.queued, trimmed] }));
			};
			autorag.search.steer(run.searchId, trimmed).then((accepted) => {
				if (!accepted) refused();
			}, refused);
			return true;
		},
		[change, changeChat],
	);

	const queue = useCallback(
		(tabId: number, text: string) => {
			const trimmed = text.trim();
			if (trimmed !== "") change(tabId, (tab) => ({ ...tab, queued: [...tab.queued, trimmed] }));
		},
		[change],
	);
	const unqueue = useCallback(
		(tabId: number, index: number) => change(tabId, (tab) => ({ ...tab, queued: tab.queued.filter((_, position) => position !== index) })),
		[change],
	);

	const summarize = useCallback(
		(tabId: number, targets: readonly ChatAttachment[], attachments: readonly ChatAttachment[], fresh = false) => {
			const request = summaryRequest(language, [], targets);
			return ask(tabId, request.prompt, attachments, fresh);
		},
		[ask, language],
	);

	const stop = useCallback(() => {
		const run = runRef.current;
		if (run === null) return;
		change(run.tabId, (tab) => (tab.queued.length === 0 ? tab : { ...tab, queued: [] }));
		void autorag.search.cancel(run.searchId);
	}, [change]);

	const setMode = useCallback((tabId: number, mode: "info" | "chat") => change(tabId, (tab) => ({ ...tab, mode, seenAt: Date.now() })), [change]);

	const open = useCallback(
		(tabId: number, chatId: string) => {
			if (runRef.current?.tabId === tabId) return;
			void autorag.search
				.historyGet(chatId)
				.then((record) => {
					if (record === null || runRef.current?.tabId === tabId) return;
					const now = Date.now();
					const stored = Date.parse(record.updatedAt);
					const chat: InspectorChat = { chatId, title: record.title, turns: turnsFromHistory(record.messages), updatedAt: Number.isFinite(stored) ? stored : now };
					change(tabId, (tab) => ({ ...tab, chat, mode: "chat", seenAt: now, dismissed: [] }));
				})
				.catch((error: unknown) => console.error("inspector chat open failed", error));
		},
		[change],
	);
	const dismiss = useCallback(
		(tabId: number, id: string) => change(tabId, (tab) => (tab.dismissed.includes(id) ? tab : { ...tab, dismissed: [...tab.dismissed, id] })),
		[change],
	);
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

	return { tab, runningTab, runSearchId: running?.searchId ?? null, ask, summarize, open, steer, queue, unqueue, stop, setMode, dismiss, reset, refresh, prune };
}
