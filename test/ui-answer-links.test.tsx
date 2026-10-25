// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProseBlocks } from "../src/renderer/src/components/AiSearchPanel";
import { EvidenceExcerpt } from "../src/renderer/src/components/EvidenceBlocks";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;
const onOpenUrl = vi.fn<(url: string) => void>();
const actions = { onOpenImage: () => undefined, onOpenUrl };

beforeEach(() => {
	onOpenUrl.mockReset();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

function renderAnswer(text: string, onCitation: (number: number) => void = () => undefined): void {
	act(() => root.render(<ProseBlocks text={text} selected={null} unresolved={[]} onCitation={onCitation} imageActions={actions} />));
}

function renderExcerpt(text: string): void {
	act(() => root.render(<EvidenceExcerpt text={text} images={{ folder: "/Users/me/docs", actions }} />));
}

/** Dispatch a cancelable mouse event and report whether the page's default action was prevented. */
function fire(target: Element, type: "click" | "auxclick", init: MouseEventInit = {}): boolean {
	const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
	act(() => {
		target.dispatchEvent(event);
	});
	return event.defaultPrevented;
}

const anchors = (): HTMLAnchorElement[] => [...host.querySelectorAll("a")];

describe("AI Search answer links", () => {
	it("renders a markdown link as an anchor showing its label and opens its URL in the OS browser on click", () => {
		renderAnswer("자세한 내용은 [공식 문서](https://example.com/docs)를 참고하세요.");
		const [anchor] = anchors();
		expect(anchors()).toHaveLength(1);
		expect(anchor?.textContent).toBe("공식 문서");
		expect(anchor?.getAttribute("href")).toBe("https://example.com/docs");
		expect(host.textContent).toBe("자세한 내용은 공식 문서를 참고하세요.");
		expect(fire(anchor!, "click")).toBe(true);
		expect(onOpenUrl).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
	});

	it("renders a bare URL as an anchor showing the URL as written", () => {
		renderAnswer("사이트는 https://example.com/a?x=1&y=2 입니다.");
		const [anchor] = anchors();
		expect(anchors()).toHaveLength(1);
		expect(anchor?.textContent).toBe("https://example.com/a?x=1&y=2");
		fire(anchor!, "click");
		expect(onOpenUrl).toHaveBeenCalledExactlyOnceWith("https://example.com/a?x=1&y=2");
	});

	it("never lets the browser navigate the window: modified and middle clicks are prevented too", () => {
		renderAnswer("[문서](https://example.com/docs)");
		const anchor = anchors()[0]!;
		expect(fire(anchor, "click", { metaKey: true })).toBe(true);
		expect(fire(anchor, "click", { ctrlKey: true, shiftKey: true })).toBe(true);
		expect(onOpenUrl).toHaveBeenCalledTimes(2);
		onOpenUrl.mockClear();
		expect(fire(anchor, "auxclick", { button: 1 })).toBe(true);
		expect(onOpenUrl).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
		onOpenUrl.mockClear();
		expect(fire(anchor, "auxclick", { button: 2 })).toBe(true);
		expect(onOpenUrl).not.toHaveBeenCalled();
		expect(anchor.getAttribute("draggable")).toBe("false");
	});

	it("renders links inside list items, headings, quotes, and table cells", () => {
		renderAnswer(["## [제목](https://example.com/h)", "- [항목](https://example.com/l)", "> [인용](https://example.com/q)", "", "| 이름 | 링크 |", "|---|---|", "| 셀 | https://example.com/t |"].join("\n"));
		expect(anchors().map((anchor) => anchor.getAttribute("href"))).toEqual(["https://example.com/h", "https://example.com/l", "https://example.com/q", "https://example.com/t"]);
		expect(host.querySelector("table a")?.textContent).toBe("https://example.com/t");
	});

	it("keeps bold in a link label and keeps citation chips next to a link clickable", () => {
		const onCitation = vi.fn();
		renderAnswer("**[Dazzi](https://example.com)** 소개 [2]", onCitation);
		expect(host.querySelector("a strong")?.textContent).toBe("Dazzi");
		act(() => (host.querySelector(".cite") as HTMLButtonElement).click());
		expect(onCitation).toHaveBeenCalledWith(2);
		expect(onOpenUrl).not.toHaveBeenCalled();
	});

	it("never renders an anchor for a non-web destination", () => {
		renderAnswer(["[a](javascript:alert(1))", "", "[b](file:///etc/passwd)", "", "[c](./notes.md)", "", "javascript:alert(1)"].join("\n"));
		expect(anchors()).toHaveLength(0);
		expect(host.textContent).toContain("[a](javascript:alert(1))");
	});

	it("wraps a long URL instead of overflowing the answer", () => {
		renderAnswer(`https://example.com/${"a".repeat(200)}`);
		expect(anchors()[0]?.className).toContain("break-all");
	});
});

describe("evidence excerpt links", () => {
	it("renders a markdown link in an excerpt as an anchor that opens in the OS browser", () => {
		renderExcerpt("출처는 [보도자료](https://example.com/press)와 https://example.com/raw 입니다.");
		expect(anchors().map((anchor) => [anchor.textContent, anchor.getAttribute("href")])).toEqual([
			["보도자료", "https://example.com/press"],
			["https://example.com/raw", "https://example.com/raw"],
		]);
		expect(fire(anchors()[0]!, "click")).toBe(true);
		expect(onOpenUrl).toHaveBeenCalledExactlyOnceWith("https://example.com/press");
	});

	it("renders links in excerpt list items and pipe table cells", () => {
		renderExcerpt(["- [목록](https://example.com/l)", "", "| a | b |", "|---|---|", "| [셀](https://example.com/c) | 2 |"].join("\n"));
		expect(anchors().map((anchor) => anchor.getAttribute("href"))).toEqual(["https://example.com/l", "https://example.com/c"]);
	});
});
