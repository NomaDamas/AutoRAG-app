import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PDFDocument, rgb } from "pdf-lib";
import { createPdfEditorIo } from "../src/main/pdf-editor-io";

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
});
