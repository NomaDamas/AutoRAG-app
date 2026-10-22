import { describe, expect, it } from "vitest";
import {
	citedNumbers,
	imageTarget,
	isImageOnlyLine,
	parseAnswerBlocks,
	parseInline,
	splitAnswerParagraphs,
} from "../src/renderer/src/state/answer-markdown";

describe("parseInline", () => {
	it("splits bold spans, citation chips, and plain text in order", () => {
		expect(parseInline("최종 승인액은 **₩3.8억**이며 9월 15일 CFO가 승인했습니다. [2][4]")).toEqual([
			{ kind: "text", text: "최종 승인액은 " },
			{ kind: "bold", text: "₩3.8억" },
			{ kind: "text", text: "이며 9월 15일 CFO가 승인했습니다. " },
			{ kind: "citation", number: 2 },
			{ kind: "citation", number: 4 },
		]);
	});

	it("parses multi-digit citations and adjacent bold segments", () => {
		expect(parseInline("**합계** ₩380,000,000 [12]")).toEqual([
			{ kind: "bold", text: "합계" },
			{ kind: "text", text: " ₩380,000,000 " },
			{ kind: "citation", number: 12 },
		]);
	});

	it("keeps lone brackets that are not numeric citations as text", () => {
		expect(parseInline("0개면 [x] 그대로 [0] 둡니다")).toEqual([
			{ kind: "text", text: "0개면 [x] 그대로 [0] 둡니다" },
		]);
	});

	it("renders inline code and does not parse bold markers inside it", () => {
		expect(parseInline("`bun run **test**` 명령")).toEqual([
			{ kind: "code", text: "bun run **test**" },
			{ kind: "text", text: " 명령" },
		]);
	});

	it("leaves an unterminated bold marker as plain text", () => {
		expect(parseInline("중간에 **닫히지 않은 볼드")).toEqual([
			{ kind: "text", text: "중간에 **닫히지 않은 볼드" },
		]);
	});
});

describe("citedNumbers", () => {
	it("collects distinct citation numbers in first-seen order", () => {
		expect(citedNumbers("9명입니다 [6]. 현재는 [1][2][4][6].")).toEqual([6, 1, 2, 4]);
	});

	it("ignores non-citation brackets", () => {
		expect(citedNumbers("0개면 [x] 그대로 [0] 둡니다")).toEqual([]);
	});

	it("returns an empty list when the answer cites nothing", () => {
		expect(citedNumbers("근거 없는 문장입니다.")).toEqual([]);
	});
});

describe("splitAnswerParagraphs", () => {
	it("splits on blank lines and trims each paragraph", () => {
		expect(splitAnswerParagraphs("첫 단락입니다.\n\n  둘째 단락입니다.  \n\n\n셋째")).toEqual([
			"첫 단락입니다.",
			"둘째 단락입니다.",
			"셋째",
		]);
	});

	it("returns an empty list for empty input", () => {
		expect(splitAnswerParagraphs("")).toEqual([]);
	});
});

describe("parseAnswerBlocks", () => {
	it("parses headings, bullets, ordered items, quotes, and code fences", () => {
		const blocks = parseAnswerBlocks(
			[
				"## 요약",
				"본문 한 줄.",
				"- 첫 항목 [1]",
				"- 둘째 항목",
				"1. 순서 항목",
				"> 인용 문장",
				"```",
				"line1",
				"line2 [3]",
				"```",
				"마무리 **강조**",
			].join("\n"),
		);
		expect(blocks).toEqual([
			{ kind: "heading", text: "요약" },
			{ kind: "paragraph", text: "본문 한 줄." },
			{ kind: "list", text: "첫 항목 [1]" },
			{ kind: "list", text: "둘째 항목" },
			{ kind: "list", text: "순서 항목" },
			{ kind: "quote", text: "인용 문장" },
			{ kind: "code", text: "line1\nline2 [3]" },
			{ kind: "paragraph", text: "마무리 **강조**" },
		]);
	});

	it("skips blank lines and treats an unterminated fence as code to the end", () => {
		const blocks = parseAnswerBlocks("앞\n\n```\not{json}\n");
		expect(blocks).toEqual([
			{ kind: "paragraph", text: "앞" },
			{ kind: "code", text: "ot{json}" },
		]);
	});

	it("keeps a fence language line intact (```json opens the block)", () => {
		const blocks = parseAnswerBlocks("```json\n{\"a\":1}\n```");
		expect(blocks).toEqual([{ kind: "code", text: "{\"a\":1}" }]);
	});

	it("parses a GFM pipe table into a table block with header, alignment, and rows", () => {
		const blocks = parseAnswerBlocks(
			["비교는 다음과 같습니다.", "", "| 항목 | 금액 | 비고 |", "|:--|--:|:-:|", "| 로드맵 [1] | 18 | **중요** |", "| 운영 \\| 전략 | 19 |", "", "끝."].join("\n"),
		);
		expect(blocks).toEqual([
			{ kind: "paragraph", text: "비교는 다음과 같습니다." },
			{
				kind: "table",
				header: ["항목", "금액", "비고"],
				align: ["left", "right", "center"],
				rows: [
					["로드맵 [1]", "18", "**중요**"],
					["운영 | 전략", "19", ""],
				],
			},
			{ kind: "paragraph", text: "끝." },
		]);
	});

	it("does not read a pipe table inside a code fence as a table", () => {
		const blocks = parseAnswerBlocks("```\n| a | b |\n|---|---|\n| 1 | 2 |\n```");
		expect(blocks).toEqual([{ kind: "code", text: "| a | b |\n|---|---|\n| 1 | 2 |" }]);
	});

	it("keeps a lone line with a pipe as a paragraph and ends a table at the first non-table line", () => {
		expect(parseAnswerBlocks("A | B 중 하나")).toEqual([{ kind: "paragraph", text: "A | B 중 하나" }]);
		const blocks = parseAnswerBlocks("| a | b |\n|---|---|\n| 1 | 2 |\n- 목록");
		expect(blocks.map((block) => block.kind)).toEqual(["table", "list"]);
	});
});

describe("parseInline images", () => {
	it("parses a markdown image, keeping the citations around it", () => {
		expect(parseInline("차트 ![매출 차트](/Users/me/사진/매출 차트.png) [1]")).toEqual([
			{ kind: "text", text: "차트 " },
			{ kind: "image", target: "/Users/me/사진/매출 차트.png", alt: "매출 차트", source: "markdown" },
			{ kind: "text", text: " " },
			{ kind: "citation", number: 1 },
		]);
	});

	it("accepts the <ref> form and drops a markdown title", () => {
		expect(parseInline('![a](<C:\\My Docs\\a b.png>) ![b](imgs/b.jpg "제목")')).toEqual([
			{ kind: "image", target: "C:\\My Docs\\a b.png", alt: "a", source: "markdown" },
			{ kind: "text", text: " " },
			{ kind: "image", target: "imgs/b.jpg", alt: "b", source: "markdown" },
		]);
	});

	it("ends a bare path at the extension, leaving Korean particles and punctuation as text", () => {
		expect(parseInline("캡처는 /Users/me/screen-shot.PNG에 있습니다. 원본: C:\\pics\\a.jpeg.")).toEqual([
			{ kind: "text", text: "캡처는 " },
			{ kind: "image", target: "/Users/me/screen-shot.PNG", alt: "", source: "bare" },
			{ kind: "text", text: "에 있습니다. 원본: " },
			{ kind: "image", target: "C:\\pics\\a.jpeg", alt: "", source: "bare" },
			{ kind: "text", text: "." },
		]);
	});

	it("does not read a relative path, a URL path, or a longer extension as a bare image path", () => {
		for (const text of ["사진/a.png", "https://x.com/a.png", "/tmp/a.png.bak", "/tmp/a.pngx", "/tmp/archive.zip"]) {
			expect(parseInline(text).some((segment) => segment.kind === "image")).toBe(false);
		}
	});

	it("treats inline code holding an image path or URL as an image and other code as code", () => {
		expect(parseInline("`/Users/me/d.webp` `https://x.com/a.svg?v=2` `logo.png` `rm a.png`")).toEqual([
			{ kind: "image", target: "/Users/me/d.webp", alt: "", source: "code" },
			{ kind: "text", text: " " },
			{ kind: "image", target: "https://x.com/a.svg?v=2", alt: "", source: "code" },
			{ kind: "text", text: " " },
			{ kind: "code", text: "logo.png" },
			{ kind: "text", text: " " },
			{ kind: "code", text: "rm a.png" },
		]);
	});

	it("marks a line of only markdown images as image-only, but not a sentence with a path", () => {
		expect(isImageOnlyLine(parseInline(" ![a](/a.png) ![b](/b.png) "))).toBe(true);
		expect(isImageOnlyLine(parseInline("위치: /a.png"))).toBe(false);
		expect(isImageOnlyLine(parseInline("그림 없음"))).toBe(false);
	});
});

describe("imageTarget", () => {
	it("resolves absolute paths and file URLs as local, flagging formats <img> cannot draw", () => {
		expect(imageTarget("/Users/me/a%20b.png", null)).toEqual({ kind: "local", path: "/Users/me/a b.png", name: "a b.png", renderable: true });
		expect(imageTarget("file:///C:/pics/x.HEIC", null)).toEqual({ kind: "local", path: "C:\\pics\\x.HEIC", name: "x.HEIC", renderable: false });
		expect(imageTarget("D:\\scan.tiff", null)).toMatchObject({ kind: "local", renderable: false });
	});

	it("resolves a relative link against the document folder, never above its root", () => {
		expect(imageTarget("images/fig%201.png", "/Users/me/docs")).toMatchObject({ kind: "local", path: "/Users/me/docs/images/fig 1.png" });
		expect(imageTarget("../a.png", "C:\\docs")).toEqual({ kind: "local", path: "C:\\a.png", name: "a.png", renderable: true });
		expect(imageTarget("images/a.png", null)).toEqual({ kind: "unresolved", text: "images/a.png" });
		expect(imageTarget("data:image/png;base64,AAAA", "/docs")).toEqual({ kind: "unresolved", text: "data:image/png;base64,AAAA" });
	});

	it("keeps web images as URLs (never fetched) and rejects other schemes", () => {
		expect(imageTarget("https://example.com/logo.png", null)).toEqual({ kind: "web", url: "https://example.com/logo.png" });
		expect(imageTarget("javascript:alert(1)//a.png", "/docs")).toEqual({ kind: "unresolved", text: "javascript:alert(1)//a.png" });
	});
});
