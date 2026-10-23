import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { locateMarks, pdfRuns, type TextRun } from "../src/preview/shared/text-marks";

const run = (text: string, x: number, y: number, width: number, height = 10): TextRun => ({ text, x, y, width, height });

describe("locateMarks", () => {
	it("marks the cited span on its own page, cut to the characters it covers", () => {
		const pages = [[run("Cover page", 50, 40, 100)], [run("Intro text. ", 50, 40, 120), run("The refund is processed within five days.", 170, 40, 410)]];
		const marks = locateMarks(pages, ["refund is processed within five days"]);
		expect(marks).not.toBeNull();
		expect(marks!.page).toBe(1);
		expect(marks!.rects).toHaveLength(1);
		const [rect] = marks!.rects;
		// "The " is 4 of 41 characters, the cited span ends one character before the period.
		expect(rect!.x).toBeCloseTo(170 + (410 * 4) / 41, 5);
		expect(rect!.x + rect!.width).toBeCloseTo(170 + (410 * 40) / 41, 5);
		expect(rect!.y).toBe(40);
		expect(rect!.height).toBe(10);
	});

	it("uses a run's own character boundaries when the viewer reports them", () => {
		// 가 spans 0-5, 나 starts at 5, the run's right edge is 30: the cited 나…타 is 105 to 130.
		const text = "가나다라마바사아자차카타";
		const charX = [0, 5, ...Array.from({ length: 10 }, (_unused, index) => 8 + index * 2), 30];
		const pages = [[{ ...run(text, 100, 20, 30), charX }]];
		const marks = locateMarks(pages, ["나다라마바사아자차카타"]);
		expect(marks!.rects).toEqual([{ x: 105, y: 20, width: 25, height: 10 }]);
	});

	it("keeps the rest of an excerpt that crosses a page break on the next page", () => {
		const pages = [[run("First page ends with the start of a", 50, 700, 300)], [run("sentence that finishes here.", 50, 40, 250)]];
		const marks = locateMarks(pages, ["the start of a sentence that finishes here"]);
		expect(marks!.page).toBe(0);
		expect(marks!.rects).toHaveLength(1);
		expect(marks!.next).toEqual([{ page: 1, rects: [expect.objectContaining({ x: 50, y: 40 })] }]);
	});

	it("tries every excerpt and lands on the first one the document contains", () => {
		const pages = [[run("Only this sentence is in the document.", 0, 0, 300)]];
		const marks = locateMarks(pages, ["A sentence the model paraphrased beyond recognition entirely.", "Only this sentence is in the document"]);
		expect(marks).not.toBeNull();
		expect(marks!.excerpt).toBe(1);
	});

	it("gives null when no excerpt is in the document", () => {
		expect(locateMarks([[run("Nothing relevant here at all.", 0, 0, 200)]], ["completely different words"])).toBeNull();
		expect(locateMarks([], ["anything"])).toBeNull();
		expect(locateMarks([[run("text", 0, 0, 10)]], [])).toBeNull();
	});
});

describe("pdfRuns", () => {
	it("places pdf.js text items in top-left page units that line up with the rendered page", async () => {
		const pdf = await PDFDocument.create();
		const font = await pdf.embedFont(StandardFonts.Helvetica);
		const page = pdf.addPage([600, 800]);
		page.drawText("Refund policy overview", { x: 72, y: 700, size: 20, font });
		page.drawText("Exceptions need approval from an executive.", { x: 72, y: 400, size: 12, font });
		const fonts = createRequire(import.meta.url).resolve("pdfjs-dist/package.json").replace(/package\.json$/, "standard_fonts/");
		const task = getDocument({ data: await pdf.save(), verbosity: 0, standardFontDataUrl: fonts });
		try {
			const pdfPage = await (await task.promise).getPage(1);
			const runs = pdfRuns((await pdfPage.getTextContent()).items, pdfPage.getViewport({ scale: 1 }).transform);
			const heading = runs.find((item: TextRun) => item.text === "Refund policy overview");
			const body = runs.find((item: TextRun) => item.text.startsWith("Exceptions"));
			expect(heading).toBeDefined();
			expect(body).toBeDefined();
			expect(heading!.x).toBeCloseTo(72, 0);
			// Baseline 700 from the bottom of an 800pt page is 100 from the top; the box straddles it (82% above, 22% below).
			expect(heading!.y).toBeCloseTo(100 - 20 * 0.82, 0);
			expect(heading!.height).toBeCloseTo(20 * 1.04, 0);
			// pdf.js measures with its own copy of the standard font; within 1% of pdf-lib's Helvetica metrics.
			expect(Math.abs(heading!.width / font.widthOfTextAtSize("Refund policy overview", 20) - 1)).toBeLessThan(0.01);
			expect(body!.y).toBeCloseTo(400 - 12 * 0.82, 0);
			expect(body!.y).toBeGreaterThan(heading!.y);
		} finally {
			await task.destroy();
		}
	});
});
