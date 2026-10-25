// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { highlightCode, highlightGrammar } from "../src/preview/ui/highlight";
import { CodeBlock } from "../src/renderer/src/components/CodeBlock";
import { ProseBlocks } from "../src/renderer/src/components/AiSearchPanel";
import { EvidenceExcerpt } from "../src/renderer/src/components/EvidenceBlocks";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const IMAGE_ACTIONS = { onOpenImage: () => undefined, onOpenUrl: () => undefined };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

const PYTHON = 'def greet(name):\n    return f"hi {name}"  # say hi';

/** The text a user would copy out of highlighted HTML. */
function textOf(html: string): string {
	const probe = document.createElement("pre");
	probe.innerHTML = html;
	return probe.textContent ?? "";
}

describe("highlightGrammar", () => {
	it("resolves grammar names, aliases, and file extensions to a registered grammar", () => {
		expect(highlightGrammar("python")).toBe("python");
		expect(highlightGrammar("py")).toBe("python");
		expect(highlightGrammar("TSX")).toBe("typescript");
		expect(highlightGrammar("shell")).toBe("bash");
		expect(highlightGrammar("sh")).toBe("bash");
		expect(highlightGrammar("yml")).toBe("yaml");
		expect(highlightGrammar("html")).toBe("xml");
		expect(highlightGrammar("golang")).not.toBeNull();
	});

	it("returns null when there is no language or no grammar for it", () => {
		expect(highlightGrammar(null)).toBeNull();
		expect(highlightGrammar("")).toBeNull();
		expect(highlightGrammar("brainfuck")).toBeNull();
		expect(highlightGrammar("constructor")).toBeNull();
		expect(highlightGrammar("__proto__")).toBeNull();
	});
});

describe("highlightCode", () => {
	it("wraps tokens in highlight.js classes and keeps the source text intact", () => {
		const html = highlightCode(PYTHON, "python");
		expect(html).toContain('<span class="hljs-keyword">def</span>');
		expect(html).toContain("hljs-string");
		expect(html).toContain("hljs-comment");
		expect(textOf(html)).toBe(PYTHON);
	});

	it("escapes markup when there is no grammar, so code never becomes DOM", () => {
		const html = highlightCode('<img src=x onerror=alert(1)> & "q"', null);
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img");
		expect(html).toContain("&amp;");
	});

	it("escapes markup inside highlighted code too", () => {
		const html = highlightCode('<script>alert("x")</script>', "html");
		expect(html).not.toContain("<script>");
		expect(textOf(html)).toBe('<script>alert("x")</script>');
	});

	it("keeps a token that spans lines intact", () => {
		expect(textOf(highlightCode("const s = `a\nb`;", "javascript"))).toBe("const s = `a\nb`;");
	});
});

describe("CodeBlock", () => {
	it("renders highlighted tokens for a known language", () => {
		act(() => root.render(<CodeBlock text={PYTHON} language="python" className="x" />));
		const pre = host.querySelector("pre.x");
		expect(pre).not.toBeNull();
		expect(pre!.querySelectorAll(".hljs-keyword").length).toBeGreaterThan(0);
		expect(pre!.textContent).toBe(PYTHON);
	});

	it("renders plain text with no token spans when the language is unknown or missing", () => {
		act(() => root.render(<CodeBlock text={"def a():\n  pass"} language={null} className="x" />));
		expect(host.querySelector("pre")!.querySelector("span")).toBeNull();
		expect(host.querySelector("pre")!.textContent).toBe("def a():\n  pass");
	});
});

describe("code fences in AI Search answers", () => {
	it("highlights a fenced block by its language", () => {
		act(() =>
			root.render(
				<ProseBlocks text={"예시입니다.\n\n```python\n" + PYTHON + "\n```\n\n끝."} selected={null} unresolved={[]} onCitation={() => undefined} imageActions={IMAGE_ACTIONS} />,
			),
		);
		const pre = host.querySelector("pre");
		expect(pre).not.toBeNull();
		expect(pre!.querySelector(".hljs-keyword")?.textContent).toBe("def");
		expect(pre!.textContent).toBe(PYTHON);
		expect(host.querySelectorAll("p")).toHaveLength(2);
	});

	it("leaves an untagged fence as plain code", () => {
		act(() => root.render(<ProseBlocks text={"```\nls -la\n```"} selected={null} unresolved={[]} onCitation={() => undefined} imageActions={IMAGE_ACTIONS} />));
		expect(host.querySelector("pre")!.querySelector("span")).toBeNull();
		expect(host.querySelector("pre")!.textContent).toBe("ls -la");
	});
});

describe("code fences in evidence excerpts", () => {
	it("highlights a fenced block by its language", () => {
		act(() => root.render(<EvidenceExcerpt text={'```json\n{"a": 1, "b": "x"}\n```'} images={{ folder: null, actions: IMAGE_ACTIONS }} />));
		const pre = host.querySelector(".evidence__block--code");
		expect(pre!.querySelector(".hljs-attr")).not.toBeNull();
		expect(pre!.textContent).toBe('{"a": 1, "b": "x"}');
	});
});
