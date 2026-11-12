// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InspectorChatDock, InspectorChatView } from "../src/renderer/src/components/InspectorChat";
import type { InspectorChatTab } from "../src/renderer/src/state/inspector-chat";
import type { ChatAttachment } from "../src/shared/search-contract";
import { setAppLanguage } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const noop = (): void => {};
let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	await setAppLanguage("ko");
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

const deck: ChatAttachment = { kind: "file", id: "/work/deck.pdf", name: "deck.pdf" };

const tab: InspectorChatTab = {
	mode: "chat",
	seenAt: 0,
	dismissed: [],
	chat: {
		chatId: "chat-1",
		updatedAt: 0,
		turns: [
			{
				question: "요약해줘",
				attachments: [deck],
				answer: {
					answer: "발표 자료예요 [1].",
					evidence: [{ number: 1, title: "deck.pdf", summary: "", source: "/work/deck.pdf", excerpts: ["컨셉 — **곡선으로 재해석**하는 것이 목표"] }],
				},
				draft: "",
				progress: "",
				error: null,
				stopped: false,
			},
		],
	},
};

function render(pending: readonly ChatAttachment[]): void {
	act(() =>
		root.render(
			<InspectorChatView
				tab={tab}
				targetName="deck.pdf"
				pending={pending}
				running={false}
				imageActions={{ onOpenImage: noop, onOpenUrl: noop }}
				onAsk={() => true}
				onStop={noop}
				onBack={noop}
				onNewChat={noop}
				onExpand={noop}
				onOpenChat={noop}
				onDismiss={noop}
				onReveal={noop}
				onPreview={noop}
			/>,
		),
	);
}

function renderTab(next: InspectorChatTab): void {
	act(() =>
		root.render(
			<InspectorChatView
				tab={next}
				targetName="deck.pdf"
				pending={[]}
				running={false}
				imageActions={{ onOpenImage: noop, onOpenUrl: noop }}
				onAsk={() => true}
				onStop={noop}
				onBack={noop}
				onNewChat={noop}
				onExpand={noop}
				onOpenChat={noop}
				onDismiss={noop}
				onReveal={noop}
				onPreview={noop}
			/>,
		),
	);
}

const withAnswer = (answer: string, excerpts: readonly string[]): InspectorChatTab => ({
	...tab,
	chat: {
		chatId: "chat-2",
		updatedAt: 0,
		turns: [
			{
				question: "q",
				attachments: [],
				answer: { answer, evidence: [{ number: 1, title: "note.md", summary: "", source: "/work/note.md", excerpts }] },
				draft: "",
				progress: "",
				error: null,
				stopped: false,
			},
		],
	},
});

describe("the inspector chat view", () => {
	it("shows a [file:<path>] the librarian left as written as the file's chip, not as raw text", () => {
		renderTab(withAnswer("정리: [file:/Users/me/Documents/archive]\n[file:/Users/me/Documents/archive/summaries]. [1]", ["x"]));
		const chips = [...host.querySelectorAll("[data-file-mention]")].map((chip) => chip.textContent);
		expect(chips).toEqual(["archive", "summaries"]);
		expect(host.querySelector(".inspector-chat-answer")?.textContent).not.toContain("[file:");
	});

	it("renders HTML, a table, an image, and a video inside the hovered citation card", () => {
		renderTab(withAnswer("본문 [1]", ["<table><tr><td>셀</td></tr></table>\n![사진](pic.png)\n![영상](clip.mp4)\n**표시**"]));
		const cite = host.querySelector<HTMLButtonElement>(".inspector-chat-answer button.cite");
		act(() => cite?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
		const card = host.querySelector(".inspector-chat-source");
		expect(card?.querySelector("table td")?.textContent).toBe("셀");
		expect(card?.querySelector("img")?.getAttribute("src")).toContain("autorag-preview");
		expect(card?.querySelector("video")?.getAttribute("src")).toContain("autorag-preview");
		expect(card?.querySelector("strong")?.textContent).toBe("표시");
		expect(card?.textContent).not.toContain("<td>");
	});

	it("shows the question as a bubble under the file it brought in", () => {
		render([]);
		expect(host.querySelector(".inspector-chat-question")?.textContent).toBe("요약해줘");
		expect(host.querySelector(".inspector-chat-att")?.textContent).toContain("deck.pdf");
	});

	it("lists no sources under the answer; hovering a citation number shows its source with 파일 위치로 이동 / 미리보기", () => {
		render([]);
		expect(host.querySelector(".inspector-chat-source")).toBeNull();
		const cite = host.querySelector<HTMLButtonElement>(".inspector-chat-answer button.cite");
		expect(cite?.textContent).toBe("1");
		act(() => cite?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
		const card = host.querySelector(".inspector-chat-source");
		expect(card?.textContent).toContain("deck.pdf");
		const marked = card?.querySelector("strong");
		expect(marked?.textContent).toBe("곡선으로 재해석");
		expect(card?.querySelector(".evidence__block")?.textContent).toBe("컨셉 — 곡선으로 재해석하는 것이 목표");
		expect([...(card?.querySelectorAll("button") ?? [])].map((button) => button.textContent)).toEqual(["파일 위치로 이동", "미리보기"]);
	});

	it("titles the chat with the selection, and offers 새 대화, AI 검색 탭에서 열기 and × (back to the Info view)", () => {
		const backs: string[] = [];
		act(() =>
			root.render(
				<InspectorChatView
					tab={tab}
					targetName="deck.pdf"
					pending={[]}
					running={false}
					imageActions={{ onOpenImage: noop, onOpenUrl: noop }}
					onAsk={() => true}
					onStop={noop}
					onBack={() => backs.push("back")}
					onNewChat={noop}
					onExpand={noop}
					onOpenChat={noop}
					onDismiss={noop}
					onReveal={noop}
					onPreview={noop}
				/>,
			),
		);
		const title = host.querySelector<HTMLButtonElement>(".inspector-chat-title");
		expect(title?.textContent).toBe("deck.pdf");
		expect(title?.getAttribute("aria-haspopup")).toBe("menu");
		const labels = [...host.querySelectorAll(".inspector-chat > div:first-child > button[aria-label]")].map((button) => button.getAttribute("aria-label"));
		expect(labels).toEqual(["새 대화", "AI 검색 탭에서 열기", "대화 닫기"]);
		act(() => host.querySelector<HTMLButtonElement>('button[aria-label="대화 닫기"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(backs).toEqual(["back"]);
	});

	it("shows a chat picked from history under its own title, not the selection's name", () => {
		const picked: InspectorChatTab = { ...tab, chat: tab.chat === null ? null : { ...tab.chat, chatId: "chat-2", title: "3분기 기획안 요약" } };
		act(() =>
			root.render(
				<InspectorChatView
					tab={picked}
					targetName="deck.pdf"
					pending={[]}
					running={false}
					imageActions={{ onOpenImage: noop, onOpenUrl: noop }}
					onAsk={() => true}
					onStop={noop}
					onBack={noop}
					onNewChat={noop}
					onExpand={noop}
					onOpenChat={noop}
					onDismiss={noop}
					onReveal={noop}
					onPreview={noop}
				/>,
			),
		);
		expect(host.querySelector(".inspector-chat-title")?.textContent).toBe("3분기 기획안 요약");
	});

	it("puts the approval-mode chip, icon only, left of the input", () => {
		render([]);
		const chip = host.querySelector<HTMLButtonElement>('.inspector-chat-composer button[aria-haspopup="menu"]');
		expect(chip).not.toBeNull();
		expect(chip?.textContent).toBe("");
		expect(chip?.nextElementSibling?.tagName).toBe("INPUT");
	});

	it("asks about the waiting files, each as a card, and follows up otherwise", () => {
		render([{ kind: "file", id: "/work/notes.pdf", name: "notes.pdf" }]);
		expect(host.querySelector("input")?.getAttribute("placeholder")).toBe("이 파일에 대해 묻기");
		expect(host.querySelectorAll(".inspector-chat-composer .inspector-chat-att")).toHaveLength(1);
		render([
			{ kind: "file", id: "/work/notes.pdf", name: "notes.pdf" },
			{ kind: "file", id: "/work/photo.jpg", name: "photo.jpg" },
		]);
		expect(host.querySelector("input")?.getAttribute("placeholder")).toBe("선택한 항목에 대해 묻기");
		expect(host.querySelectorAll(".inspector-chat-composer .inspector-chat-att")).toHaveLength(2);
		render([]);
		expect(host.querySelector("input")?.getAttribute("placeholder")).toBe("이어서 묻기");
	});
});

describe("the Info view's chat dock", () => {
	it("only types: no attachment card, and the prompt names what the question is about", () => {
		act(() =>
			root.render(
				<InspectorChatDock
					tab={tab}
					now={0}
					targets={[deck]}
					running={false}
					onAsk={() => true}
					onSummarize={noop}
					onStop={noop}
					onResume={noop}
				/>,
			),
		);
		expect(host.querySelector(".inspector-chat-att")).toBeNull();
		expect(host.querySelector("input")?.getAttribute("placeholder")).toBe("이 파일에 대해 묻기");
	});

	it("offers 이어서 대화 instead of AI 요약 once the tab has a chat, with a dot for an answer not yet seen", () => {
		const resumes: string[] = [];
		const seen: InspectorChatTab = { ...tab, mode: "info", seenAt: 10 };
		act(() =>
			root.render(
				<InspectorChatDock tab={seen} now={0} targets={[deck]} running={false} onAsk={() => true} onSummarize={noop} onStop={noop} onResume={() => resumes.push("resume")} />,
			),
		);
		const chip = host.querySelector<HTMLButtonElement>(".inspector-chat-continue");
		expect(chip?.textContent).toContain("이어서 대화");
		expect(chip?.textContent).toContain("· 방금");
		expect(host.textContent).not.toContain("AI 요약");
		expect(chip?.querySelector('[aria-label="새 답변"]')).toBeNull();
		act(() => chip?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(resumes).toEqual(["resume"]);

		const unseen: InspectorChatTab = { ...tab, chat: tab.chat === null ? null : { ...tab.chat, updatedAt: 20 }, mode: "info", seenAt: 10 };
		act(() =>
			root.render(<InspectorChatDock tab={unseen} now={20} targets={[deck]} running={false} onAsk={() => true} onSummarize={noop} onStop={noop} onResume={noop} />),
		);
		expect(host.querySelector('.inspector-chat-continue [aria-label="새 답변"]')).not.toBeNull();
	});

	it("offers AI 요약 while the tab has no chat", () => {
		const empty: InspectorChatTab = { chat: null, mode: "info", seenAt: 0, dismissed: [] };
		act(() =>
			root.render(<InspectorChatDock tab={empty} now={0} targets={[deck]} running={false} onAsk={() => true} onSummarize={noop} onStop={noop} onResume={noop} />),
		);
		expect(host.textContent).toContain("AI 요약");
		expect(host.querySelector(".inspector-chat-continue")).toBeNull();
	});

	it("asks about anything with nothing selected, and offers no AI 요약", () => {
		const empty: InspectorChatTab = { chat: null, mode: "info", seenAt: 0, dismissed: [] };
		act(() =>
			root.render(
				<InspectorChatDock tab={empty} now={0} targets={[]} running={false} onAsk={() => true} onSummarize={noop} onStop={noop} onResume={noop} />,
			),
		);
		expect(host.querySelector("input")?.getAttribute("placeholder")).toBe("무엇이든 물어보세요");
		expect(host.textContent).not.toContain("AI 요약");
	});
});

describe("the composer's blue button", () => {
	const typeInto = (input: HTMLInputElement, value: string): void => {
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
	};

	it("is the mic while nothing is typed and turns into send once text is typed, both blue", () => {
		Reflect.set(window, "autorag", {
			platform: "win32",
			voice: { transcribe: async () => ({ text: "" }), prepare: async () => ({ ok: true }), openMicrophoneSettings: async () => {} },
		});
		try {
			const empty: InspectorChatTab = { chat: null, mode: "info", seenAt: 0, dismissed: [] };
			act(() =>
				root.render(
					<InspectorChatDock tab={empty} now={0} targets={[]} running={false} onAsk={() => true} onSummarize={noop} onStop={noop} onResume={noop} />,
				),
			);
			const mic = host.querySelector<HTMLButtonElement>("button.inspector-chat-voice");
			expect(mic?.getAttribute("aria-label")).toBe("음성으로 입력");
			expect(mic?.className).toContain("bg-accent");
			expect(host.querySelector('button[aria-label="보내기"]')).toBeNull();

			const input = host.querySelector<HTMLInputElement>("input");
			if (input === null) throw new Error("no input");
			typeInto(input, "요약해줘");
			const send = host.querySelector<HTMLButtonElement>('button[aria-label="보내기"]');
			expect(send?.className).toContain("bg-accent");
			expect(send?.disabled).toBe(false);
			expect(host.querySelector("button.inspector-chat-voice")).toBeNull();

			typeInto(input, "  ");
			expect(host.querySelector("button.inspector-chat-voice")).not.toBeNull();
		} finally {
			Reflect.deleteProperty(window, "autorag");
		}
	});
});
