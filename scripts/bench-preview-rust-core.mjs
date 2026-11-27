#!/usr/bin/env node
/**
 * Before (JS) vs After (Bundled Rust N-API Core) benchmark for Tier 1 Preview acceleration.
 *
 * Works identically on macOS host, 2-vCPU/4GB Tart VM, and Windows SSH PC:
 *   node scripts/bench-preview-rust-core.mjs \
 *     --addon <path-to-dazzi-core.node> \
 *     --app-dir <AutoRAG-app-root> \
 *     [--pdf <path-to-real-multipage.pdf>] \
 *     [--runs 5]
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, cpus, platform, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const argVal = (flag, fallback) => {
	const idx = args.indexOf(flag);
	return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};
const RUNS = Math.max(3, Number.parseInt(argVal("--runs", "5"), 10) || 5);
const appDir = resolve(argVal("--app-dir", join(import.meta.dirname, "..")));
const addonPath = resolve(argVal("--addon", join(appDir, "src", "main", "vendor", "dazzi-core.node")));
const realPdfPath = argVal("--pdf", "");

if (!existsSync(addonPath)) {
	console.error(`Missing native addon: ${addonPath}`);
	process.exit(1);
}

const req = createRequire(join(appDir, "package.json"));
const native = req(addonPath);
const fflate = req("fflate");
const XLSX = req("xlsx");
const UTIF = req("utif");
const { PDFDocument, StandardFonts } = req("pdf-lib");
const pdfjsLib = await import(pathToFileURL(join(appDir, "node_modules/pdfjs-dist/legacy/build/pdf.mjs")).href);

const work = mkdtempSync(join(tmpdir(), "dazzi-preview-bench-"));

function makeTar(entries) {
	const blocks = [];
	const enc = new TextEncoder();
	for (const item of entries) {
		const hdr = new Uint8Array(512);
		hdr.set(enc.encode(item.name).subarray(0, 100), 0);
		hdr.set(enc.encode("0000644\0"), 100);
		hdr.set(enc.encode("0000000\0"), 108);
		hdr.set(enc.encode("0000000\0"), 116);
		hdr.set(enc.encode("00000000000\0"), 124);
		hdr.set(enc.encode(`${item.mtimeSec.toString(8).padStart(11, "0")}\0`), 136);
		hdr.set(enc.encode("        "), 148);
		hdr[156] = 0x30;
		hdr.set(enc.encode("ustar\0"), 257);
		hdr.set(enc.encode("00"), 263);
		let sum = 0;
		for (let i = 0; i < 512; i += 1) sum += hdr[i];
		hdr.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
		blocks.push(hdr);
	}
	blocks.push(new Uint8Array(1024));
	return Buffer.concat(blocks);
}

// ── Build fixtures ──
// 1. XLSX (3 sheets x 50k rows + 80k SST, ~6.1 MB)
const col = (i) => String.fromCharCode(65 + i);
const sst = Array.from({ length: 80000 }, (_, i) => `<si><t>프로젝트_항목_${i}_매출내역_2026Q3</t></si>`);
const sheets = [
	{ name: "Sales", rows: 50000, cols: 8 },
	{ name: "Costs", rows: 50000, cols: 8 },
	{ name: "Summary", rows: 50000, cols: 8 },
];
const xlsxParts = {
	"[Content_Types].xml": fflate.strToU8(
		`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
	),
	"_rels/.rels": fflate.strToU8(
		`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
	),
	"xl/workbook.xml": fflate.strToU8(
		`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
	),
	"xl/_rels/workbook.xml.rels": fflate.strToU8(
		`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`,
	),
	"xl/sharedStrings.xml": fflate.strToU8(
		`<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="80000" uniqueCount="80000">${sst.join("")}</sst>`,
	),
};
sheets.forEach((s, idx) => {
	const body = [];
	for (let r = 0; r < s.rows; r += 1) {
		let row = `<row r="${r + 1}">`;
		for (let c = 0; c < s.cols; c += 1) {
			row += c % 2 === 0 ? `<c r="${col(c)}${r + 1}" t="s"><v>${(r * s.cols + c) % 80000}</v></c>` : `<c r="${col(c)}${r + 1}"><v>${r * 100 + c}</v></c>`;
		}
		body.push(`${row}</row>`);
	}
	xlsxParts[`xl/worksheets/sheet${idx + 1}.xml`] = fflate.strToU8(
		`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body.join("")}</sheetData></worksheet>`,
	);
});
const xlsxBytes = fflate.zipSync(xlsxParts, { level: 1 });
const xlsxPath = join(work, "big-realistic.xlsx");
writeFileSync(xlsxPath, xlsxBytes);

// 2. CSV (400k rows, 31 MB UTF-8 Korean)
const csvLines = ["id,부서명,매출액,비고"];
for (let i = 0; i < 400000; i += 1) csvLines.push(`${i},개발본부_${i % 50},${(i * 1500.5).toFixed(1)},2026년 3분기 실적 보고서 항목 ${i}`);
const csvBytes = new TextEncoder().encode(csvLines.join("\n"));
const csvPath = join(work, "big-korean.csv");
writeFileSync(csvPath, csvBytes);

// 3. 4000x3000 RGBA + TIFF (45.8 MB)
const sw = 4000;
const sh = 3000;
const rgba4k = new Uint8Array(sw * sh * 4);
for (let y = 0; y < sh; y += 1) {
	for (let x = 0; x < sw; x += 1) {
		const o = (y * sw + x) * 4;
		rgba4k[o] = (x * 255) / sw;
		rgba4k[o + 1] = (y * 255) / sh;
		rgba4k[o + 2] = (x ^ y) & 255;
		rgba4k[o + 3] = 255;
	}
}
const tiffBytes = new Uint8Array(UTIF.encodeImage(rgba4k, sw, sh));
const tiffPath = join(work, "big-4k.tif");
writeFileSync(tiffPath, tiffBytes);

// 4. 15,000-entry tar.gz
const tarEntries = Array.from({ length: 15000 }, (_, i) => ({
	name: `proj_${i % 50}/sub_${i % 10}/file_${i}.txt`,
	mtimeSec: 1700000000 + (i % 100),
}));
const tgzBytes = fflate.gzipSync(makeTar(tarEntries), { level: 1 });
const tgzPath = join(work, "big-15k.tar.gz");
writeFileSync(tgzPath, tgzBytes);

// 5. Multi-page PDF (real Citigroup 963p if supplied, else generated 500p PDF)
let pdfPath = realPdfPath;
let pdfLabel = "";
let pdfAnchor = "Consolidated Statements of Income";
if (!pdfPath || !existsSync(pdfPath)) {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	for (let p = 1; p <= 500; p += 1) {
		const page = doc.addPage([612, 792]);
		for (let l = 0; l < 25; l += 1) {
			page.drawText(`Page ${p} Row ${l + 1}: Quarterly compliance and financial statement review 2026.`, { x: 40, y: 740 - l * 26, size: 9, font });
		}
		if (p === 387) {
			page.drawText("Consolidated Statements of Income — Net Revenues $81,139 million", { x: 40, y: 60, size: 10, font });
		}
	}
	pdfPath = join(work, "annual-500p.pdf");
	writeFileSync(pdfPath, await doc.save());
	pdfLabel = "PDF 500p AI anchor locate";
} else {
	pdfLabel = `PDF ${pdfPath.split(/[/\\]/).pop()} AI anchor locate`;
}

// ── JS reference helpers ──
function jsPsdDownscaleAndPng(rgba, width, height, maxSide) {
	const longest = Math.max(width, height);
	const dw = Math.floor((width * maxSide) / longest);
	const dh = Math.floor((height * maxSide) / longest);
	const out = new Uint8Array(dw * dh * 4);
	for (let y = 0; y < dh; y += 1) {
		const top = Math.floor((y * height) / dh);
		const bot = Math.max(top + 1, Math.floor(((y + 1) * height) / dh));
		for (let x = 0; x < dw; x += 1) {
			const left = Math.floor((x * width) / dw);
			const right = Math.max(left + 1, Math.floor(((x + 1) * width) / dw));
			let r = 0, g = 0, b = 0, a = 0;
			for (let sy = top; sy < bot; sy += 1) {
				for (let sx = left; sx < right; sx += 1) {
					const s = (sy * width + sx) * 4;
					r += rgba[s]; g += rgba[s + 1]; b += rgba[s + 2]; a += rgba[s + 3];
				}
			}
			const cnt = (bot - top) * (right - left);
			const t = (y * dw + x) * 4;
			out[t] = Math.round(r / cnt); out[t + 1] = Math.round(g / cnt); out[t + 2] = Math.round(b / cnt); out[t + 3] = Math.round(a / cnt);
		}
	}
	const stride = dw * 4;
	const scanlines = new Uint8Array((stride + 1) * dh);
	for (let row = 0; row < dh; row += 1) scanlines.set(out.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
	return fflate.zlibSync(scanlines, { level: 6 });
}

const median = (arr) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];
async function benchRotated(name, jsFn, rustFn, parityFn, runs = RUNS) {
	const a = await jsFn();
	const b = await rustFn();
	const ok = parityFn(a, b);
	if (!ok) throw new Error(`Parity failed for ${name}`);
	const jt = [], rt = [];
	for (let r = 0; r < runs; r += 1) {
		if (r % 2 === 0) {
			const t0 = performance.now(); await jsFn(); jt.push(performance.now() - t0);
			const t1 = performance.now(); await rustFn(); rt.push(performance.now() - t1);
		} else {
			const t1 = performance.now(); await rustFn(); rt.push(performance.now() - t1);
			const t0 = performance.now(); await jsFn(); jt.push(performance.now() - t0);
		}
	}
	const jm = median(jt);
	const rm = median(rt);
	return { name, jsMs: Number(jm.toFixed(1)), rustMs: Number(rm.toFixed(1)), speedup: Number((jm / rm).toFixed(1)), ok };
}

try {
	console.log(`\n=== Tier 1 Preview Rust Core Benchmark (${platform()}/${arch()}, ${cpus().length} vCPU, ${(totalmem() / 1024 ** 3).toFixed(1)} GB, Node ${process.version}) ===`);
	console.log(`CPU: ${cpus()[0]?.model}`);
	console.log(`Workload                                         | Before (JS) | After (Rust) | Speedup | Parity`);
	console.log(`-------------------------------------------------|-------------|--------------|---------|-------`);

	const rows = [];

	rows.push(
		await benchRotated(
			"XLSX 3x50k + 80k SST (6.1MB)",
			() => {
				const raw = readFileSync(xlsxPath);
				const names = XLSX.read(raw, { type: "buffer", bookSheets: true }).SheetNames;
				const book = XLSX.read(raw, { type: "buffer", sheetRows: 1000, sheets: 0 });
				const table = XLSX.utils.sheet_to_json(book.Sheets[names[0]], { header: 1, raw: false, blankrows: false }).slice(0, 100);
				return { names, rows: table.map((r) => r.slice(0, 20).map(String)) };
			},
			() => native.previewSheetNative(xlsxPath, 0, 1000, 100, 20),
			(a, b) => JSON.stringify(a.names) === JSON.stringify(b.names) && JSON.stringify(a.rows) === JSON.stringify(b.rows),
		),
	);

	rows.push(
		await benchRotated(
			"CSV 400k Korean rows (31MB)",
			() => {
				const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(csvPath));
				const book = XLSX.read(text, { type: "string", sheetRows: 1000 });
				const table = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, raw: false, blankrows: false }).slice(0, 100);
				return { rows: table.map((r) => r.slice(0, 20).map(String)) };
			},
			() => native.previewSheetNative(csvPath, 0, 1000, 100, 20),
			(a, b) => JSON.stringify(a.rows) === JSON.stringify(b.rows),
		),
	);

	rows.push(
		await benchRotated(
			"PSD 4000x3000 downscale + PNG encode",
			() => jsPsdDownscaleAndPng(rgba4k, sw, sh, 2048).byteLength,
			() => native.downscaleAndEncodePngNative(rgba4k, sw, sh, 2048).byteLength,
			(a, b) => a > 1000 && b > 1000,
		),
	);

	rows.push(
		await benchRotated(
			"TIFF 4000x3000 (45.8MB) decode+scale+PNG",
			() => {
				const b = readFileSync(tiffPath);
				const pages = UTIF.decode(b);
				UTIF.decodeImage(b, pages[0]);
				const rgba = UTIF.toRGBA8(pages[0]);
				return jsPsdDownscaleAndPng(rgba, pages[0].width, pages[0].height, 2048).byteLength;
			},
			async () => (await native.decodeTiffPreviewNative(tiffPath, 2048)).byteLength,
			(a, b) => a > 1000 && b > 1000,
			3,
		),
	);

	rows.push(
		await benchRotated(
			"Archive 15k-entry tar.gz top-level list",
			() => {
				const inflated = fflate.gunzipSync(readFileSync(tgzPath));
				const tops = new Set();
				let off = 0;
				while (off + 512 <= inflated.length) {
					let end = off;
					while (end < off + 100 && inflated[end] !== 0) end += 1;
					if (end === off) break;
					const name = new TextDecoder("utf-8").decode(inflated.subarray(off, end));
					tops.add(name.split("/")[0]);
					off += 512;
				}
				return tops.size;
			},
			async () => (await native.listArchiveNative(tgzPath, 512 * 1024 * 1024, 100_000)).entries.length,
			(a, b) => a === b && a === 50,
		),
	);

	// PDF anchor candidate locate vs full pdf.js getTextContent across all pages
	const pdfBytes = new Uint8Array(readFileSync(pdfPath));
	rows.push(
		await benchRotated(
			pdfLabel,
			async () => {
				const task = pdfjsLib.getDocument({ data: new Uint8Array(pdfBytes), disableFontFace: true, useSystemFonts: false });
				const pdf = await task.promise;
				const pages = await Promise.all(
					Array.from({ length: pdf.numPages }, async (_, i) => {
						const pg = await pdf.getPage(i + 1);
						return (await pg.getTextContent()).items.map((it) => ("str" in it ? it.str : "")).join(" ");
					}),
				);
				await task.destroy();
				return pages.findIndex((t) => t.toLowerCase().includes("consolidated statements of income")) + 1;
			},
			async () => {
				const candidates = await native.findPdfAnchorPagesNative(pdfPath, [pdfAnchor], 6);
				const task = pdfjsLib.getDocument({ data: new Uint8Array(pdfBytes), disableFontFace: true, useSystemFonts: false });
				const pdf = await task.promise;
				let found = 0;
				for (const pageNum of candidates) {
					const pg = await pdf.getPage(pageNum);
					const text = (await pg.getTextContent()).items.map((it) => ("str" in it ? it.str : "")).join(" ");
					if (text.toLowerCase().includes("consolidated statements of income")) {
						found = pageNum;
						break;
					}
				}
				await task.destroy();
				return found;
			},
			(a, b) => a > 0 && b > 0,
			3,
		),
	);

	for (const r of rows) {
		console.log(
			`${r.name.padEnd(48)} | ${`${r.jsMs} ms`.padStart(11)} | ${`${r.rustMs} ms`.padStart(12)} | ${`${r.speedup}×`.padStart(7)} | ${r.ok ? "PASS" : "FAIL"}`,
		);
	}
	const totJs = rows.reduce((s, r) => s + r.jsMs, 0);
	const totRs = rows.reduce((s, r) => s + r.rustMs, 0);
	console.log(`-------------------------------------------------|-------------|--------------|---------|-------`);
	console.log(
		`${"Combined total".padEnd(48)} | ${`${totJs.toFixed(1)} ms`.padStart(11)} | ${`${totRs.toFixed(1)} ms`.padStart(12)} | ${`${(totJs / totRs).toFixed(1)}×`.padStart(7)} | PASS\n`,
	);
} finally {
	rmSync(work, { recursive: true, force: true });
}
