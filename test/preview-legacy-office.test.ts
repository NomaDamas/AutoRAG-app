import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isNativeThumbnailExtension } from "../src/main/file-icon";
import { LegacyOfficeError, readPowerPointDeck, readWordDocument } from "../src/preview/shared/legacy-office";
import { byteNeed, describeExtension, viewerForExtension } from "../src/preview/shared/registry";
import { buildCompoundFile, buildPowerPoint, buildWordDocument } from "./support/legacy-office-fixture";

function codeOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (error instanceof LegacyOfficeError) return error.code;
		throw error;
	}
	return "none";
}

describe("legacy Office routing", () => {
	it("sends Word and PowerPoint 97-2003 files to their viewers with the whole file", () => {
		for (const ext of ["doc", "dot", "DOC"]) expect(viewerForExtension(ext)).toBe("legacyDoc");
		for (const ext of ["ppt", "pps", "pot"]) expect(viewerForExtension(ext)).toBe("legacyPpt");
		expect(viewerForExtension("xlt")).toBe("sheet");
		expect(viewerForExtension("xls")).toBe("sheet");
		expect(byteNeed("legacyDoc")).toBe("whole");
		expect(byteNeed("legacyPpt")).toBe("whole");
		expect(describeExtension("doc")).toBe("Word 97-2003 document");
		expect(describeExtension("pps")).toBe("PowerPoint 97-2003 slide show");
	});

	it("asks Quick Look for first-page tile thumbnails of the legacy Office types", () => {
		for (const ext of ["doc", "dot", "ppt", "pps", "pot", "xls", "xlt"]) expect(isNativeThumbnailExtension(ext)).toBe(true);
		// docx/xlsx/pptx tiles stay off on purpose.
		for (const ext of ["docx", "xlsx", "pptx"]) expect(isNativeThumbnailExtension(ext)).toBe(false);
	});
});

describe("Word 97-2003 text", () => {
	it("reads UTF-16 and 8-bit pieces in document order, turning marks into line breaks", () => {
		const bytes = buildWordDocument([
			{ text: "제목 한글\r" },
			{ text: "caf\u00e9 \u201cquoted\u201d\r", compressed: true },
			{ text: "끝\r" },
		]);
		expect(readWordDocument(bytes).pages).toEqual(["제목 한글\ncafé “quoted”\n끝"]);
	});

	it("finds the piece table in 0Table and steps over a leading Prc clause", () => {
		const bytes = buildWordDocument([{ text: "zero table\r" }], { tableStream: "0Table", prefixPrc: true });
		expect(readWordDocument(bytes).pages).toEqual(["zero table"]);
	});

	it("splits pages on form feeds and reads table cells as tab-separated rows", () => {
		const bytes = buildWordDocument([{ text: "A\u0007B\u0007\u0007one\u000bline\r\u000cpage two\r" }]);
		expect(readWordDocument(bytes).pages).toEqual(["A\tB\none\nline", "page two"]);
	});

	it("keeps the visible result of a field and drops its instruction", () => {
		const bytes = buildWordDocument([{ text: "see \u0013 HYPERLINK \"http://example.test\" \u0014the site\u0015 now\r" }]);
		expect(readWordDocument(bytes).pages).toEqual(["see the site now"]);
	});

	it("shows only the main document, not footnote or header stories that follow it", () => {
		const bytes = buildWordDocument([{ text: "body\r" }], { trailing: "FOOTNOTE-TEXT\r" });
		const text = readWordDocument(bytes).pages.join("\n");
		expect(text).toContain("body");
		expect(text).not.toContain("FOOTNOTE");
	});

	it("reads a document written by a real word processor (macOS textutil)", () => {
		const bytes = new Uint8Array(readFileSync(new URL("./fixtures/word97-textutil.doc", import.meta.url)));
		const text = readWordDocument(bytes).pages.join("\n");
		expect(text).toContain("분기 보고서 Quarterly");
		expect(text).toContain("Hello world");
		expect(text).toContain("café");
		expect(text).toContain("둘째 쪽 Second page");
	});

	it("refuses encrypted, pre-Word-97, empty, and non-Word files with a reason the panel can show", () => {
		expect(codeOf(() => readWordDocument(buildWordDocument([{ text: "secret\r" }], { encrypted: true })))).toBe("encrypted");
		expect(codeOf(() => readWordDocument(buildWordDocument([{ text: "old\r" }], { nFib: 0x65 })))).toBe("unsupported");
		expect(codeOf(() => readWordDocument(buildWordDocument([{ text: "\r" }])))).toBe("empty");
		expect(codeOf(() => readWordDocument(buildCompoundFile({ Other: new Uint8Array([1, 2, 3]) })))).toBe("unsupported");
		expect(codeOf(() => readWordDocument(new Uint8Array([1, 2, 3, 4])))).toBe("corrupt");
	});

	it("never throws anything but LegacyOfficeError on damaged files and never reads past the stream", () => {
		const good = new Uint8Array(readFileSync(new URL("./fixtures/word97-textutil.doc", import.meta.url)));
		let seed = 12345;
		const next = (n: number): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed % n;
		};
		for (let round = 0; round < 200; round += 1) {
			const damaged = good.slice(0, round % 4 === 0 ? 4096 + next(good.length - 4096) : good.length);
			for (let flip = 0; flip < 12; flip += 1) damaged[next(damaged.length)] = next(256);
			const code = codeOf(() => readWordDocument(damaged));
			expect(["none", "encrypted", "unsupported", "corrupt", "empty"]).toContain(code);
		}
	});

	it("caps the text it returns and reports the cut", () => {
		const bytes = buildWordDocument([{ text: `${"x".repeat(2000)}\r`.repeat(400) }]);
		const result = readWordDocument(bytes, { maxChars: 50_000 });
		expect(result.truncated).toBe(true);
		expect(result.pages.join("").length).toBeLessThanOrEqual(50_000);
	});
});

describe("PowerPoint 97-2003 text", () => {
	it("reads every slide in show order with its title and body lines", () => {
		const bytes = buildPowerPoint([
			{ boxes: [{ text: "Quarterly plan", title: true }, { text: "Revenue up\rCosts flat" }] },
			{ boxes: [{ text: "한국어 슬라이드", title: true, bytes: false }, { text: "caf\u00e9", bytes: true }] },
		]);
		expect(readPowerPointDeck(bytes).slides).toEqual([
			{ title: "Quarterly plan", lines: ["Revenue up", "Costs flat"] },
			{ title: "한국어 슬라이드", lines: ["café"] },
		]);
	});

	it("uses the newest save of a slide, not the stale copy a fast save left behind", () => {
		const bytes = buildPowerPoint([{ boxes: [{ text: "Old title", title: true }] }, { boxes: [{ text: "Kept", title: true }] }], {
			edits: [{ replace: { 0: { boxes: [{ text: "New title", title: true }] } } }],
		});
		const deck = readPowerPointDeck(bytes);
		expect(deck.slides.map((slide) => slide.title)).toEqual(["New title", "Kept"]);
	});

	it("adds placeholder text the slide list keeps and does not repeat text found twice", () => {
		const bytes = buildPowerPoint([
			{ boxes: [{ text: "Shown twice" }], listText: [{ text: "From the list", title: true }, { text: "Shown twice" }] },
		]);
		expect(readPowerPointDeck(bytes).slides).toEqual([{ title: "From the list", lines: ["Shown twice"] }]);
	});

	it("refuses encrypted decks, broken edit chains, and files without a deck", () => {
		const slides = [{ boxes: [{ text: "x", title: true }] }];
		expect(codeOf(() => readPowerPointDeck(buildPowerPoint(slides, { encrypted: true })))).toBe("encrypted");
		expect(codeOf(() => readPowerPointDeck(buildPowerPoint(slides, { brokenCurrentUser: true })))).toBe("corrupt");
		expect(codeOf(() => readPowerPointDeck(buildCompoundFile({ Other: new Uint8Array([1]) })))).toBe("unsupported");
		expect(codeOf(() => readPowerPointDeck(buildPowerPoint([{ boxes: [] }])))).toBe("empty");
	});

	it("never throws anything but LegacyOfficeError on damaged decks", () => {
		const good = buildPowerPoint(
			[{ boxes: [{ text: "Title", title: true }, { text: "Body" }] }, { boxes: [{ text: "Two", title: true }] }],
			{ edits: [{ replace: { 1: { boxes: [{ text: "Two v2", title: true }] } } }] },
		);
		let seed = 99;
		const next = (n: number): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed % n;
		};
		for (let round = 0; round < 300; round += 1) {
			const damaged = good.slice();
			for (let flip = 0; flip < 8; flip += 1) damaged[next(damaged.length)] = next(256);
			const code = codeOf(() => readPowerPointDeck(damaged));
			expect(["none", "encrypted", "unsupported", "corrupt", "empty"]).toContain(code);
		}
	});
});
