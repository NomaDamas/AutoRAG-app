import { describe, expect, it } from "vitest";
import { decodeText, lineEnding, splitHighlighted } from "../src/preview/shared/code";
import { markdownLine, markdownStats, type MarkdownToken } from "../src/preview/shared/markdown-source";

describe("highlighted line splitting", () => {
	it("closes spans at each newline and reopens them on the next line", () => {
		const html = '<span class="hljs-string">&quot;a\nb&quot;</span> x\ny';
		expect(splitHighlighted(html)).toEqual(['<span class="hljs-string">&quot;a</span>', '<span class="hljs-string">b&quot;</span> x', "y"]);
	});

	it("keeps nested spans balanced across lines", () => {
		const html = '<span class="hljs-function"><span class="hljs-keyword">def</span> f(\n)</span>';
		expect(splitHighlighted(html)).toEqual([
			'<span class="hljs-function"><span class="hljs-keyword">def</span> f(</span>',
			'<span class="hljs-function">)</span>',
		]);
	});

	it("marks calls and constants that the grammar left unclassified", () => {
		const [line] = splitHighlighted('total = round(sum(OUT), 2) &amp;&amp; HEAD');
		expect(line).toBe(
			'total = <span class="ql-call">round</span>(<span class="ql-call">sum</span>(<span class="ql-const">OUT</span>), 2) &amp;&amp; <span class="ql-const">HEAD</span>',
		);
	});

	it("leaves identifiers inside classified spans alone", () => {
		const [line] = splitHighlighted('<span class="hljs-string">&quot;CALL(x)&quot;</span>');
		expect(line).toBe('<span class="hljs-string">&quot;CALL(x)&quot;</span>');
	});

	it("drops the empty line after a final newline, as editors number lines", () => {
		expect(splitHighlighted("a\n")).toEqual(["a"]);
		expect(splitHighlighted("")).toEqual([""]);
	});
});

describe("text decoding", () => {
	it("reads UTF-8, keeping a prefix cut mid-character", () => {
		const bytes = new TextEncoder().encode("한글 ok");
		expect(decodeText(bytes)).toEqual({ text: "한글 ok", encoding: "UTF-8" });
		expect(decodeText(bytes.subarray(0, 4)).text).toBe("한");
	});

	it("honours byte order marks", () => {
		expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toEqual({ text: "a", encoding: "UTF-8 BOM" });
		expect(decodeText(new Uint8Array([0xff, 0xfe, 0x61, 0x00]))).toEqual({ text: "a", encoding: "UTF-16 LE" });
		expect(decodeText(new Uint8Array([0xfe, 0xff, 0x00, 0x61]))).toEqual({ text: "a", encoding: "UTF-16 BE" });
	});

	it("falls back to the Korean Windows code page for legacy files", () => {
		// "한글" in CP949 / EUC-KR.
		expect(decodeText(new Uint8Array([0xc7, 0xd1, 0xb1, 0xdb]))).toEqual({ text: "한글", encoding: "EUC-KR" });
	});

	it("names the line ending a file uses", () => {
		expect(lineEnding("a\nb\n")).toBe("LF");
		expect(lineEnding("a\r\nb\r\n")).toBe("CRLF");
		expect(lineEnding("a\rb")).toBe("CR");
		expect(lineEnding("single line")).toBe("LF");
	});
});

function render(tokens: readonly MarkdownToken[]): string {
	return tokens.map((token) => `[${token.kind}:${token.text}]`).join("");
}

describe("markdown source colouring", () => {
	it("splits headings into the marker and the title", () => {
		expect(render(markdownLine("## 동작 방식", false).tokens)).toBe("[mark:## ][heading:동작 방식]");
	});

	it("colours list markers, bold, and inline code", () => {
		expect(render(markdownLine("1. **Record** 버튼", false).tokens)).toBe("[list:1. ][mark:**][strong:Record][mark:**][text: 버튼]");
		expect(render(markdownLine("- STT: `Whisper`", false).tokens)).toBe("[list:- ][text:STT: ][mark:`][code:Whisper][mark:`]");
	});

	it("tracks fenced code blocks across lines", () => {
		const open = markdownLine("```bash", false);
		expect(open.fenced).toBe(true);
		expect(render(open.tokens)).toBe("[mark:```][code:bash]");
		const inside = markdownLine("pip install -r requirements.txt", open.fenced);
		expect(render(inside.tokens)).toBe("[code:pip install -r requirements.txt]");
		expect(markdownLine("```", inside.fenced).fenced).toBe(false);
	});

	it("colours quotes and table pipes", () => {
		expect(render(markdownLine("> 주의", false).tokens)).toBe("[mark:> ][quote:주의]");
		expect(render(markdownLine("| 항목 | 값 |", false).tokens)).toBe("[table:|][text: 항목 ][table:|][text: 값 ][table:|]");
		expect(render(markdownLine("| --- | --- |", false).tokens)).toBe("[table:|][mark: --- ][table:|][mark: --- ][table:|]");
	});

	it("counts lines, words, headings, tables, and code blocks", () => {
		const source = "# Title\n\nSome words here.\n\n## Part\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```js\nx()\n```\n";
		expect(markdownStats(source)).toEqual({ lines: 13, words: 11, headings: 2, tables: 1, codeBlocks: 1 });
	});
});
