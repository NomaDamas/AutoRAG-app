/**
 * Manual QA — Quick Look & PDF Document Editor on an unembedded CJK CMap PDF.
 *
 * PDFs generated with unembedded CIDFonts referencing predefined CMaps such as
 * Adobe-Korea1 / `UniKS-UTF16-H` drop every glyph when pdf.js is not configured
 * with bundled `cMapUrl` and `standardFontDataUrl` assets.
 *
 * Drives the real built Electron app:
 *   1. Generates a self-contained two-page PDF using unembedded CIDFontType0
 *      (`Adobe-Korea1`, `UniKS-UTF16-H`) — the exact font/CMap structure of
 *      Korean business PDFs that previously rendered blank text.
 *   2. Opens it in Quick Look (Space), verifies dark glyph pixels in the text
 *      band on page 1, verifies zero pdf.js CMap/font console warnings, and
 *      captures `1-quick-look.png`.
 *   3. Clicks the Quick Look edit (pen) button to open the PDF Document Editor
 *      tab, verifies the editor canvas renders the Korean glyphs with zero
 *      CMap/font console warnings, and captures `2-pdf-editor.png`.
 *
 * Run on a built tree (`bun run build` first):
 *   bun run qa quick-look-pdf-cmaps
 */

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFinderPreview, finderWindow, launchFinder } from "./launch-finder.mjs";

const EVIDENCE = process.env.QA_OUT ?? "/tmp/autorag-quicklook-pdf-cmaps";
mkdirSync(EVIDENCE, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "autorag-ql-pdfcmaps-"));

function encodeUtf16BeHex(text) {
	return Array.from(text)
		.map((ch) => ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase())
		.join("");
}

/** Minimal valid PDF 1.4 with an unembedded Adobe-Korea1 CIDFont and UniKS-UTF16-H CMap. */
function buildKoreanCMapPdf(lines) {
	const ops = ["BT", "/F1 28 Tf", "72 740 Td", "42 TL"];
	lines.forEach((line, index) => {
		const hex = encodeUtf16BeHex(line);
		ops.push(index === 0 ? `<${hex}> Tj` : `T* <${hex}> Tj`);
	});
	ops.push("ET");
	const stream = ops.join("\n");
	const objects = [
		"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
		"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
		"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>\nendobj\n",
		"4 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /ArialUnicodeMS-UniKS-UTF16-H /Encoding /UniKS-UTF16-H /DescendantFonts [5 0 R] >>\nendobj\n",
		"5 0 obj\n<< /Type /Font /Subtype /CIDFontType0 /BaseFont /ArialUnicodeMS /CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 0 >> /DW 1000 /FontDescriptor 6 0 R >>\nendobj\n",
		"6 0 obj\n<< /Type /FontDescriptor /FontName /ArialUnicodeMS /Flags 32 /FontBBox [-1011 -330 2260 1078] /ItalicAngle 0 /Ascent 1069 /Descent -271 /CapHeight 1069 /StemV 70 >>\nendobj\n",
		`7 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
	];
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	for (const obj of objects) {
		offsets.push(Buffer.byteLength(pdf, "latin1"));
		pdf += obj;
	}
	const xrefOffset = Buffer.byteLength(pdf, "latin1");
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (let i = 1; i < offsets.length; i += 1) {
		pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
	}
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(pdf, "latin1");
}

const extraPdf = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : null;
const targetName = "korean-cmap.pdf";
if (extraPdf !== null) {
	copyFileSync(extraPdf, join(root, targetName));
} else {
	writeFileSync(
		join(root, targetName),
		buildKoreanCMapPdf([
			"견 적 서",
			"공급자: (주)다찌 테스트",
			"합계금액(원): 1,102,200",
			"품목: 스티치 무지제본 600부",
		]),
	);
}

const results = [];
function check(label, pass, detail = "") {
	results.push({ label, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  (${detail})`}`);
}

async function poll(read, accept, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	let value = await read();
	while (!accept(value) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		value = await read();
	}
	return value;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CMAP_WARNING_PATTERN = /cMapUrl|standardFontDataUrl|translateFont failed|Unable to load (?:CMap|font|wasm)/i;

/** Measure dark ink pixels in the top text band of the first visible non-empty canvas. */
async function measureCanvasInk(page, selector = "canvas") {
	return page
		.evaluate((sel) => {
			const canvases = [...document.querySelectorAll(sel)].filter((el) => el instanceof HTMLCanvasElement && el.width > 120 && el.height > 120);
			const canvas = canvases[0];
			if (!canvas) return null;
			const ctx = canvas.getContext("2d");
			if (!ctx) return null;
			const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
			let darkPixels = 0;
			for (let i = 0; i < data.length; i += 4) {
				if (data[i + 3] > 128 && data[i] < 160 && data[i + 1] < 160 && data[i + 2] < 160) {
					darkPixels += 1;
				}
			}
			return { width, height, darkPixels };
		}, selector)
		.catch(() => null);
}

const app = await launchFinder({
	env: { AUTORAG_QA_ROOT: root, AUTORAG_SKIP_DUPEY_CHECK: "1" },
	language: process.env.QA_LANGUAGE ?? "en",
});

try {
	const main = await finderWindow(app, 30_000);
	const finderPreview = createFinderPreview(app, main);
	const previewWarnings = [];
	const attachPreviewListeners = (page) => {
		page.on("console", (msg) => {
			if (msg.type() === "warning" || msg.type() === "error") previewWarnings.push(msg.text());
		});
		page.on("pageerror", (err) => previewWarnings.push(err.message));
	};
	// Attach listeners as soon as the lazy Quick Look window registers so no early pdf.js warnings are missed.
	app.on("window", (page) => {
		if (page.url().includes("quick-look.html")) attachPreviewListeners(page);
		else page.once("load", () => { if (page.url().includes("quick-look.html")) attachPreviewListeners(page); });
	});

	const mainWarnings = [];
	main.on("console", (msg) => {
		if (msg.type() === "warning" || msg.type() === "error") mainWarnings.push(msg.text());
	});
	main.on("pageerror", (err) => mainWarnings.push(err.message));

	// 1. Open in Quick Look via Space.
	const row = main.getByRole("row", { name: new RegExp(targetName.replace(".", "\\.")) }).first();
	await row.waitFor({ timeout: 30_000 });
	await row.click();
	await main.keyboard.press("Space");
	const preview = await poll(() => finderPreview.page().catch(() => null), (candidate) => candidate !== null, 30_000);
	if (preview === null) throw new Error("Quick Look window did not appear");

	const qlInk = await poll(
		() => measureCanvasInk(preview, "canvas"),
		(metrics) => metrics !== null && metrics.darkPixels > 400,
		20_000,
	);
	await pause(500);
	await preview.screenshot({ path: join(EVIDENCE, "1-quick-look.png") });

	check(
		"Quick Look renders Korean glyphs from an unembedded UniKS-UTF16-H CIDFont",
		qlInk !== null && qlInk.darkPixels > 400,
		qlInk === null ? "no canvas" : `${qlInk.width}x${qlInk.height}, darkPixels=${qlInk.darkPixels}`,
	);
	const qlCmapWarnings = previewWarnings.filter((line) => CMAP_WARNING_PATTERN.test(line));
	check("Quick Look emits no pdf.js CMap or standard-font warnings", qlCmapWarnings.length === 0, qlCmapWarnings.join(" | "));

	// 2. Hand off to the PDF Document Editor via Quick Look's edit button.
	const editButton = preview.getByRole("button", { name: /edit/i }).first();
	await editButton.waitFor({ timeout: 10_000 });
	await editButton.click();

	const editorInk = await poll(
		() => measureCanvasInk(main, "canvas"),
		(metrics) => metrics !== null && metrics.darkPixels > 400,
		20_000,
	);
	await pause(500);
	await main.screenshot({ path: join(EVIDENCE, "2-pdf-editor.png") });

	check(
		"PDF Document Editor renders Korean glyphs from the same unembedded CIDFont",
		editorInk !== null && editorInk.darkPixels > 400,
		editorInk === null ? "no canvas" : `${editorInk.width}x${editorInk.height}, darkPixels=${editorInk.darkPixels}`,
	);
	const editorCmapWarnings = mainWarnings.filter((line) => CMAP_WARNING_PATTERN.test(line));
	check("PDF Document Editor emits no pdf.js CMap or standard-font warnings", editorCmapWarnings.length === 0, editorCmapWarnings.join(" | "));
} finally {
	await app.close();
	rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
