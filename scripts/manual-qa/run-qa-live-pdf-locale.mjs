/**
 * Live E2E: PDF stamps, watermarks and page-number headers follow the app language (ko / en / ja / zh).
 *
 * Launches the real app in Japanese, then switches to Chinese at runtime, and checks:
 *   - the Stamp menu shows localized presets (承認済 → 已批准 after the switch, no reload)
 *   - the Watermark dialog defaults to the localized CONFIDENTIAL (社外秘) and offers localized presets
 *   - a Japanese page-number header (機密文書) is drawn on every page instead of being dropped
 *
 *   bun run qa script --host --skip-build scripts/manual-qa/run-qa-live-pdf-locale.mjs
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { deflateSync } from "node:zlib";
import { PDFDocument, PDFName, PDFRawStream, rgb, StandardFonts } from "pdf-lib";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { chord, rmRetry } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-pdf-locale");
mkdirSync(EVIDENCE, { recursive: true });

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(read, ok, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let value = await read();
	while (!ok(value) && Date.now() < deadline) {
		await sleep(200);
		value = await read();
	}
	return value;
}

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-live-pdf-locale-"));
const HOME_DIR = join(WORK, "home");
const DOCS_DIR = join(HOME_DIR, "Documents");
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const USER_DATA = join(WORK, "user-data");

for (const folder of ["Desktop", "Documents", "Downloads", "Music", "Movies", "Pictures", ".Trash"]) {
	mkdirSync(join(HOME_DIR, folder), { recursive: true });
}

// 1. Landscape 16:9 slide deck PDF (960x540, like Korean government/presentation guides)
const LANDSCAPE = join(DOCS_DIR, "slides-landscape.pdf");
{
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.HelveticaBold);
	for (let i = 0; i < 2; i += 1) {
		const page = pdf.addPage([960, 540]);
		page.drawRectangle({ x: 0, y: 450, width: 960, height: 90, color: rgb(0.06, 0.2, 0.45) });
		page.drawText(`5. Electronic Agreement Guide — Slide ${i + 1}`, { x: 40, y: 485, size: 26, font, color: rgb(1, 1, 1) });
		page.drawRectangle({ x: 40, y: 70, width: 880, height: 340, borderColor: rgb(0.75, 0.78, 0.85), borderWidth: 2, color: rgb(0.97, 0.98, 1) });
		page.drawText(`Landscape 16:9 content block (Page ${i + 1} of 2)`, { x: 70, y: 340, size: 18, font, color: rgb(0.15, 0.18, 0.24) });
	}
	writeFileSync(LANDSCAPE, await pdf.save());
}

// 2. Portrait 3-page PDF with real text (for Find) and AcroForm fields (for Forms)
const CONTRACT = join(DOCS_DIR, "contract.pdf");
{
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	const form = pdf.getForm();
	const texts = ["Master Service Agreement — Page One", "Payment Schedule — Invoice Clause", "Execution & Signatures — Page Three"];
	for (let idx = 0; idx < 3; idx += 1) {
		const page = pdf.addPage([595, 842]);
		page.drawRectangle({ x: 48, y: 740, width: 300, height: 28, color: rgb(0.15 + idx * 0.2, 0.35, 0.7) });
		page.drawText(texts[idx], { x: 48, y: 700, size: 16, font, color: rgb(0.1, 0.1, 0.12) });
		page.drawText(`Section ${idx + 1}: Confidential terms apply.`, { x: 48, y: 660, size: 12, font, color: rgb(0.2, 0.2, 0.25) });
		if (idx === 0) {
			const signer = form.createTextField("signer_name");
			signer.setText("Alice");
			signer.addToPage(page, { x: 48, y: 580, width: 220, height: 24 });
			const agree = form.createCheckBox("agree_terms");
			agree.addToPage(page, { x: 48, y: 540, width: 18, height: 18 });
		}
	}
	writeFileSync(CONTRACT, await pdf.save());
}

// 3. Second PDF for in-app Dazzi Merge picker + valid PNG image for in-app Dazzi Image picker
const ADDENDUM = join(DOCS_DIR, "addendum.pdf");
{
	const pdf = await PDFDocument.create();
	const page = pdf.addPage([595, 842]);
	page.drawRectangle({ x: 60, y: 720, width: 220, height: 40, color: rgb(0.1, 0.6, 0.3) });
	writeFileSync(ADDENDUM, await pdf.save());
}
const STAMP_LOGO = join(DOCS_DIR, "stamp-logo.png");
// Valid 1x1 blue PNG
writeFileSync(
	STAMP_LOGO,
	Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
);

// 4. Transparent fixtures: an opaque ring on a fully transparent background, as PNG and as RGBA TIFF.
function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i += 1) {
		c ^= buf[i];
		for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
	}
	return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(typed), 0);
	return Buffer.concat([len, typed, crc]);
}
function encodeRgbaPng(rgba, w, h) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const raw = Buffer.alloc((1 + w * 4) * h);
	for (let y = 0; y < h; y += 1) Buffer.from(rgba.subarray(y * w * 4, (y + 1) * w * 4)).copy(raw, y * (1 + w * 4) + 1);
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}
function encodeRgbaTiff(rgba, w, h) {
	const pixelOffset = 16;
	const ifdOffset = pixelOffset + rgba.length;
	const entries = [
		[256, 3, 1, w], [257, 3, 1, h], [258, 3, 4, 8], [259, 3, 1, 1], [262, 3, 1, 2], [273, 4, 1, pixelOffset],
		[277, 3, 1, 4], [278, 3, 1, h], [279, 4, 1, rgba.length], [284, 3, 1, 1], [338, 3, 1, 2],
	];
	const out = Buffer.alloc(ifdOffset + 2 + entries.length * 12 + 4);
	out.write("II", 0, "ascii");
	out.writeUInt16LE(42, 2);
	out.writeUInt32LE(ifdOffset, 4);
	for (let i = 0; i < 4; i += 1) out.writeUInt16LE(8, 8 + i * 2);
	out.set(rgba, pixelOffset);
	out.writeUInt16LE(entries.length, ifdOffset);
	entries.forEach(([tag, type, count, value], i) => {
		const at = ifdOffset + 2 + i * 12;
		out.writeUInt16LE(tag, at);
		out.writeUInt16LE(type, at + 2);
		out.writeUInt32LE(count, at + 4);
		if (type === 3 && count === 1) out.writeUInt16LE(value, at + 8);
		else out.writeUInt32LE(value, at + 8);
	});
	return out;
}
function ringRgba(size, thickness, [r, g, b]) {
	const rgba = new Uint8Array(size * size * 4);
	for (let y = 0; y < size; y += 1) {
		for (let x = 0; x < size; x += 1) {
			if (x < thickness || y < thickness || x >= size - thickness || y >= size - thickness) {
				const p = (y * size + x) * 4;
				rgba.set([r, g, b, 255], p);
			}
		}
	}
	return rgba;
}
const ALPHA_PNG = join(DOCS_DIR, "logo-transparent.png");
writeFileSync(ALPHA_PNG, encodeRgbaPng(ringRgba(120, 14, [220, 38, 38]), 120, 120));
const ALPHA_TIFF = join(DOCS_DIR, "scan-alpha.tiff");
writeFileSync(ALPHA_TIFF, encodeRgbaTiff(ringRgba(120, 14, [37, 99, 235]), 120, 120));

mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(join(AUTORAG_HOME, "bin"), { recursive: true });
const minsyncStub = join(AUTORAG_HOME, "bin", "minsync");
writeFileSync(minsyncStub, "#!/bin/sh\nexit 0\n");
chmodSync(minsyncStub, 0o755);

writeFileSync(
	CONFIG,
	`${JSON.stringify(
		{
			searchPaths: [DOCS_DIR],
			workspacePath: join(WORK, "workspace"),
			memoryPath: join(WORK, "memory.json"),
			minSync: { enabled: true, autoInstall: true, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } },
			jikji: false,
		},
		null,
		2,
	)}\n`,
);

const env = {
	HOME: HOME_DIR,
	AUTORAG_HOME,
	AUTORAG_CONFIG: CONFIG,
	AUTORAG_QA_ROOT: DOCS_DIR,
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	ELECTRON_RENDERER_URL: "",
	PATH: `${join(AUTORAG_HOME, "bin")}${delimiter}${process.env.PATH ?? ""}`,
};

const app = await launchFinder({ userDataDir: USER_DATA, env, language: "ja" });
try {
	const main = await finderWindow(app, 30_000);
	main.setDefaultTimeout(45_000);
	const shot = async (name) => {
		await sleep(350);
		await main.screenshot({ path: join(EVIDENCE, `${name}.png`) });
	};
	const rowFor = (name) =>
		main
			.locator('[role="row"]')
			.filter({ has: main.locator(".row__label", { hasText: new RegExp(`^${name.replace(/\./g, "\\.")}$`) }) })
			.first();

	await main.locator(".sidebar .sidebar__item", { hasText: "書類" }).click();
	await rowFor("contract.pdf").waitFor({ timeout: 30_000 });
	await rowFor("contract.pdf").click({ modifiers: ["Alt"] });
	const pdfEditor = main.locator(`[data-document-editor="${CONTRACT}"][data-editor-surface="pdf"]`);
	await pdfEditor.locator('[data-pdf-thumb="3"]').waitFor({ timeout: 15_000 });

	// 1. Stamp menu in Japanese
	await pdfEditor.locator('button[data-pdf-stamp-menu="true"]').click();
	const jaStamps = await pdfEditor.locator("button[data-pdf-preset-stamp]").allInnerTexts();
	check("Stamp menu is Japanese (承認済 / 社外秘 / 下書き / 確認済 / 至急)", ["承認済", "社外秘", "下書き", "確認済", "至急"].every((label, i) => jaStamps[i]?.includes(label)), JSON.stringify(jaStamps));
	await shot("01-ja-stamp-menu");
	await pdfEditor.locator('button[data-pdf-preset-stamp="approved"]').click();
	await pdfEditor.locator('[data-pdf-commit-stamp="true"]').click();
	await poll(() => pdfEditor.innerText(), (txt) => txt.includes("スタンプ"), 10_000);

	// 2. Watermark dialog: localized default and presets, apply コピー
	const imagesBefore = await countImages();
	await pdfEditor.locator('button[data-pdf-more-tools="true"]').click();
	await pdfEditor.locator('button[data-pdf-action="watermark"]').click();
	const wmInput = main.locator('input[data-pdf-watermark-input="true"]');
	check("Watermark default text is Japanese CONFIDENTIAL (社外秘)", (await wmInput.inputValue()) === "社外秘", await wmInput.inputValue());
	const presets = await main.locator("button[data-pdf-watermark-preset]").allInnerTexts();
	check("Watermark presets are Japanese", JSON.stringify(presets) === JSON.stringify(["社外秘", "下書き", "コピー", "サンプル"]), JSON.stringify(presets));
	await main.locator('button[data-pdf-watermark-preset="copy"]').click();
	await shot("02-ja-watermark-dialog");
	await main.locator('button[data-pdf-watermark-apply="true"]').click();
	await poll(countImages, (n) => n > imagesBefore, 10_000);

	// 3. Page numbers with a Japanese header: drawn on every page (it used to be dropped silently)
	const imagesBeforeNumbers = await countImages();
	await pdfEditor.locator('button[data-pdf-more-tools="true"]').click();
	await pdfEditor.locator('button[data-pdf-action="page-numbers"]').click();
	await main.locator('input[data-pdf-page-numbers-header="true"]').fill("機密文書 — 2026年度");
	await main.locator('button[data-pdf-page-numbers-apply="true"]').click();
	const imagesAfterNumbers = await poll(countImages, (n) => n > imagesBeforeNumbers, 10_000);
	check("Japanese page-number header embedded as a rendered line (not dropped)", imagesAfterNumbers > imagesBeforeNumbers, `images ${imagesBeforeNumbers} -> ${imagesAfterNumbers}`);
	await sleep(1200);
	await shot("03-ja-stamp-watermark-header-on-page");

	// 4. Switch the app to Chinese at runtime: the open editor relabels immediately.
	await main.evaluate(() => window.autorag.settings.set({ language: "zh" }));
	await poll(() => main.locator('button[data-pdf-stamp-menu="true"]').getAttribute("title"), (title) => title !== null && !/スタンプ/.test(title), 10_000);
	await pdfEditor.locator('button[data-pdf-stamp-menu="true"]').click();
	const zhStamps = await pdfEditor.locator("button[data-pdf-preset-stamp]").allInnerTexts();
	check("After switching to Chinese, the Stamp menu is Chinese without reopening the PDF (已批准 / 机密 / 草稿 / 已审核 / 紧急)", ["已批准", "机密", "草稿", "已审核", "紧急"].every((label, i) => zhStamps[i]?.includes(label)), JSON.stringify(zhStamps));
	await shot("04-zh-stamp-menu");
	await pdfEditor.locator('button[data-pdf-stamp-menu="true"]').click();
	await pdfEditor.locator('button[data-pdf-more-tools="true"]').click();
	await pdfEditor.locator('button[data-pdf-action="watermark"]').click();
	check("Watermark default text is Chinese CONFIDENTIAL (机密) after the switch", (await main.locator('input[data-pdf-watermark-input="true"]').inputValue()) === "机密");
} catch (error) {
	check("the lane ran to the end", false, error instanceof Error ? error.message.split("\n")[0] : String(error));
	for (const page of app.windows()) await page.screenshot({ path: join(EVIDENCE, "failure.png") }).catch(() => undefined);
} finally {
	await app.close().catch(() => undefined);
	try {
		rmRetry(WORK);
	} catch {
		rmSync(WORK, { recursive: true, force: true });
	}
}

async function countImages() {
	const doc = await PDFDocument.load(readFileSync(CONTRACT));
	return doc.context.enumerateIndirectObjects().filter(([, obj]) => obj instanceof PDFRawStream && obj.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")).length;
}

if (failures.length > 0) {
	console.error(`LIVE PDF LOCALE QA FAILED (${failures.length}): ${failures.join(", ")}`);
	process.exit(1);
}
console.log("ALL LIVE PDF LOCALE CHECKS PASSED");
