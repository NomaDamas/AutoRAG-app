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
	expired: false,
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
				onDismiss={noop}
				onReveal={noop}
				onPreview={noop}
			/>,
		),
	);
}

describe("the inspector chat view", () => {
	it("shows the question as a bubble under the file it brought in", () => {
		render([]);
		expect(host.querySelector(".inspector-chat-question")?.textContent).toBe("요약해줘");
		expect(host.querySelector(".inspector-chat-att")?.textContent).toContain("deck.pdf");
	});

	it("opens a source to its excerpt with the cited phrase marked, and 파일 찾기 / 파일 열기", () => {
		render([]);
		const head = host.querySelector<HTMLButtonElement>("button[aria-expanded]");
		act(() => head?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		const marked = host.querySelector(".text-accent-text.font-medium");
		expect(marked?.textContent).toBe("곡선으로 재해석");
		expect(marked?.parentElement?.textContent).toBe("컨셉 — 곡선으로 재해석하는 것이 목표");
		const labels = [...host.querySelectorAll("button")].map((button) => button.textContent);
		expect(labels).toContain("파일 찾기");
		expect(labels).toContain("파일 열기");
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
					onOpenHistory={noop}
				/>,
			),
		);
		expect(host.querySelector(".inspector-chat-att")).toBeNull();
		expect(host.querySelector("input")?.getAttribute("placeholder")).toBe("이 파일에 대해 묻기");
	});

	it("asks about anything with nothing selected, and offers no AI 요약", () => {
		const empty: InspectorChatTab = { chat: null, mode: "info", expired: false, dismissed: [] };
		act(() =>
			root.render(
				<InspectorChatDock tab={empty} now={0} targets={[]} running={false} onAsk={() => true} onSummarize={noop} onStop={noop} onResume={noop} onOpenHistory={noop} />,
			),
		);
		expect(host.querySelector("input")?.getAttribute("placeholder")).toBe("무엇이든 물어보세요");
		expect(host.textContent).not.toContain("AI 요약");
	});
});
