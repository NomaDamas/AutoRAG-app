import { describe, expect, it } from "vitest";
import {
	EMPTY_INSPECTOR_CHAT_TAB,
	hasUnreadAnswer,
	pendingAttachments,
	relativeAge,
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
		turns: attachments.map((att) => ({ question: "요약해줘", attachments: [att], quick: null, deep: null, quickDraft: "", deepDraft: "", deepElapsed: null, startedAt: 0, progress: "", error: null, stopped: false })),
	};
}

function tabWith(chat: InspectorChat | null, extra: Partial<InspectorChatTab> = {}): InspectorChatTab {
	return { ...EMPTY_INSPECTOR_CHAT_TAB, chat, mode: chat === null ? "info" : "chat", ...extra };
}

describe("the selection as context for the inspector chat", () => {
	it("is attached to the first question", () => {
		expect(pendingAttachments(EMPTY_INSPECTOR_CHAT_TAB, [docs])).toEqual([docs]);
	});

	it("attaches every item of a multi-selection to the first question", () => {
		expect(pendingAttachments(EMPTY_INSPECTOR_CHAT_TAB, [docs, deck])).toEqual([docs, deck]);
	});

	it("is not attached again once the chat has it", () => {
		expect(pendingAttachments(tabWith(chatWith(docs)), [docs])).toEqual([]);
	});

	it("comes back to a file the chat already has without attaching it", () => {
		expect(pendingAttachments(tabWith(chatWith(docs, deck)), [docs])).toEqual([]);
	});

	it("is attached when a new file is selected mid-chat, and only what is new of a multi-selection", () => {
		expect(pendingAttachments(tabWith(chatWith(docs)), [deck])).toEqual([deck]);
		expect(pendingAttachments(tabWith(chatWith(docs)), [docs, deck])).toEqual([deck]);
	});

	it("stays out of the next question after the person removes it with ×", () => {
		expect(pendingAttachments(tabWith(chatWith(docs), { dismissed: [deck.id] }), [deck])).toEqual([]);
	});

	it("attaches nothing when nothing is selected", () => {
		expect(pendingAttachments(tabWith(chatWith(docs)), [])).toEqual([]);
	});
});

describe("how long ago the tab's chat was", () => {
	const minute = 60_000;
	const day = 24 * 60 * minute;
	it("counts minutes up to an hour, then hours, days, months and years", () => {
		expect(relativeAge(0, 30_000)).toEqual({ unit: "now", count: 0 });
		expect(relativeAge(0, 59 * minute)).toEqual({ unit: "minutes", count: 59 });
		expect(relativeAge(0, 60 * minute)).toEqual({ unit: "hours", count: 1 });
		expect(relativeAge(0, 23 * 60 * minute + 59 * minute)).toEqual({ unit: "hours", count: 23 });
		expect(relativeAge(0, day)).toEqual({ unit: "days", count: 1 });
		expect(relativeAge(0, 29 * day)).toEqual({ unit: "days", count: 29 });
		expect(relativeAge(0, 30 * day)).toEqual({ unit: "months", count: 1 });
		expect(relativeAge(0, 364 * day)).toEqual({ unit: "months", count: 12 });
		expect(relativeAge(0, 365 * day)).toEqual({ unit: "years", count: 1 });
		expect(relativeAge(1_000, 0)).toEqual({ unit: "now", count: 0 });
	});
});

describe("an answer not yet seen", () => {
	const chat = chatWith(docs);

	it("is one that landed after the person last had the chat in front of them, while the Info view shows", () => {
		expect(hasUnreadAnswer({ ...tabWith(chat), mode: "info", seenAt: chat.updatedAt - 1 })).toBe(true);
		expect(hasUnreadAnswer({ ...tabWith(chat), mode: "info", seenAt: chat.updatedAt })).toBe(false);
	});

	it("never shows while the chat itself is on screen, or when there is no chat", () => {
		expect(hasUnreadAnswer({ ...tabWith(chat), mode: "chat", seenAt: 0 })).toBe(false);
		expect(hasUnreadAnswer(EMPTY_INSPECTOR_CHAT_TAB)).toBe(false);
	});
});

describe("an inspector chat read back from history", () => {
	it("keeps both answer phases of each question, as stored", () => {
		const quick = { answer: "빠른 답", evidence: [] };
		const deep = { answer: "정밀한 답", evidence: [] };
		const messages: ChatMessage[] = [
			{ role: "user", text: "요약해줘", attachments: [docs], at: "1" },
			{ role: "assistant", sessionId: "s", quick, deep, stopped: false, at: "2" },
			{ role: "user", text: "이건?", attachments: [], at: "3" },
			{ role: "assistant", sessionId: "s", quick, deep: null, stopped: false, at: "4" },
		];
		const turns = turnsFromHistory(messages);
		expect(turns.map((turn) => [turn.question, turn.attachments.length, turn.quick?.answer ?? null, turn.deep?.answer ?? null])).toEqual([
			["요약해줘", 1, "빠른 답", "정밀한 답"],
			["이건?", 0, "빠른 답", null],
		]);
	});
});
