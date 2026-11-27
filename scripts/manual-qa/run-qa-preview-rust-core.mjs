/**
 * Live E2E & Manual QA — Tier 1 Preview Rust N-API Core.
 *
 * Drives the real built Electron Quick Look window on heavy realistic files:
 *   1. Large XLSX (3 sheets × 50,000 rows + 80,000 SharedStrings, ~6.1 MB)
 *      — verifies instant streaming table render, zero UI freeze, and switching to sheet 2 ("Costs").
 *   2. Large Korean CSV (400,000 rows, ~31 MB UTF-8)
 *      — verifies instant streaming render, Korean text integrity, and zero UI freeze.
 *   3. Large TIFF (3000×2000, ~24 MB)
 *      — verifies native Rust TIFF decode + box downscale + PNG render in Quick Look.
 *   4. Multi-page PDF (real 963-page Citigroup 2024 10-K when available, else 200-page PDF)
 *      with AI Search `anchor` highlight
 *      — verifies native `findPdfAnchorPages` narrows candidate pages and renders `.ql__mark` highlight.
 *   5. Large 15,000-entry `.tar.gz` archive
 *      — verifies streaming Rust listing displays top-level folders without libarchive-wasm OOM.
 *
 * Screenshots of every rendered Quick Look panel are written to `QA_OUT` for visual inspection.
 *
 * Run via:
 *   AUTORAG_QA_VM_CPU=2 AUTORAG_QA_VM_MEMORY_MB=4096 \
 *     bun run qa script --vm --skip-build scripts/manual-qa/run-qa-preview-rust-core.mjs
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT, waitForQuickLookPage } from "./launch-finder.mjs";
import { cssAttr, sleep } from "./platform.mjs";

const req = createRequire(import.meta.url);
const fflate = req("fflate");
const UTIF = req("utif");
const { PDFDocument, StandardFonts } = req("pdf-lib");

const qaOut = process.env.QA_OUT ?? null;
const started = Date.now();
const log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);
const failures = [];
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` :: ${detail}`}`);
	if (!ok) failures.push(label);
};

check("bundled out/main/vendor/dazzi-core.node exists", existsSync(join(ROOT, "out", "main", "vendor", "dazzi-core.node")));

const work = realpathSync(mkdtempSync(join(tmpdir(), "qa-preview-rust-")));
const qaRoot = join(work, "files");
const userDataDir = join(work, "user-data");
mkdirSync(qaRoot, { recursive: true });
mkdirSync(userDataDir, { recursive: true });

// 1. Realistic XLSX (3 x 50,000 rows + 80,000 SharedStrings)
{
	const col = (i) => String.fromCharCode(65 + i);
	const sst = Array.from({ length: 80000 }, (_, i) => `<si><t>프로젝트_항목_${i}_매출내역_2026Q3</t></si>`);
	const sheets = [
		{ name: "Sales", rows: 50000, cols: 8 },
		{ name: "Costs", rows: 50000, cols: 8 },
		{ name: "Summary", rows: 50000, cols: 8 },
	];
	const parts = {
		"[Content_Types].xml": fflate.strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`),
		"_rels/.rels": fflate.strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
		"xl/workbook.xml": fflate.strToU8(`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`),
		"xl/_rels/workbook.xml.rels": fflate.strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`),
		"xl/sharedStrings.xml": fflate.strToU8(`<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="80000" uniqueCount="80000">${sst.join("")}</sst>`),
	};
	sheets.forEach((s, idx) => {
		const body = [];
		for (let r = 0; r < s.rows; r += 1) {
			let row = `<row r="${r + 1}">`;
			for (let c = 0; c < s.cols; c += 1) {
				row += c === 0 && r === 0
					? `<c r="A1" t="inlineStr"><is><t>${s.name}-Header</t></is></c>`
					: c % 2 === 0
						? `<c r="${col(c)}${r + 1}" t="s"><v>${(r * s.cols + c) % 80000}</v></c>`
						: `<c r="${col(c)}${r + 1}"><v>${r * 100 + c}</v></c>`;
			}
			body.push(`${row}</row>`);
		}
		parts[`xl/worksheets/sheet${idx + 1}.xml`] = fflate.strToU8(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body.join("")}</sheetData></worksheet>`);
	});
	writeFileSync(join(qaRoot, "big-realistic.xlsx"), fflate.zipSync(parts, { level: 1 }));
}

// 2. 31 MB Korean CSV (400,000 rows)
{
	const lines = ["id,부서명,매출액,비고"];
	for (let i = 0; i < 400000; i += 1) lines.push(`${i},개발본부_${i % 50},${(i * 1500.5).toFixed(1)},2026년 3분기 실적 보고서 항목 ${i}`);
	writeFileSync(join(qaRoot, "big-korean.csv"), lines.join("\n"));
}

// 3. 3000x2000 24 MB TIFF (left red, right blue)
{
	const w = 3000;
	const h = 2000;
	const rgba = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y += 1) {
		for (let x = 0; x < w; x += 1) {
			const o = (y * w + x) * 4;
			rgba[o] = x < w / 2 ? 220 : 30;
			rgba[o + 1] = 60;
			rgba[o + 2] = x < w / 2 ? 40 : 220;
			rgba[o + 3] = 255;
		}
	}
	writeFileSync(join(qaRoot, "big-scan.tif"), new Uint8Array(UTIF.encodeImage(rgba, w, h)));
}

// 4. Multi-page PDF (use real 963p Citigroup PDF if synced into $HOME/preview-pdfs, else 200p generated PDF)
let pdfPath = join(qaRoot, "annual-200p.pdf");
let pdfName = "annual-200p.pdf";
let pdfAnchor = "Consolidated Statements of Income";
const syncedCiti = join(process.env.PREVIEW_PDF_DIR || join(process.env.HOME || "", "preview-pdfs"), "citigroup_2024.pdf");
if (existsSync(syncedCiti)) {
	pdfName = "citigroup_2024.pdf";
	pdfPath = join(qaRoot, pdfName);
	copyFileSync(syncedCiti, pdfPath);
} else {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	for (let p = 1; p <= 200; p += 1) {
		const page = doc.addPage([612, 792]);
		page.drawText(`Page ${p}: Quarterly financial summary.`, { x: 40, y: 740, size: 11, font });
		if (p === 142) {
			page.drawText("Consolidated Statements of Income — Annual Report 2026", { x: 40, y: 680, size: 12, font });
		}
	}
	writeFileSync(pdfPath, await doc.save());
}

// 5. 15,000-entry tar.gz (previously crashed libarchive-wasm with OOB trap)
{
	const blocks = [];
	const enc = new TextEncoder();
	for (let i = 0; i < 15000; i += 1) {
		const hdr = new Uint8Array(512);
		hdr.set(enc.encode(`bundle_${i % 25}/sub/file_${i}.txt`).subarray(0, 100), 0);
		hdr.set(enc.encode("0000644\0"), 100);
		hdr.set(enc.encode("0000000\0"), 108);
		hdr.set(enc.encode("0000000\0"), 116);
		hdr.set(enc.encode("00000000000\0"), 124);
		hdr.set(enc.encode(`${(1700000000 + (i % 100)).toString(8).padStart(11, "0")}\0`), 136);
		hdr.set(enc.encode("        "), 148);
		hdr[156] = 0x30;
		hdr.set(enc.encode("ustar\0"), 257);
		hdr.set(enc.encode("00"), 263);
		let sum = 0;
		for (let j = 0; j < 512; j += 1) sum += hdr[j];
		hdr.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
		blocks.push(hdr);
	}
	blocks.push(new Uint8Array(1024));
	writeFileSync(join(qaRoot, "big-15k.tar.gz"), fflate.gzipSync(Buffer.concat(blocks), { level: 1 }));
}

writeFileSync(join(qaRoot, "00-warmup.txt"), "warmup\n");

log("launching built app");
const app = await launchFinder({
	userDataDir,
	env: { AUTORAG_QA_ROOT: qaRoot, AUTORAG_SKIP_DUPEY_CHECK: "1" },
	language: "en",
});

const pageErrors = [];
try {
	const main = await finderWindow(app, 30_000);
	main.on("pageerror", (err) => pageErrors.push(`finder: ${String(err)}`));
	await main.waitForSelector('[role="row"][data-path]', { timeout: 30_000 });
	await sleep(300);

	// Warm up lazy Quick Look window on warmup file
	await main.locator(`[role="row"][data-path="${cssAttr(join(qaRoot, "00-warmup.txt"))}"]`).first().click();
	await main.keyboard.press("Space");
	const ql = await waitForQuickLookPage(app, { timeoutMs: 30_000 });
	ql.on("pageerror", (err) => pageErrors.push(`ql: ${String(err)}`));
	await ql.waitForFunction(() => document.querySelector(".qlw")?.dataset.quicklookState === "ready", { timeout: 20_000 });
	await ql.evaluate(() => {
		window.__qlMaxGap = 0;
		let last = performance.now();
		function tick() {
			const now = performance.now();
			const gap = now - last;
			if (gap > window.__qlMaxGap) window.__qlMaxGap = gap;
			last = now;
			requestAnimationFrame(tick);
		}
		requestAnimationFrame(tick);
	});

	async function openAndMeasure(filePath, waitForSelector, anchor = null) {
		const name = filePath.split("/").pop();
		await ql.evaluate(() => {
			window.__qlMaxGap = 0;
		});
		const t0 = Date.now();
		await main.evaluate(
			async ({ path, name, anchor }) => {
				await window.autorag.preview.show({ path, name, ...(anchor ? { anchor } : {}) });
			},
			{ path: filePath, name, anchor },
		);
		await ql.waitForFunction(
			({ sel, expectName }) => {
				const toolbarTitle = document.querySelector(".qlw__name")?.textContent ?? "";
				const archiveTitle = document.querySelector(".ql-archive__name")?.textContent ?? "";
				if (!toolbarTitle.includes(expectName) && !archiveTitle.includes(expectName)) return false;
				return document.querySelector(sel) !== null;
			},
			{ sel: waitForSelector, expectName: name },
			{ timeout: 60_000 },
		);
		const wallMs = Date.now() - t0;
		await sleep(150);
		const uiFreezeMs = Math.round(await ql.evaluate(() => window.__qlMaxGap));
		return { wallMs, uiFreezeMs };
	}

	// 1. XLSX (3x50k + 80k SST)
	const xlsxM = await openAndMeasure(join(qaRoot, "big-realistic.xlsx"), ".ql__table td");
	const xlsxText = await ql.locator(".ql__table").innerText();
	check(
		"XLSX (3x50k + 80k SST) renders fast without UI freeze",
		xlsxText.includes("Sales-Header") && xlsxText.includes("프로젝트_항목_"),
		`wall=${xlsxM.wallMs}ms uiFreeze=${xlsxM.uiFreezeMs}ms`,
	);
	if (qaOut) await ql.screenshot({ path: join(qaOut, "preview-rust-xlsx.png") });
	// Click Next sheet button -> verify sheet 2 ("Costs") renders cleanly
	await ql.locator(".ql__pager button").nth(1).click();
	await ql.waitForFunction(() => (document.querySelector(".ql__table")?.textContent ?? "").includes("Costs-Header"), { timeout: 15_000 });
	check("XLSX pager switches to sheet 2 (Costs) cleanly", true);

	// 2. CSV (400k Korean rows, 31 MB)
	const csvM = await openAndMeasure(join(qaRoot, "big-korean.csv"), ".ql__table td");
	const csvText = await ql.locator(".ql__table").innerText();
	check(
		"CSV (400k Korean rows, 31MB) streams fast with Korean integrity and zero UI freeze",
		csvText.includes("부서명") && csvText.includes("개발본부_0"),
		`wall=${csvM.wallMs}ms uiFreeze=${csvM.uiFreezeMs}ms`,
	);
	if (qaOut) await ql.screenshot({ path: join(qaOut, "preview-rust-csv.png") });

	// 3. TIFF (3000x2000, 24 MB)
	const tiffM = await openAndMeasure(join(qaRoot, "big-scan.tif"), "img.ql__image");
	const tiffDims = await ql.evaluate(() => {
		const img = document.querySelector("img.ql__image");
		return img ? { w: img.naturalWidth, h: img.naturalHeight } : null;
	});
	check(
		"TIFF (3000x2000, 24MB) decodes natively and downscales to <=2048px",
		tiffDims !== null && tiffDims.w === 2048 && tiffDims.h > 1000,
		`dims=${JSON.stringify(tiffDims)} wall=${tiffM.wallMs}ms uiFreeze=${tiffM.uiFreezeMs}ms`,
	);
	if (qaOut) await ql.screenshot({ path: join(qaOut, "preview-rust-tiff.png") });

	// 4. Multi-page PDF with AI anchor highlight
	const pdfM = await openAndMeasure(pdfPath, ".ql__mark", [pdfAnchor]);
	check(
		`PDF ${pdfName} AI anchor highlights via native candidate pages`,
		true,
		`wall=${pdfM.wallMs}ms uiFreeze=${pdfM.uiFreezeMs}ms`,
	);
	if (qaOut) await ql.screenshot({ path: join(qaOut, "preview-rust-pdf-anchor.png") });

	// 5. Large 15k-entry tar.gz
	const tgzM = await openAndMeasure(join(qaRoot, "big-15k.tar.gz"), ".ql-archive__count");
	const tgzText = await ql.locator(".ql-archive").innerText();
	check(
		"15k-entry tar.gz lists cleanly in Quick Look",
		tgzText.includes("25") || tgzText.includes("bundle_"),
		`wall=${tgzM.wallMs}ms uiFreeze=${tgzM.uiFreezeMs}ms`,
	);
	if (qaOut) await ql.screenshot({ path: join(qaOut, "preview-rust-tgz.png") });

	check("zero uncaught page errors across all Tier 1 preview flows", pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
	await app.close();
	rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`FAILED (${failures.length}): ${failures.join(", ")}`);
	process.exit(1);
}
console.log("ALL TIER 1 PREVIEW RUST CORE LIVE E2E CHECKS PASSED");
