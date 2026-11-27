import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, strToU8, zipSync } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as UTIF from "utif";
import { utils, write } from "xlsx";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listArchive } from "../src/main/archive-list";
import * as nativeLoader from "../src/main/dazzi-native-core";
import { findPdfAnchorPages } from "../src/preview/node/pdf-anchor";
import { encodePng } from "../src/preview/node/png-encode";
import { readPsdComposite } from "../src/preview/node/psd-preview";
import { previewSheetFile } from "../src/preview/node/sheet";
import { readTiffPreview, TIFF_DECODE_MAX_SIDE, TIFF_PREVIEW_MIME } from "../src/preview/node/tiff";
import { readSheetPreview, SHEET_MAX_COLS, SHEET_MAX_ROWS } from "../src/preview/shared/sheet";
import { summarizeArchive } from "../src/preview/shared/archive-items";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	const pending = tempDirs.splice(0);
	await Promise.all(pending.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function makeXlsx(sheets: Readonly<Record<string, readonly (readonly (string | number)[])[]>>): Uint8Array {
	const book = utils.book_new();
	for (const [name, rows] of Object.entries(sheets)) {
		utils.book_append_sheet(book, utils.aoa_to_sheet(rows.map((r) => [...r])), name);
	}
	return new Uint8Array(write(book, { type: "array", bookType: "xlsx" }));
}

function makeTar(entries: readonly { readonly name: string; readonly body: string; readonly mtimeSec: number }[]): Uint8Array {
	const blocks: Uint8Array[] = [];
	const enc = new TextEncoder();
	for (const item of entries) {
		const body = enc.encode(item.body);
		const hdr = new Uint8Array(512);
		hdr.set(enc.encode(item.name).subarray(0, 100), 0);
		hdr.set(enc.encode("0000644\0"), 100);
		hdr.set(enc.encode("0000000\0"), 108);
		hdr.set(enc.encode("0000000\0"), 116);
		hdr.set(enc.encode(`${body.length.toString(8).padStart(11, "0")}\0`), 124);
		hdr.set(enc.encode(`${item.mtimeSec.toString(8).padStart(11, "0")}\0`), 136);
		hdr.set(enc.encode("        "), 148);
		hdr[156] = 0x30; // '0'
		hdr.set(enc.encode("ustar\0"), 257);
		hdr.set(enc.encode("00"), 263);
		let sum = 0;
		for (let i = 0; i < 512; i += 1) sum += hdr[i]!;
		hdr.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
		blocks.push(hdr);
		if (body.length > 0) {
			const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
			padded.set(body);
			blocks.push(padded);
		}
	}
	blocks.push(new Uint8Array(1024));
	const total = blocks.reduce((s, b) => s + b.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const b of blocks) {
		out.set(b, off);
		off += b.length;
	}
	return out;
}

describe("dazzi-native-core Tier 1 preview acceleration", () => {
	it("streams XLSX workbooks with exact parity against SheetJS (multi-sheet, Korean, sparse cells, row/col caps)", async () => {
		const dir = await makeTempDir("preview-rust-xlsx-");
		const rowsA: (string | number)[][] = Array.from({ length: 150 }, (_, r) =>
			Array.from({ length: 25 }, (_, c) => (c === 0 ? `항목_${r}` : r * 100 + c)),
		);
		const rowsB: (string | number)[][] = [
			["이름", "부서", "금액"],
			["김민수", "개발", 1200],
			[],
			["이지은", "디자인", 980],
		];
		const bytes = makeXlsx({ 매출내역: rowsA, 인원: rowsB });
		const filePath = join(dir, "sample.xlsx");
		await writeFile(filePath, bytes);

		const rust0 = await previewSheetFile(filePath, 0);
		const rust1 = await previewSheetFile(filePath, 1);

		const js0 = readSheetPreview(bytes, 0);
		const js1 = readSheetPreview(bytes, 1);

		expect(rust0.names).toEqual(js0.names);
		expect(rust0.rows).toEqual(js0.rows);
		expect(rust0.rows).toHaveLength(SHEET_MAX_ROWS);
		expect(rust0.rows[0]).toHaveLength(SHEET_MAX_COLS);
		expect(rust1.names).toEqual(js1.names);
		expect(rust1.rows).toEqual(js1.rows);
	});

	it("streams CSV/TSV across UTF-8, UTF-8 BOM, UTF-16 LE, and CP949 with SheetJS parity", async () => {
		const dir = await makeTempDir("preview-rust-csv-");
		const expected = [
			["이름", "부서", "금액"],
			["김민수", "영업", "1200"],
			["이지은", "마케팅", "980"],
		];
		const text = "이름,부서,금액\n김민수,영업,1200\n이지은,마케팅,980\n";
		const utf8Bytes = new TextEncoder().encode(text);

		// UTF-8 plain
		const utf8Path = join(dir, "plain.csv");
		await writeFile(utf8Path, utf8Bytes);
		expect((await previewSheetFile(utf8Path, 0)).rows).toEqual(expected);

		// UTF-8 BOM
		const bomPath = join(dir, "bom.csv");
		await writeFile(bomPath, Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8Bytes]));
		expect((await previewSheetFile(bomPath, 0)).rows).toEqual(expected);

		// TSV
		const tsvPath = join(dir, "tab.tsv");
		await writeFile(tsvPath, text.replaceAll(",", "\t"));
		expect((await previewSheetFile(tsvPath, 0)).rows).toEqual(expected);

		// CP949 (Korean Windows Excel CSV)
		const cp949Path = join(dir, "cp949.csv");
		await writeFile(
			cp949Path,
			Uint8Array.from([
				0xc0, 0xcc, 0xb8, 0xa7, 0x2c, 0xba, 0xce, 0xbc, 0xad, 0x0a,
				0xb1, 0xe8, 0xb9, 0xce, 0xbc, 0xf6, 0x2c, 0xbf, 0xb5, 0xbe, 0xf7, 0x0a,
			]),
		);
		expect((await previewSheetFile(cp949Path, 0)).rows).toEqual([
			["이름", "부서"],
			["김민수", "영업"],
		]);

		// UTF-16 LE BOM
		const u16 = Array.from("이름,부서\n김민수,영업\n", (ch) => ch.charCodeAt(0));
		const u16Bytes = new Uint8Array(2 + u16.length * 2);
		u16Bytes.set([0xff, 0xfe]);
		u16.forEach((u, i) => {
			u16Bytes[2 + i * 2] = u & 0xff;
			u16Bytes[3 + i * 2] = u >> 8;
		});
		const u16Path = join(dir, "utf16.csv");
		await writeFile(u16Path, u16Bytes);
		expect((await previewSheetFile(u16Path, 0)).rows).toEqual([
			["이름", "부서"],
			["김민수", "영업"],
		]);
	});

	it("falls back cleanly to SheetJS for legacy OLE2 .xls workbooks without losing compatibility", async () => {
		const dir = await makeTempDir("preview-rust-xls-");
		const book = utils.book_new();
		utils.book_append_sheet(book, utils.aoa_to_sheet([["colA", "colB"], ["v1", "v2"]]), "Legacy");
		const xlsBytes = new Uint8Array(write(book, { type: "array", bookType: "biff8" }));
		const xlsPath = join(dir, "legacy.xls");
		await writeFile(xlsPath, xlsBytes);

		const res = await previewSheetFile(xlsPath, 0);
		expect(res.names).toEqual(["Legacy"]);
		expect(res.rows).toEqual([
			["colA", "colB"],
			["v1", "v2"],
		]);
	});

	it("decodes & downscales a >8MB TIFF natively to PNG on every platform (unlocking large TIFFs on Windows)", async () => {
		const dir = await makeTempDir("preview-rust-tiff-");
		// 2400x1200 RGBA = ~11.5MB uncompressed (> 8MB Windows UTIF cap, > 2048px maxSide)
		const w = 2400;
		const h = 1200;
		const rgba = new Uint8Array(w * h * 4);
		for (let y = 0; y < h; y += 1) {
			for (let x = 0; x < w; x += 1) {
				const o = (y * w + x) * 4;
				rgba[o] = x < w / 2 ? 255 : 0;
				rgba[o + 1] = 0;
				rgba[o + 2] = x < w / 2 ? 0 : 255;
				rgba[o + 3] = 255;
			}
		}
		const tiffPath = join(dir, "big-scan.tif");
		await writeFile(tiffPath, new Uint8Array(UTIF.encodeImage(rgba, w, h)));

		const doc = await readTiffPreview(tiffPath, { platform: "win32" });
		expect(doc.mime).toBe(TIFF_PREVIEW_MIME);
		expect(doc.truncated).toBe(false);
		expect(doc.bytes).not.toBeNull();
		// Verify valid PNG header + IHDR dimensions downscaled to <= 2048px
		const bytes = doc.bytes!;
		expect(Array.from(bytes.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const outW = view.getUint32(16);
		const outH = view.getUint32(20);
		expect(outW).toBe(TIFF_DECODE_MAX_SIDE);
		expect(outH).toBe(Math.floor((h * TIFF_DECODE_MAX_SIDE) / w));
	});

	it("produces valid PNG bytes from downscaleAndEncodePngNative matching JS encoder dimensions", () => {
		const native = nativeLoader.loadDazziNativeCore()!;
		const w = 100;
		const h = 50;
		const rgba = new Uint8Array(w * h * 4).fill(128);
		const nativePng = native.downscaleAndEncodePngNative(rgba, w, h, 40);
		const jsPng = encodePng(new Uint8Array(40 * 20 * 4).fill(128), 40, 20);
		const nv = new DataView(nativePng.buffer, nativePng.byteOffset, nativePng.byteLength);
		const jv = new DataView(jsPng.buffer, jsPng.byteOffset, jsPng.byteLength);
		expect(nv.getUint32(16)).toBe(jv.getUint32(16));
		expect(nv.getUint32(20)).toBe(jv.getUint32(20));
	});

	it("locates exact candidate pages in a 120-page PDF via findPdfAnchorPages", async () => {
		const dir = await makeTempDir("preview-rust-pdf-");
		const doc = await PDFDocument.create();
		const font = await doc.embedFont(StandardFonts.Helvetica);
		for (let p = 1; p <= 120; p += 1) {
			const page = doc.addPage([612, 792]);
			page.drawText(`Page ${p} standard financial overview`, { x: 40, y: 720, size: 11, font });
			if (p === 87) {
				page.drawText("Unique needle: Consolidated Statements of Cash Flows 2026Q4", { x: 40, y: 680, size: 11, font });
			}
		}
		const pdfPath = join(dir, "annual-120p.pdf");
		await writeFile(pdfPath, await doc.save());

		const candidates = await findPdfAnchorPages(pdfPath, ["Consolidated Statements of Cash Flows 2026Q4"]);
		expect(candidates).toContain(87);
		expect(candidates[0]).toBe(87);

		// Non-existent excerpt returns empty array (so PdfView falls back safely)
		expect(await findPdfAnchorPages(pdfPath, ["completely nonexistent clause xyz999"])).toEqual([]);
	});

	it("streams large 15,000-entry tar.gz and zip archives natively without libarchive-wasm OOM", async () => {
		const dir = await makeTempDir("preview-rust-archive-");
		const entries = Array.from({ length: 15_000 }, (_, i) => ({
			name: `folder_${i % 20}/sub/file_${i}.txt`,
			body: "",
			mtimeSec: 1700000000 + (i % 100),
		}));
		const tgzPath = join(dir, "huge.tar.gz");
		await writeFile(tgzPath, gzipSync(makeTar(entries), { level: 1 }));

		const preview = await listArchive(tgzPath);
		expect(preview.kind).toBe("entries");
		if (preview.kind === "entries") {
			const summary = summarizeArchive(preview.entries, 6);
			expect(summary.itemCount).toBe(20);
		}

		// Also verify ZIP top-level listing
		const zipPath = join(dir, "sample.zip");
		await writeFile(
			zipPath,
			zipSync({
				"docs/a.txt": strToU8("a"),
				"docs/b.txt": strToU8("b"),
				"readme.md": strToU8("hi"),
			}),
		);
		const zipPreview = await listArchive(zipPath);
		expect(zipPreview.kind).toBe("entries");
		if (zipPreview.kind === "entries") {
			expect(zipPreview.entries.map((e) => e.name).sort()).toEqual(["docs/", "readme.md"]);
		}
	});

	it("degrades safely to JS SheetJS fallback when previewSheetNative throws at runtime", async () => {
		const dir = await makeTempDir("preview-rust-fallback-");
		const bytes = makeXlsx({ Fallback: [["k", "v"], ["ok", "1"]] });
		const filePath = join(dir, "fb.xlsx");
		await writeFile(filePath, bytes);

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const real = nativeLoader.loadDazziNativeCore()!;
		vi.spyOn(nativeLoader, "loadDazziNativeCore").mockReturnValue({
			...real,
			previewSheetNative: () => Promise.reject(new Error("simulated native sheet error")),
		});

		const res = await previewSheetFile(filePath, 0);
		expect(res.names).toEqual(["Fallback"]);
		expect(res.rows).toEqual([
			["k", "v"],
			["ok", "1"],
		]);
		expect(warn).toHaveBeenCalledTimes(1);
	});
});
