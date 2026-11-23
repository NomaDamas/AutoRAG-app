// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProseBlocks } from "../src/renderer/src/components/AiSearchPanel";
import { drawQuickAnswer, markedCitationText, markQuickAnswer, newCitationNumbers, splitRevisionMarks } from "../src/renderer/src/state/answer-revisions";
import { addTurnRevision, newTurn, turnEvidence, turnsFromHistory } from "../src/renderer/src/state/inspector-chat";
import type { AnswerRevision } from "../src/shared/answer-revision";
import type { ChatMessage } from "../src/shared/search-contract";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;
const actions = { onOpenImage: () => undefined, onOpenUrl: () => undefined };

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	vi.useFakeTimers();
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.useRealTimers();
});

const FIRST = "- 환불은 팀장 승인이 필요합니다 [1]\n- 한도는 50만 원입니다 [2]\n- 지급은 다음 달 25일입니다 [3]";

const replace: AnswerRevision = { op: "replace", claimId: "c1", original: "- 환불은 팀장 승인이 필요합니다 [1]", replacement: "- 환불은 이사 승인이 필요합니다 [4]", reason: "2026년 개정" };
const retract: AnswerRevision = { op: "retract", claimId: "c3", original: "- 지급은 다음 달 25일입니다 [3]", reason: "근거가 없습니다" };
const add: AnswerRevision = { op: "add", replacement: "- 재무팀 서명도 필요합니다 [4]", reason: "새 문서" };

function render(revisions: readonly AnswerRevision[], animate: boolean, resolved: readonly number[] = [1, 2, 3, 4]): void {
	const marked = markQuickAnswer(FIRST, revisions);
	if (marked === null) throw new Error("no change to draw");
	act(() =>
		root.render(
			<ProseBlocks
				text={marked.text}
				selected={null}
				unresolved={[1, 2, 3, 4].filter((n) => !resolved.includes(n))}
				onCitation={() => undefined}
				imageActions={actions}
				revisions={{ changes: marked.changes, animate, fresh: [] }}
			/>,
		),
	);
}

const settle = (): void => {
	act(() => {
		vi.advanceTimersByTime(4_000);
	});
};

describe("a corrected claim in the first answer", () => {
	it("shows the struck words, the words that replace them, and why, in the place the claim was", () => {
		render([replace], true);
		const del = host.querySelector("del");
		const ins = host.querySelector("ins");
		expect(del?.textContent).toBe("환불은 팀장 승인이 필요합니다");
		expect(ins?.textContent).toBe("환불은 이사 승인이 필요합니다 4");
		expect(ins?.closest("[data-revision]")?.getAttribute("title")).toBe("2026년 개정");
		// The unchanged claims are as the person read them, around it.
		expect(host.textContent).toContain("한도는 50만 원입니다");
		expect(host.textContent).toContain("지급은 다음 달 25일입니다");
	});

	it("drops the struck claim's own citation and keeps the new one as a chip that can be opened", () => {
		const onCitation = vi.fn();
		const marked = markQuickAnswer(FIRST, [replace]);
		act(() => root.render(<ProseBlocks text={marked!.text} selected={null} unresolved={[]} onCitation={onCitation} imageActions={actions} revisions={{ changes: marked!.changes, animate: true, fresh: [] }} />));
		expect(host.querySelector("del")?.querySelector("button.cite")).toBeNull();
		const chip = host.querySelector("ins button.cite") as HTMLButtonElement;
		expect(chip.textContent).toBe("4");
		act(() => chip.click());
		expect(onCitation).toHaveBeenCalledWith(4);
	});

	it("lets the struck words fade out once the change has settled, leaving the new words marked", () => {
		render([replace], true);
		expect(host.querySelector("del")).not.toBeNull();
		expect(host.querySelector("ins")?.getAttribute("data-settled")).toBe("false");
		act(() => {
			vi.advanceTimersByTime(2_700);
		});
		// The mark has started to fade and the struck words with it; they are gone a moment later.
		expect(host.querySelector("ins")?.getAttribute("data-settled")).toBe("true");
		expect(host.querySelector("del")?.getAttribute("data-fading")).toBe("true");
		settle();
		expect(host.querySelector("del")).toBeNull();
		expect(host.querySelector("ins")?.getAttribute("data-settled")).toBe("true");
	});

	it("is already settled when the answer is read back from history", () => {
		render([replace], false);
		expect(host.querySelector("del")).toBeNull();
		expect(host.querySelector("ins")?.getAttribute("data-settled")).toBe("true");
	});

	it("is settled at once for a person who asked for less motion", () => {
		vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
		try {
			render([replace], true);
			expect(host.querySelector("del")).toBeNull();
			expect(host.querySelector("ins")?.getAttribute("data-settled")).toBe("true");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("keeps a retracted claim struck, since nothing replaces it and the person should still see what was withdrawn", () => {
		render([retract], true);
		settle();
		const del = host.querySelector("del");
		expect(del?.textContent).toBe("지급은 다음 달 25일입니다");
		expect(host.querySelector("ins")).toBeNull();
		expect(del?.closest("[data-revision]")?.getAttribute("title")).toBe("근거가 없습니다");
	});

	it("shows an added finding as new words after the rest, with its reason", () => {
		render([add], true);
		const ins = host.querySelector("ins");
		expect(ins?.textContent).toBe("재무팀 서명도 필요합니다 4");
		expect(host.querySelector("del")).toBeNull();
		expect(ins?.closest("[data-revision]")?.getAttribute("title")).toBe("새 문서");
	});

	it("draws several corrections in one answer, each in its own place", () => {
		render([replace, retract, add], false);
		expect(host.querySelectorAll("[data-revision]")).toHaveLength(3);
		expect([...host.querySelectorAll("[data-revision]")].map((el) => el.getAttribute("data-revision"))).toEqual(["replace", "retract", "add"]);
	});
});

describe("a source the correction brought in", () => {
	const evidenceOf = (...numbers: number[]) => numbers.map((number) => ({ number, title: `${number}.md`, summary: "", source: `/${number}.md`, excerpts: [] }));

	it("is one the new words cite that the first answer did not, and that has something to open", () => {
		const marked = markQuickAnswer(FIRST, [replace, add])!;
		expect(newCitationNumbers(FIRST, marked.changes, evidenceOf(1, 2, 3, 4))).toEqual([4]);
		// Not yet sent by the final answer: nothing to open, so nothing to highlight.
		expect(newCitationNumbers(FIRST, marked.changes, evidenceOf(1, 2, 3))).toEqual([]);
		// A source the first answer already cited is not new however often the correction cites it again.
		const again: AnswerRevision = { op: "replace", claimId: "c2", original: "- 한도는 50만 원입니다 [2]", replacement: "- 한도는 70만 원입니다 [1]", reason: "정정" };
		expect(newCitationNumbers(FIRST, markQuickAnswer(FIRST, [again])!.changes, evidenceOf(1, 2, 3))).toEqual([]);
	});

	it("comes with the drawn answer, and a retraction brings in nothing", () => {
		const quick = { answer: FIRST, evidence: evidenceOf(1, 2, 3) };
		const deep = { answer: "", evidence: evidenceOf(4) };
		expect(drawQuickAnswer(quick, deep, [replace])?.fresh).toEqual([4]);
		expect(drawQuickAnswer(quick, deep, [retract])?.fresh).toEqual([]);
	});

	it("wears the sun colour in the answer until it has been opened, and only while the correction is new", () => {
		const marked = markQuickAnswer(FIRST, [replace])!;
		const draw = (fresh: readonly number[], selected: number | null = null) =>
			act(() => root.render(<ProseBlocks text={marked.text} selected={selected} unresolved={[]} onCitation={() => undefined} imageActions={actions} revisions={{ changes: marked.changes, animate: true, fresh }} />));
		draw([4]);
		const chip = (): HTMLElement => host.querySelector('ins button.cite[data-cite="4"]') as HTMLElement;
		expect(chip().getAttribute("data-fresh")).toBe("true");
		expect(chip().className).toContain("bg-source-new");
		// The chips of the claims that were already there keep the usual look.
		expect(host.querySelector('button.cite[data-cite="2"]')?.getAttribute("data-fresh")).toBeNull();
		// Opened: it is selected, so it takes the selected look rather than the new one.
		draw([4], 4);
		expect(chip().getAttribute("data-fresh")).toBeNull();
		expect(chip().className).toContain("bg-accent");
		// Read back from history: nothing is new.
		draw([]);
		expect(chip().getAttribute("data-fresh")).toBeNull();
		expect(chip().className).toContain("bg-accent-wash");
	});
});

describe("marking the first answer", () => {
	it("returns nothing to draw when every correction only confirms", () => {
		expect(markQuickAnswer(FIRST, [{ op: "confirm", claimId: "c1", reason: "근거 확인" }])).toBeNull();
		expect(markQuickAnswer(FIRST, [])).toBeNull();
	});

	it("finds the claims inside an answer that starts with the notes the model wrote on the way", () => {
		const text = `원문을 확인합니다.\n\n${FIRST}`;
		const marked = markQuickAnswer(text, [replace]);
		expect(marked?.text.startsWith("원문을 확인합니다.")).toBe(true);
		expect(marked?.changes).toHaveLength(1);
	});

	it("counts the citations of the new words, and not those of the claims that were struck out", () => {
		const marked = markQuickAnswer(FIRST, [replace]);
		const cited = markedCitationText(marked!);
		expect(cited).toContain("[4]");
		expect(cited).not.toContain("[1]");
		expect(cited).toContain("[2]");
	});

	it("draws the corrected Quick answer with the sources of the first answer and of the final answer's new citations", () => {
		const quick = { answer: FIRST, evidence: [1, 2, 3].map((number) => ({ number, title: `${number}.md`, summary: "", source: `/${number}.md`, excerpts: [] })) };
		const withoutDeep = drawQuickAnswer(quick, null, [replace]);
		// Until the final answer sends the new source, the new citation has nothing to open and is dropped.
		expect(withoutDeep?.unresolved).toEqual([4]);
		const deep = { answer: "", evidence: [{ number: 4, title: "4.md", summary: "", source: "/4.md", excerpts: [] }] };
		expect(drawQuickAnswer(quick, deep, [replace])?.unresolved).toEqual([]);
		expect(drawQuickAnswer(quick, deep, [])).toBeNull();
		expect(drawQuickAnswer(null, null, [replace])).toBeNull();
	});

	it("cuts a line into its text and the corrections drawn inside it", () => {
		expect(splitRevisionMarks("- \u00010\u0001 끝 \u00011\u0001")).toEqual([{ text: "- " }, { change: 0 }, { text: " 끝 " }, { change: 1 }]);
		expect(splitRevisionMarks("마크 없음")).toEqual([{ text: "마크 없음" }]);
	});
});

describe("a turn that was corrected", () => {
	it("keeps the corrections in the order they arrived", () => {
		const chat = { chatId: "c", updatedAt: 0, turns: [newTurn("한도는?", [], 1)] };
		const next = addTurnRevision(addTurnRevision(chat, replace), add);
		expect(next.turns[0]?.revisions).toEqual([replace, add]);
		expect(chat.turns[0]?.revisions).toEqual([]);
	});

	it("is read back from history with its corrections", () => {
		const messages: ChatMessage[] = [
			{ role: "user", text: "한도는?", attachments: [], at: "1" },
			{ role: "assistant", sessionId: "s", quick: { answer: FIRST, evidence: [] }, deep: null, stopped: false, at: "2", revisions: [replace] },
			{ role: "user", text: "다음은?", attachments: [], at: "3" },
			{ role: "assistant", sessionId: "s", quick: { answer: "답", evidence: [] }, deep: null, stopped: false, at: "4" },
		];
		const turns = turnsFromHistory(messages);
		expect(turns[0]?.revisions).toEqual([replace]);
		expect(turns[1]?.revisions).toEqual([]);
	});

	it("resolves the correction's citations through the evidence the final answer sent, which the first answer did not have", () => {
		const turn = {
			...newTurn("한도는?", [], 1),
			quick: { answer: FIRST, evidence: [{ number: 1, title: "a.md", summary: "", source: "/a.md", excerpts: [] }] },
			deep: { answer: "", evidence: [{ number: 4, title: "b.md", summary: "", source: "/b.md", excerpts: [] }] },
			revisions: [replace],
		};
		expect(turnEvidence(turn).map((item) => item.number)).toEqual([1, 4]);
	});
});
