import { describe, expect, it } from "vitest";
import { repairHtmlFragment, splitExcerpt } from "../src/renderer/src/state/excerpt-format";

describe("splitExcerpt", () => {
	it("keeps a plain markdown chunk as one markdown part", () => {
		const text = "## 승인 규칙\n1. 일반 환불은 5영업일 내 처리합니다.\n> 비고\n본문 **강조**";
		expect(splitExcerpt(text)).toEqual([{ kind: "markdown", text }]);
	});

	it("reads a chunk of bare table rows (no <table>, cut from a spreadsheet) as one HTML part", () => {
		const text = [
			"<tr><td>사용 시나리오</td><td>15</td><td>핵심</td></tr>",
			"<tr><td>고도화 후 실제 사용 시나리오 &amp; 경쟁 우위</td><td>16</td><td></td></tr>",
			"<tr><td>개발 로드맵</td><td>18</td><td>",
		].join("\n");
		const parts = splitExcerpt(text);
		expect(parts).toHaveLength(1);
		expect(parts[0]?.kind).toBe("html");
		const html = parts[0]?.kind === "html" ? parts[0].html : "";
		expect(html.startsWith("<table><tr><td>사용 시나리오</td>")).toBe(true);
		expect(html.endsWith("<td></td></tr></table>")).toBe(true);
	});

	it("splits markdown around an embedded HTML table", () => {
		const parts = splitExcerpt("## Sheet1\n<table>\n<tr><th>항목</th><th>쪽</th></tr>\n<tr><td>로드맵</td><td>18</td></tr>\n</table>\n표 뒤의 본문.");
		expect(parts.map((part) => part.kind)).toEqual(["markdown", "html", "markdown"]);
		expect(parts[0]).toEqual({ kind: "markdown", text: "## Sheet1" });
		expect(parts[2]).toEqual({ kind: "markdown", text: "표 뒤의 본문." });
	});

	it("keeps text lines between tags inside one HTML part while an element is still open", () => {
		const parts = splitExcerpt("<div>\n<p>\n첫 문단 본문\n</p>\n<ul>\n<li>항목</li>\n</ul>\n</div>");
		expect(parts).toHaveLength(1);
		expect(parts[0]?.kind).toBe("html");
	});

	it("leaves tags inside a code fence or an inline code span as markdown", () => {
		const fenced = "예시:\n```html\n<div class=\"x\">\n</div>\n```";
		expect(splitExcerpt(fenced)).toEqual([{ kind: "markdown", text: fenced }]);
		const inline = "태그는 `<table>`로 엽니다.";
		expect(splitExcerpt(inline)).toEqual([{ kind: "markdown", text: inline }]);
	});

	it("does not read a markdown angle-bracket image as HTML", () => {
		const text = "![도식](<images/fig 1.png>)";
		expect(splitExcerpt(text)).toEqual([{ kind: "markdown", text }]);
	});

	it("parses a GFM pipe table with its header and column alignment", () => {
		const parts = splitExcerpt("요약\n| 항목 | 쪽 | 비고 |\n|:---|---:|:---:|\n| 로드맵 | 18 | **중요** |\n| 운영 \\| 전략 | 19 |\n끝");
		expect(parts).toEqual([
			{ kind: "markdown", text: "요약" },
			{
				kind: "table",
				header: ["항목", "쪽", "비고"],
				align: ["left", "right", "center"],
				rows: [
					["로드맵", "18", "**중요**"],
					["운영 | 전략", "19", ""],
				],
			},
			{ kind: "markdown", text: "끝" },
		]);
	});

	it("renders a pipe table the chunk cut before its header as a headerless table", () => {
		const parts = splitExcerpt("| 사용 시나리오 | 15 |\n| 개발 로드맵 | 18 |\n| 기관별");
		expect(parts).toEqual([
			{
				kind: "table",
				header: null,
				align: [null, null],
				rows: [
					["사용 시나리오", "15"],
					["개발 로드맵", "18"],
					["기관별", ""],
				],
			},
		]);
	});

	it("leaves a single line with a pipe as prose", () => {
		const text = "| 하나뿐인 줄";
		expect(splitExcerpt(text)).toEqual([{ kind: "markdown", text }]);
	});
});

describe("repairHtmlFragment", () => {
	it("opens the table and row a leading orphan cell close belongs to", () => {
		expect(repairHtmlFragment("사용 시나리오</td><td>15</td></tr><tr><td>16</td></tr>")).toBe(
			"<table><tr><td>사용 시나리오</td><td>15</td></tr><tr><td>16</td></tr></table>",
		);
	});

	it("drops the tail of a tag the chunk started inside of", () => {
		expect(repairHtmlFragment('d colspan="2">값</td></tr>')).toBe("<table><tr><td>값</td></tr></table>");
	});

	it("drops a tag the chunk ended inside of and closes what is still open", () => {
		expect(repairHtmlFragment("<table><tr><td>20</td><td>기관별</td><td")).toBe("<table><tr><td>20</td><td>기관별</td></tr></table>");
	});

	it("wraps bare cells in a row and a table", () => {
		expect(repairHtmlFragment("<td>a</td><th>b</th>")).toBe("<table><tr><td>a</td><th>b</th></tr></table>");
	});

	it("leaves balanced non-table HTML unchanged", () => {
		expect(repairHtmlFragment("<p>a &amp; b</p><ul><li>x</li></ul>")).toBe("<p>a &amp; b</p><ul><li>x</li></ul>");
	});
});
