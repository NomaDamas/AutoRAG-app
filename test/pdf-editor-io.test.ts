import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PDFDocument, rgb } from "pdf-lib";
import { createPdfEditorIo } from "../src/main/pdf-editor-io";
import { isPdfEditOperation } from "../src/shared/document-editor-contract";

// Minimal valid 1x1 red PNG as base64 data URL.
const ONE_PX_PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const tempDirs: string[] = [];

function makeWorkDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "dazzi-pdf-editor-io-"));
	tempDirs.push(dir);
	return dir;
}

async function createSamplePdf(filePath: string, pageSizes: readonly [number, number][] = [[600, 800], [600, 800], [600, 800]]): Promise<void> {
	const pdf = await PDFDocument.create();
	for (const [w, h] of pageSizes) {
		const page = pdf.addPage([w, h]);
		page.drawRectangle({ x: 40, y: 40, width: 100, height: 40, color: rgb(0.2, 0.4, 0.8) });
	}
	writeFileSync(filePath, await pdf.save());
}

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("pdf editor I/O (pdf-lib)", () => {
	it("inspects PDF metadata including pageCount", async () => {
		const dir = makeWorkDir();
		const pdfPath = join(dir, "contract.pdf");
		await createSamplePdf(pdfPath);
		const io = createPdfEditorIo(join(dir, "backups"));

		const info = await io.open(pdfPath);
		expect(info.kind).toBe("pdf");
		expect(info.pageCount).toBe(3);
		expect(info.encrypted).toBe(false);
	});

	it("stamps signature PNG, rotates, crops, moves, deletes pages, and restores via snapshot undo", async () => {
		const dir = makeWorkDir();
		const pdfPath = join(dir, "contract.pdf");
		await createSamplePdf(pdfPath, [
			[600, 800],
			[400, 500],
			[700, 900],
		]);
		const originalBytes = readFileSync(pdfPath);
		const io = createPdfEditorIo(join(dir, "backups"));

		// 1. Stamp PNG + rotate page 0 + crop page 0
		const step1 = await io.apply({
			path: pdfPath,
			operations: [
				{ kind: "stampImage", pageIndex: 0, pngDataUrl: ONE_PX_PNG, x: 0.5, y: 0.7, width: 0.3, height: 0.1 },
				{ kind: "rotatePage", pageIndex: 0, deltaDegrees: 90 },
				{ kind: "cropPage", pageIndex: 1, left: 0.1, top: 0.2, width: 0.5, height: 0.5 },
			],
		});
		expect(step1.ok).toBe(true);
		if (!step1.ok) return;
		expect(step1.pageCount).toBe(3);

		const after1 = await PDFDocument.load(readFileSync(pdfPath));
		expect(after1.getPage(0).getRotation().angle).toBe(90);
		const cropBox = after1.getPage(1).getCropBox();
		expect(cropBox.x).toBeCloseTo(40, 1);
		expect(cropBox.width).toBeCloseTo(200, 1);
		expect(cropBox.height).toBeCloseTo(250, 1);
		// top=0.2, height=0.5 of 500 -> bottom = (1 - 0.2 - 0.5) * 500 = 150
		expect(cropBox.y).toBeCloseTo(150, 1);

		// 2. Move page 2 -> 0 and delete page 1
		const step2 = await io.apply({
			path: pdfPath,
			operations: [
				{ kind: "movePage", fromIndex: 2, toIndex: 0 },
				{ kind: "deletePage", pageIndex: 1 },
			],
		});
		expect(step2.ok).toBe(true);
		if (!step2.ok) return;
		expect(step2.pageCount).toBe(2);

		const after2 = await PDFDocument.load(readFileSync(pdfPath));
		expect(after2.getPageCount()).toBe(2);
		// Former page 2 (700x900) is now page 0
		expect(after2.getPage(0).getSize()).toEqual({ width: 700, height: 900 });

		// 3. Undo step2 then step1 restores exact original bytes
		const undo2 = await io.restore(step2.snapshotId);
		expect(undo2.ok).toBe(true);
		expect(undo2.pageCount).toBe(3);

		const undo1 = await io.restore(step1.snapshotId);
		expect(undo1.ok).toBe(true);
		expect(readFileSync(pdfPath).equals(originalBytes)).toBe(true);

		await io.dispose();
	});

	it("refuses deleting the last remaining page", async () => {
		const dir = makeWorkDir();
		const pdfPath = join(dir, "single.pdf");
		await createSamplePdf(pdfPath, [[600, 800]]);
		const io = createPdfEditorIo(join(dir, "backups"));

		await expect(
			io.apply({
				path: pdfPath,
				operations: [{ kind: "deletePage", pageIndex: 0 }],
			}),
		).rejects.toThrow();
	});

	it("extracts selected 1-based pages into a new sibling PDF without modifying the source", async () => {
		const dir = makeWorkDir();
		const pdfPath = join(dir, "deck.pdf");
		await createSamplePdf(pdfPath, [
			[600, 800],
			[400, 500],
			[700, 900],
		]);
		const io = createPdfEditorIo(join(dir, "backups"));

		const extracted = await io.extract({ path: pdfPath, pages: [1, 3] });
		expect(extracted.pageCount).toBe(2);
		expect(extracted.name).toMatch(/^deck-p1-3.*\.pdf$/);

		const outPdf = await PDFDocument.load(readFileSync(extracted.outputPath));
		expect(outPdf.getPageCount()).toBe(2);
		expect(outPdf.getPage(0).getSize()).toEqual({ width: 600, height: 800 });
		expect(outPdf.getPage(1).getSize()).toEqual({ width: 700, height: 900 });

		// Original stays 3 pages
		const srcPdf = await PDFDocument.load(readFileSync(pdfPath));
		expect(srcPdf.getPageCount()).toBe(3);
	});

	it("duplicates a page and inserts blank pages (match, a4, letter)", async () => {
		const dir = makeWorkDir();
		const pdfPath = join(dir, "pages.pdf");
		await createSamplePdf(pdfPath, [
			[500, 700],
			[600, 800],
		]);
		const io = createPdfEditorIo(join(dir, "backups"));

		const res = await io.apply({
			path: pdfPath,
			operations: [
				{ kind: "duplicatePage", pageIndex: 0 },
				{ kind: "insertBlankPage", insertAtIndex: 3, size: "a4" },
				{ kind: "insertBlankPage", insertAtIndex: 0, size: "letter" },
			],
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.pageCount).toBe(5);

		const loaded = await PDFDocument.load(readFileSync(pdfPath));
		expect(loaded.getPage(0).getSize()).toEqual({ width: 612, height: 792 }); // letter
		expect(loaded.getPage(1).getSize()).toEqual({ width: 500, height: 700 }); // original 0
		expect(loaded.getPage(2).getSize()).toEqual({ width: 500, height: 700 }); // duplicate of 0
		expect(loaded.getPage(3).getSize()).toEqual({ width: 600, height: 800 }); // original 1
		expect(loaded.getPage(4).getSize().width).toBeCloseTo(595.28, 1); // a4
		expect(loaded.getPage(4).getSize().height).toBeCloseTo(841.89, 1);
	});

	it("merges another PDF into the active PDF at a given insertAtIndex and supports undo", async () => {
		const dir = makeWorkDir();
		const basePdf = join(dir, "base.pdf");
		const appendPdf = join(dir, "append.pdf");
		await createSamplePdf(basePdf, [
			[600, 800],
			[600, 800],
		]);
		await createSamplePdf(appendPdf, [
			[300, 400],
			[350, 450],
		]);
		const io = createPdfEditorIo(join(dir, "backups"));

		const res = await io.apply({
			path: basePdf,
			operations: [{ kind: "mergePdfs", sourcePaths: [appendPdf], insertAtIndex: 1 }],
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.pageCount).toBe(4);

		const merged = await PDFDocument.load(readFileSync(basePdf));
		expect(merged.getPage(0).getSize()).toEqual({ width: 600, height: 800 });
		expect(merged.getPage(1).getSize()).toEqual({ width: 300, height: 400 });
		expect(merged.getPage(2).getSize()).toEqual({ width: 350, height: 450 });
		expect(merged.getPage(3).getSize()).toEqual({ width: 600, height: 800 });

		const undone = await io.restore(res.snapshotId);
		expect(undone.ok).toBe(true);
		expect(undone.pageCount).toBe(2);
	});

	it("splits a PDF by chunkSize, by custom ranges, and into single pages", async () => {
		const dir = makeWorkDir();
		const pdfPath = join(dir, "book.pdf");
		await createSamplePdf(pdfPath, [
			[500, 700],
			[510, 700],
			[520, 700],
			[530, 700],
			[540, 700],
		]);
		const io = createPdfEditorIo(join(dir, "backups"));

		const everyTwo = await io.split({ path: pdfPath, mode: "everyN", chunkSize: 2 });
		expect(everyTwo.outputs.map((o) => o.pageCount)).toEqual([2, 2, 1]);
		const firstChunk = await PDFDocument.load(readFileSync(everyTwo.outputs[0]!.outputPath));
		expect(firstChunk.getPage(0).getSize().width).toBe(500);
		expect(firstChunk.getPage(1).getSize().width).toBe(510);

		const byRanges = await io.split({ path: pdfPath, mode: "ranges", rangesSpec: "1-2, 4-5" });
		expect(byRanges.outputs.map((o) => o.pageCount)).toEqual([2, 2]);
		const secondRange = await PDFDocument.load(readFileSync(byRanges.outputs[1]!.outputPath));
		expect(secondRange.getPage(0).getSize().width).toBe(530);
		expect(secondRange.getPage(1).getSize().width).toBe(540);

		const singles = await io.split({ path: pdfPath, mode: "singlePages" });
		expect(singles.outputs).toHaveLength(5);
		expect(singles.outputs.every((o) => o.pageCount === 1)).toBe(true);
	});

	it("applies highlight, redaction/whiteout, shapes, freehand strokes, watermark, and page numbers", async () => {
		const dir = makeWorkDir();
		const pdfPath = join(dir, "annotate.pdf");
		await createSamplePdf(pdfPath, [
			[600, 800],
			[600, 800],
		]);
		const originalSize = readFileSync(pdfPath).byteLength;
		const io = createPdfEditorIo(join(dir, "backups"));

		const res = await io.apply({
			path: pdfPath,
			operations: [
				{ kind: "highlightRect", pageIndex: 0, x: 0.1, y: 0.1, width: 0.4, height: 0.05, color: "#FDE047", opacity: 0.35 },
				{ kind: "redactRect", pageIndex: 0, x: 0.1, y: 0.2, width: 0.3, height: 0.04, color: "#000000" },
				{ kind: "drawShape", pageIndex: 0, shape: "rect", x1: 0.1, y1: 0.3, x2: 0.4, y2: 0.4, strokeColor: "#DC2626", strokeWidthPt: 2 },
				{ kind: "drawShape", pageIndex: 0, shape: "ellipse", x1: 0.5, y1: 0.3, x2: 0.8, y2: 0.45, strokeColor: "#2563EB", strokeWidthPt: 2 },
				{ kind: "drawShape", pageIndex: 0, shape: "arrow", x1: 0.1, y1: 0.5, x2: 0.6, y2: 0.6, strokeColor: "#16A34A", strokeWidthPt: 2.5 },
				{
					kind: "freehandPath",
					pageIndex: 1,
					points: [
						{ x: 0.1, y: 0.1 },
						{ x: 0.2, y: 0.15 },
						{ x: 0.35, y: 0.12 },
					],
					strokeColor: "#111827",
					strokeWidthPt: 2,
				},
				{ kind: "addWatermark", pngDataUrl: ONE_PX_PNG, opacity: 0.2, scale: 0.6 },
				{
					kind: "addPageNumbers",
					position: "bottom-center",
					format: "ofTotal",
					startNumber: 1,
					fontSize: 10,
					color: "#334155",
					headerText: "CONFIDENTIAL",
				},
			],
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.pageCount).toBe(2);
		expect(res.size).toBeGreaterThan(originalSize);
		const reloaded = await PDFDocument.load(readFileSync(pdfPath));
		expect(reloaded.getPageCount()).toBe(2);
	});

	it("reads and updates PDF document metadata (title, author, subject, keywords)", async () => {
		const dir = makeWorkDir();
		const pdfPath = join(dir, "meta.pdf");
		await createSamplePdf(pdfPath, [[600, 800]]);
		const io = createPdfEditorIo(join(dir, "backups"));

		const before = await io.readMetadata(pdfPath);
		expect(before.title).toBe("");

		const res = await io.apply({
			path: pdfPath,
			operations: [
				{
					kind: "setMetadata",
					metadata: {
						title: "Q4 Contract",
						author: "Jeffrey Kim",
						subject: "Partnership Agreement",
						keywords: "contract, legal, 2026",
					},
				},
			],
		});
		expect(res.ok).toBe(true);

		const after = await io.readMetadata(pdfPath);
		expect(after).toEqual({
			title: "Q4 Contract",
			author: "Jeffrey Kim",
			subject: "Partnership Agreement",
			keywords: "contract, legal, 2026",
		});
	});

	it("reads, fills, and optionally flattens AcroForm fields", async () => {
		const dir = makeWorkDir();
		const pdfPath = join(dir, "form.pdf");
		const doc = await PDFDocument.create();
		const page = doc.addPage([600, 800]);
		const form = doc.getForm();
		const nameField = form.createTextField("applicant_name");
		nameField.setText("Alice");
		nameField.addToPage(page, { x: 50, y: 700, width: 200, height: 24 });
		const agreeField = form.createCheckBox("agree_terms");
		agreeField.addToPage(page, { x: 50, y: 650, width: 18, height: 18 });
		const roleField = form.createDropdown("role");
		roleField.addOptions(["Manager", "Engineer", "Designer"]);
		roleField.select("Engineer");
		roleField.addToPage(page, { x: 50, y: 600, width: 160, height: 24 });
		writeFileSync(pdfPath, await doc.save());

		const io = createPdfEditorIo(join(dir, "backups"));
		const fields = await io.readFormFields(pdfPath);
		expect(fields).toHaveLength(3);
		expect(fields.find((f) => f.name === "applicant_name")).toMatchObject({ kind: "text", value: "Alice" });
		expect(fields.find((f) => f.name === "agree_terms")).toMatchObject({ kind: "checkbox", value: false });
		expect(fields.find((f) => f.name === "role")).toMatchObject({
			kind: "dropdown",
			value: "Engineer",
			options: ["Manager", "Engineer", "Designer"],
		});

		const saved = await io.saveFormFields({
			path: pdfPath,
			values: { applicant_name: "Bob", agree_terms: true, role: "Designer" },
			flatten: false,
		});
		expect(saved.ok).toBe(true);

		const updated = await io.readFormFields(pdfPath);
		expect(updated.find((f) => f.name === "applicant_name")?.value).toBe("Bob");
		expect(updated.find((f) => f.name === "agree_terms")?.value).toBe(true);
		expect(updated.find((f) => f.name === "role")?.value).toBe("Designer");

		const flattened = await io.saveFormFields({
			path: pdfPath,
			values: { applicant_name: "Bob", agree_terms: true, role: "Designer" },
			flatten: true,
		});
		expect(flattened.ok).toBe(true);
		const afterFlatten = await io.readFormFields(pdfPath);
		expect(afterFlatten).toHaveLength(0);
	});

	it("draws rendered header/footer lines (any script) on every page instead of dropping non-Latin text", async () => {
		const dir = makeWorkDir();
		const pdfPath = join(dir, "numbers.pdf");
		await createSamplePdf(pdfPath, [[300, 300], [300, 300]]);
		const io = createPdfEditorIo(join(dir, "backups"));
		const { encodePng } = await import("../src/preview/node/png-encode");
		const solid = new Uint8Array(40 * 10 * 4);
		for (let i = 0; i < solid.length; i += 4) solid.set([20, 20, 20, 255], i);
		const line = { pngDataUrl: `data:image/png;base64,${Buffer.from(encodePng(solid, 40, 10)).toString("base64")}`, widthPt: 80, heightPt: 14 };
		const res = await io.apply({
			path: pdfPath,
			operations: [
				{ kind: "addPageNumbers", position: "bottom-right", format: "number", startNumber: 1, fontSize: 10, color: "#334155", headerText: "대외비 문서", headerImage: line, footerText: "社外秘", footerImage: line },
			],
		});
		expect(res.ok).toBe(true);
		const { decode, toRGBA8 } = await import("@pdf-lib/upng");
		for (const pageNumber of [1, 2]) {
			const rendered = await io.renderPageToPng(pdfPath, pageNumber, { dpi: 72 });
			const image = decode(rendered.png.buffer.slice(rendered.png.byteOffset, rendered.png.byteOffset + rendered.png.byteLength) as ArrayBuffer);
			const rgba = new Uint8Array(toRGBA8(image)[0]!);
			const at = (x: number, yFromTop: number): number => rgba[(Math.round(yFromTop) * image.width + Math.round(x)) * 4]!;
			// Header centred at the top (24pt margin), footer at the bottom-left (page number sits bottom-right).
			// PDF y (bottom-origin) of the header band's centre is 300 - 24 - 10 + 3.5 = 269.5, i.e. 30.5pt from the top.
			expect(at(150, 300 - (300 - 24 - 10 + 3.5)), `page ${pageNumber} header`).toBeLessThan(80);
			expect(at(24 + 40, 300 - 24 - 3.5), `page ${pageNumber} footer`).toBeLessThan(80);
		}
		expect(isPdfEditOperation({ kind: "addPageNumbers", position: "bottom-center", format: "number", startNumber: 1, fontSize: 10, color: "#334155", headerImage: { ...line, widthPt: -1 } })).toBe(false);
	});

	it("draws arrows with a filled head (not two thin wings) and reports rotation-aware page sizes", async () => {
		const dir = makeWorkDir();
		const pdfPath = join(dir, "arrow.pdf");
		await createSamplePdf(pdfPath, [[300, 300]]);
		const io = createPdfEditorIo(join(dir, "backups"));
		const res = await io.apply({
			path: pdfPath,
			operations: [{ kind: "drawShape", pageIndex: 0, shape: "arrow", x1: 0.1, y1: 0.5, x2: 0.9, y2: 0.5, strokeColor: "#DC2626", strokeWidthPt: 1.5 }],
		});
		expect(res.ok).toBe(true);
		const { decode, toRGBA8 } = await import("@pdf-lib/upng");
		const rendered = await io.renderPageToPng(pdfPath, 1, { dpi: 200 });
		const image = decode(rendered.png.buffer.slice(rendered.png.byteOffset, rendered.png.byteOffset + rendered.png.byteLength) as ArrayBuffer);
		const rgba = new Uint8Array(toRGBA8(image)[0]!);
		const pxPerPt = image.width / 300;
		const at = (xPt: number, yFromTopPt: number): number[] => {
			const p = (Math.round(yFromTopPt * pxPerPt) * image.width + Math.round(xPt * pxPerPt)) * 4;
			return [...rgba.subarray(p, p + 3)];
		};
		// 8pt behind the tip (x = 270pt) and 3pt off the axis: inside a filled head, but between the old impl's shaft and wings.
		const inside = at(262, 150 - 3);
		expect(inside[0]).toBeGreaterThan(170);
		expect(inside[1]).toBeLessThan(110);
		// Just past the tip stays clear: the shaft does not poke through.
		const past = at(273, 150);
		expect(past[1]).toBeGreaterThan(200);

		const rotated = join(dir, "rotated.pdf");
		await createSamplePdf(rotated, [[600, 800]]);
		await io.apply({ path: rotated, operations: [{ kind: "rotatePage", pageIndex: 0, deltaDegrees: 90 }] });
		expect(await io.pageVisualSize(rotated, 0)).toMatchObject({ widthPt: 800, heightPt: 600, pageCount: 1 });
		await expect(io.pageVisualSize(rotated, 1)).rejects.toThrow(/out of range/);
	});

	it("renders any PDF page to PNG bytes for visual agent inspection and Visual QA", async () => {
		const dir = makeWorkDir();
		const pdfPath = join(dir, "visual-qa.pdf");
		await createSamplePdf(pdfPath, [
			[600, 800], // page 1 portrait
			[960, 540], // page 2 landscape 16:9
		]);
		const io = createPdfEditorIo(join(dir, "backups"));

		const p1 = await io.renderPageToPng(pdfPath, 1, { dpi: 120 });
		expect(p1.pageNumber).toBe(1);
		expect(p1.pageIndex).toBe(0);
		expect(p1.pageCount).toBe(2);
		expect(p1.widthPt).toBe(600);
		expect(p1.heightPt).toBe(800);
		expect(p1.png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
		expect(p1.imageHeightPx).toBeGreaterThan(p1.imageWidthPx);

		const p2 = await io.renderPageToPng(pdfPath, 2, { dpi: 120 });
		expect(p2.pageNumber).toBe(2);
		expect(p2.widthPt).toBe(960);
		expect(p2.heightPt).toBe(540);
		expect(p2.imageWidthPx).toBeGreaterThan(p2.imageHeightPx);

		await expect(io.renderPageToPng(pdfPath, 3)).rejects.toThrow(/out of range/i);
	});
});
