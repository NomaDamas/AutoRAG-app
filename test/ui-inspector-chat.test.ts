import { describe, expect, it } from "vitest";
import {
	EMPTY_INSPECTOR_CHAT_TAB,
	INSPECTOR_CHAT_IDLE_MS,
	liveInspectorTab,
	pendingAttachment,
	turnsFromHistory,
	type InspectorChat,
	type InspectorChatTab,
} from "../src/renderer/src/state/inspector-chat";
import type { ChatAttachment, ChatMessage } from "../src/shared/search-contract";

const docs: ChatAttachment = { kind: "folder", id: "/u/Documents", name: "Documents" };
const deck: ChatAttachment = { kind: "file", id: "/u/deck.pdf", name: "deck.pdf" };

function chatWith(...attachments: ChatAttachment[]): InspectorChat {
	return {
		chatId: "c1",
		updatedAt: 1_000,
		turns: attachments.map((att) => ({ question: "요약해줘", attachments: [att], answer: null, draft: "", error: null, stopped: false })),
	};
}

function tabWith(chat: InspectorChat | null, extra: Partial<InspectorChatTab> = {}): InspectorChatTab {
	return { ...EMPTY_INSPECTOR_CHAT_TAB, chat, mode: chat === null ? "info" : "chat", ...extra };
}

describe("the selection as context for the inspector chat", () => {
	it("is attached to the first question", () => {
		expect(pendingAttachment(EMPTY_INSPECTOR_CHAT_TAB, docs)).toEqual(docs);
	});

	it("is not attached again once the chat has it", () => {
		expect(pendingAttachment(tabWith(chatWith(docs)), docs)).toBeNull();
	});

	it("comes back to a file the chat already has without attaching it", () => {
		expect(pendingAttachment(tabWith(chatWith(docs, deck)), docs)).toBeNull();
	});

	it("is attached when a new file is selected mid-chat", () => {
		expect(pendingAttachment(tabWith(chatWith(docs)), deck)).toEqual(deck);
	});

	it("stays out of the next question after the person removes it with ×", () => {
		expect(pendingAttachment(tabWith(chatWith(docs), { dismissed: deck.id }), deck)).toBeNull();
	});

	it("attaches nothing when nothing is selected", () => {
		expect(pendingAttachment(tabWith(chatWith(docs)), null)).toBeNull();
	});
});

describe("letting go of an idle inspector chat", () => {
	const tab = tabWith(chatWith(docs));

	it("keeps a chat that had a question in the last 30 minutes", () => {
		expect(liveInspectorTab(tab, 1_000 + INSPECTOR_CHAT_IDLE_MS, false)).toBe(tab);
	});

	it("lets go after 30 minutes and points at the history", () => {
		expect(liveInspectorTab(tab, 1_001 + INSPECTOR_CHAT_IDLE_MS, false)).toEqual({ chat: null, mode: "info", expired: true, dismissed: null });
	});

	it("never lets go of a chat whose answer is still streaming", () => {
		expect(liveInspectorTab(tab, 10 * INSPECTOR_CHAT_IDLE_MS, true)).toBe(tab);
	});
});

describe("an inspector chat read back from history", () => {
	it("shows each question with the files it brought in and its latest answer phase", () => {
		const quick = { answer: "빠른 답", evidence: [] };
		const deep = { answer: "정밀한 답", evidence: [] };
		const messages: ChatMessage[] = [
			{ role: "user", text: "요약해줘", attachments: [docs], at: "1" },
			{ role: "assistant", sessionId: "s", quick, deep, stopped: false, at: "2" },
			{ role: "user", text: "이건?", attachments: [], at: "3" },
			{ role: "assistant", sessionId: "s", quick, deep: null, stopped: false, at: "4" },
		];
		const turns = turnsFromHistory(messages);
		expect(turns.map((turn) => [turn.question, turn.attachments.length, turn.answer?.answer])).toEqual([
			["요약해줘", 1, "정밀한 답"],
			["이건?", 0, "빠른 답"],
		]);
	});
});
