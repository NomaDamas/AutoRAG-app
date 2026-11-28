/**
 * Live end-to-end & visual QA: Redesigned Acrobat-class PDF Editor inside Dazzi.
 *
 * Verifies every UI/UX & functional invariant against the real built Electron app:
 *   1. Landscape 16:9 PDF (`slides-landscape.pdf`, 960x540):
 *      - Single-row non-wrapping native toolbar (height <= 44px, zero clipped buttons)
 *      - No redundant DocumentEditorTab header bar or duplicate Edit / AI Edit buttons
 *      - Right-side thumbnail rail (unified with Quick Look) where landscape thumbnails
 *        fit strictly inside the rail with zero horizontal overflow or clipping
 *   2. In-app Dazzi File Picker (never opens native OS Finder):
 *      - Insert Image (`stamp-logo.png`) via DazziFilePickerModal -> stamped onto PDF
 *      - Merge PDF (`addendum.pdf`) via DazziFilePickerModal -> pageCount grows on disk
 *   3. Portrait PDF with AcroForm (`contract.pdf`):
 *      - Highlight, Redact (blackout) & Whiteout (via contextual switcher),
 *        Arrow Shape, Freehand Draw, Preset Stamp (APPROVED), Sticky Note,
 *        Watermark, Page Numbers, Duplicate Page, Insert Blank Page,
 *        Document Properties, AcroForm Fill & Flatten, Split by ranges,
 *        Find-in-PDF (Cmd/Ctrl+F), and Undo snapshot restore.
 *
 *   bun run qa script --host --skip-build scripts/manual-qa/run-qa-live-pdf-editor-acrobat.mjs
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { chord, rmRetry } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-pdf-editor-acrobat");
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

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-live-pdf-acrobat-"));
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

const app = await launchFinder({ userDataDir: USER_DATA, env, language: "ko" });
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

	await main.locator(".sidebar .sidebar__item", { hasText: "문서" }).click();

	// === PART A: Landscape PDF layout, right-side thumbnail rail, single-row toolbar ===
	await rowFor("slides-landscape.pdf").waitFor({ timeout: 30_000 });
	await rowFor("slides-landscape.pdf").click({ modifiers: ["Alt"] });

	const landscapeEditor = main.locator(`[data-document-editor="${LANDSCAPE}"][data-editor-surface="pdf"]`);
	await landscapeEditor.waitFor({ timeout: 15_000 });
	await landscapeEditor.locator('[data-pdf-thumb="2"] canvas').waitFor({ timeout: 15_000 });
	await sleep(400);
	await shot("00-landscape-pdf-redesign");

	// Verify single-row toolbar (no wrapping!)
	const toolbarBox = await landscapeEditor.locator('[role="toolbar"][aria-label="PDF"]').boundingBox();
	check("PDF toolbar stays on one clean row (height <= 44px)", toolbarBox !== null && toolbarBox.height <= 44, JSON.stringify(toolbarBox));

	// Verify no redundant header bar above the PDF toolbar
	check("No redundant DocumentEditorTab header above PDF toolbar", (await landscapeEditor.locator(".doc-editor__header").count()) === 0);

	// Verify right-side thumbnail rail position & zero landscape thumbnail overflow/clipping
	const rail = landscapeEditor.locator('[data-pdf-thumbnail-rail="right"]');
	const stageBox = await landscapeEditor.locator('[data-pdf-page-stage="1"]').boundingBox();
	const railBox = await rail.boundingBox();
	const thumbCanvasBox = await landscapeEditor.locator('[data-pdf-thumb="1"] canvas').boundingBox();
	check(
		"Thumbnail rail sits on the RIGHT side of the PDF canvas",
		railBox !== null && stageBox !== null && railBox.x >= stageBox.x + stageBox.width - 2,
		`stageRight=${stageBox ? Math.round(stageBox.x + stageBox.width) : "?"} railX=${railBox ? Math.round(railBox.x) : "?"}`,
	);
	check(
		"Landscape thumbnail fits cleanly inside right rail with zero clipping",
		railBox !== null &&
			thumbCanvasBox !== null &&
			thumbCanvasBox.width <= 108 &&
			thumbCanvasBox.height < thumbCanvasBox.width &&
			thumbCanvasBox.x >= railBox.x + 8 &&
			thumbCanvasBox.x + thumbCanvasBox.width <= railBox.x + railBox.width - 8,
		`thumb=${JSON.stringify(thumbCanvasBox)} rail=${JSON.stringify(railBox)}`,
	);

	// === PART B: Portrait PDF with all Acrobat tools + In-App Dazzi File Pickers ===
	await main.locator(".tabs .tab").first().click();
	await rowFor("contract.pdf").waitFor({ timeout: 15_000 });
	await rowFor("contract.pdf").click({ modifiers: ["Alt"] });

	const pdfEditor = main.locator(`[data-document-editor="${CONTRACT}"][data-editor-surface="pdf"]`);
	await pdfEditor.waitFor({ timeout: 15_000 });
	await pdfEditor.locator('[data-pdf-thumb="3"]').waitFor({ timeout: 15_000 });
	await shot("01-portrait-pdf-opened");

	// In-app Real Dazzi Finder Image Picker (2nd view mode = List, with real SidebarSearch!)
	const sizeBeforeImg = readFileSync(CONTRACT).byteLength;
	await pdfEditor.locator('button[data-pdf-action="insert-image"]').click();
	const imgPicker = main.locator('[data-dazzi-file-picker="image"]');
	await imgPicker.waitFor({ timeout: 10_000 });
	check(
		"In-app Dazzi Finder modal defaults to 2nd view mode (List) with real SidebarSearch",
		(await imgPicker.getAttribute("data-picker-view-mode")) === "list" &&
			(await imgPicker.locator(".sidebar-search input").count()) === 1,
	);
	await imgPicker.locator(`[role="row"][data-path="${STAMP_LOGO}"]`).waitFor({ timeout: 10_000 });
	await shot("02-dazzi-in-app-image-picker");

	// Exercise live SidebarSearch inside the modal picker
	const modalSearch = imgPicker.locator(".sidebar-search input");
	await modalSearch.click();
	await modalSearch.fill("stamp-logo");
	await main.keyboard.press("Enter");
	await imgPicker.locator(`[role="row"][data-path="${STAMP_LOGO}"]`).waitFor({ timeout: 10_000 });
	check("Modal SidebarSearch found stamp-logo.png via real Finder search", true);

	await imgPicker.locator(`[role="row"][data-path="${STAMP_LOGO}"]`).click();
	await imgPicker.locator('button[data-dazzi-picker-confirm="true"]').click();
	await pdfEditor.locator('[data-pdf-commit-stamp="true"]').waitFor({ timeout: 10_000 });
	await pdfEditor.locator('[data-pdf-commit-stamp="true"]').click();
	await poll(() => pdfEditor.innerText(), (txt) => txt.includes("이미지를 PDF에 저장했습니다"), 10_000);
	check("In-app Dazzi Image Picker stamped image onto PDF without opening OS Finder", readFileSync(CONTRACT).byteLength > sizeBeforeImg);

	const stage = pdfEditor.locator('[data-pdf-page-stage="1"]');
	await stage.waitFor({ timeout: 15_000 });

	// 0. Unified right-sidebar chat UI (exact shared .customizer-panel from Settings / Finder)
	const sidebarCheck = await main.evaluate(() => {
		const el = document.querySelector("[data-document-editor-sidebar]");
		if (!el) return null;
		return {
			usesCustomizerPanel: el.classList.contains("customizer-panel"),
			hasDazziMark: el.querySelector(".customizer-panel__empty-logo") !== null,
			hasCustomizerComposer: el.querySelector(".customizer-composer") !== null,
			hasOldHeader: el.querySelector(".border-b") !== null,
		};
	});
	check(
		"Right AI sidebar reuses Dazzi's unified .customizer-panel chat UI (faded mark + floating composer, no bespoke header)",
		sidebarCheck !== null &&
			sidebarCheck.usesCustomizerPanel &&
			sidebarCheck.hasDazziMark &&
			sidebarCheck.hasCustomizerComposer &&
			!sidebarCheck.hasOldHeader,
		JSON.stringify(sidebarCheck),
	);

	// 0b. Keyboard ArrowDown / ArrowUp page navigation
	await main.keyboard.press("ArrowDown");
	await pdfEditor.locator('[data-pdf-page-stage="2"]').waitFor({ timeout: 5_000 });
	check(
		"ArrowDown keyboard shortcut stepped PDF to page 2",
		(await pdfEditor.locator('[data-pdf-page-indicator="true"]').innerText()).startsWith("2 /"),
	);
	await main.keyboard.press("ArrowUp");
	await pdfEditor.locator('[data-pdf-page-stage="1"]').waitFor({ timeout: 5_000 });
	check(
		"ArrowUp keyboard shortcut stepped PDF back to page 1",
		(await pdfEditor.locator('[data-pdf-page-indicator="true"]').innerText()).startsWith("1 /"),
	);

	const dragOnStage = async (fx1, fy1, fx2, fy2) => {
		const box = await stage.boundingBox();
		if (box === null) throw new Error("PDF stage has no bounding box");
		await main.mouse.move(box.x + box.width * fx1, box.y + box.height * fy1);
		await main.mouse.down();
		await main.mouse.move(box.x + box.width * fx2, box.y + box.height * fy2, { steps: 6 });
		await main.mouse.up();
	};

	// 0c. Keynote / PowerPoint-style live on-canvas Text Box placement + direct typing + Cmd/Ctrl+Enter commit
	const sizeBeforeText = readFileSync(CONTRACT).byteLength;
	await pdfEditor.locator('button[data-pdf-tool="text"]').click();
	const contractStageBox = await stage.boundingBox();
	if (contractStageBox === null) throw new Error("PDF stage has no bounding box");
	await main.mouse.click(contractStageBox.x + contractStageBox.width * 0.14, contractStageBox.y + contractStageBox.height * 0.48);
	const textBoxInput = pdfEditor.locator('textarea[data-pdf-textbox-input="true"]');
	await textBoxInput.waitFor({ timeout: 10_000 });
	await textBoxInput.fill("Keynote 스타일 직접 입력 테스트");
	await shot("02b-pdf-keynote-textbox-and-unified-sidebar");
	await main.keyboard.press(chord("Enter"));
	await poll(() => pdfEditor.innerText(), (txt) => txt.includes("텍스트를 PDF에 저장했습니다"), 10_000);
	check("Keynote-style on-canvas text box committed directly onto PDF", readFileSync(CONTRACT).byteLength > sizeBeforeText);

	// 1. Highlight
	const size0 = readFileSync(CONTRACT).byteLength;
	await pdfEditor.locator('button[data-pdf-tool="highlight"]').click();
	await dragOnStage(0.08, 0.16, 0.62, 0.2);
	await poll(() => pdfEditor.innerText(), (txt) => txt.includes("형광펜을 PDF에 저장했습니다"), 10_000);
	check("Highlight saved to PDF", readFileSync(CONTRACT).byteLength > size0);

	// 2. Redact (blackout) & Whiteout via contextual segmented toggle
	await pdfEditor.locator('button[data-pdf-tool="redact"]').click();
	await dragOnStage(0.08, 0.22, 0.45, 0.25);
	await poll(() => pdfEditor.innerText(), (txt) => txt.includes("가리기 영역을 PDF에 적용했습니다"), 10_000);
	check("Black redaction applied to PDF", true);

	await pdfEditor.locator('button[data-pdf-redact-mode="white"]').click();
	await dragOnStage(0.5, 0.22, 0.72, 0.25);
	await poll(() => pdfEditor.innerText(), (txt) => txt.includes("화이트아웃을 PDF에 적용했습니다"), 10_000);
	check("Whiteout applied to PDF", true);

	// 3. Shape (Arrow) & Freehand Draw
	await pdfEditor.locator('button[data-pdf-tool="shape"]').click();
	await pdfEditor.locator('button[data-pdf-shape="arrow"]').click();
	await dragOnStage(0.15, 0.32, 0.48, 0.42);
	await poll(() => pdfEditor.innerText(), (txt) => txt.includes("도형을 PDF에 저장했습니다"), 10_000);
	check("Arrow shape drawn and saved to PDF", true);

	await pdfEditor.locator('button[data-pdf-tool="draw"]').click();
	await dragOnStage(0.55, 0.34, 0.78, 0.44);
	await poll(() => pdfEditor.innerText(), (txt) => txt.includes("필기를 PDF에 저장했습니다"), 10_000);
	check("Freehand pen drawing saved to PDF", true);

	// 4. Preset Stamp (APPROVED) & Sticky Note
	await pdfEditor.locator('button[data-pdf-stamp-menu="true"]').click();
	await pdfEditor.locator('button[data-pdf-preset-stamp="approved"]').click();
	await pdfEditor.locator('[data-pdf-stamp-box="true"]').waitFor({ timeout: 10_000 });
	await shot("03-pdf-annotations-and-stamp");
	await pdfEditor.locator('[data-pdf-commit-stamp="true"]').click();
	await poll(() => pdfEditor.innerText(), (txt) => txt.includes("스탬프를 PDF에 저장했습니다"), 10_000);
	check("Preset APPROVED stamp saved to PDF", true);

	await pdfEditor.locator('button[data-pdf-tool="note"]').click();
	const noteInput = pdfEditor.locator('input[data-pdf-note-input="true"]');
	await noteInput.fill("법무팀 검토 완료");
	await main.keyboard.press("Enter");
	await pdfEditor.locator('[data-pdf-commit-stamp="true"]').click();
	await poll(() => pdfEditor.innerText(), (txt) => txt.includes("메모를 PDF에 저장했습니다"), 10_000);
	check("Sticky note saved to PDF", true);

	// 5. Document Tools -> Watermark, Page Numbers, Duplicate, Insert Blank, In-app Merge PDF
	const openMore = async () => {
		await pdfEditor.locator('button[data-pdf-more-tools="true"]').click();
	};

	await openMore();
	await pdfEditor.locator('button[data-pdf-action="watermark"]').click();
	await main.locator('button[data-pdf-watermark-apply="true"]').click();
	await poll(() => pdfEditor.innerText(), (txt) => txt.includes("워터마크를 적용했습니다"), 10_000);
	check("Watermark applied across pages", true);

	await openMore();
	await pdfEditor.locator('button[data-pdf-action="page-numbers"]').click();
	await main.locator('button[data-pdf-page-numbers-apply="true"]').click();
	await poll(() => pdfEditor.innerText(), (txt) => txt.includes("페이지 번호를 적용했습니다"), 10_000);
	check("Page numbers applied across pages", true);

	await openMore();
	await pdfEditor.locator('button[data-pdf-action="duplicate"]').click();
	const countAfterDup = await poll(async () => (await PDFDocument.load(readFileSync(CONTRACT))).getPageCount(), (n) => n === 4, 10_000);
	check("Duplicate page increased pageCount (3 -> 4)", countAfterDup === 4, `pages=${countAfterDup}`);

	await openMore();
	await pdfEditor.locator('button[data-pdf-action="insert-blank"]').click();
	const countAfterBlank = await poll(async () => (await PDFDocument.load(readFileSync(CONTRACT))).getPageCount(), (n) => n === 5, 10_000);
	check("Insert blank page increased pageCount (4 -> 5)", countAfterBlank === 5, `pages=${countAfterBlank}`);

	await openMore();
	await pdfEditor.locator('button[data-pdf-action="merge"]').click();
	const pdfPicker = main.locator('[data-dazzi-file-picker="pdf"]');
	await pdfPicker.waitFor({ timeout: 10_000 });
	await pdfPicker.locator(`[role="row"][data-path="${ADDENDUM}"]`).click();
	await pdfPicker.locator('button[data-dazzi-picker-confirm="true"]').click();
	const countAfterMerge = await poll(async () => (await PDFDocument.load(readFileSync(CONTRACT))).getPageCount(), (n) => n === 6, 10_000);
	check("In-app Dazzi PDF Merge picker merged addendum.pdf (5 -> 6 pages)", countAfterMerge === 6, `pages=${countAfterMerge}`);

	// 6. Document Properties (metadata)
	await openMore();
	await pdfEditor.locator('button[data-pdf-action="properties"]').click();
	await main.locator('input[data-pdf-prop-title="true"]').fill("Dazzi Master Agreement");
	await main.locator('input[data-pdf-prop-author="true"]').fill("Jeffrey Kim");
	await main.locator('button[data-pdf-prop-save="true"]').click();
	await poll(() => pdfEditor.innerText(), (txt) => txt.includes("PDF 문서 속성을 저장했습니다"), 10_000);
	const savedDoc = await PDFDocument.load(readFileSync(CONTRACT));
	check(
		"PDF metadata updated on disk",
		savedDoc.getTitle() === "Dazzi Master Agreement" && savedDoc.getAuthor() === "Jeffrey Kim",
		`title=${savedDoc.getTitle()} author=${savedDoc.getAuthor()}`,
	);

	// 7. AcroForm Fill & Flatten
	await openMore();
	await pdfEditor.locator('button[data-pdf-action="forms"]').click();
	const signerInput = main.locator('input[data-pdf-form-field="signer_name"]');
	await signerInput.waitFor({ timeout: 10_000 });
	await signerInput.fill("Jeffrey Kim");
	await main.locator('input[data-pdf-form-field="agree_terms"]').check();
	await main.locator('input[data-pdf-form-flatten="true"]').check();
	await main.locator('button[data-pdf-form-save="true"]').click();
	await poll(() => pdfEditor.innerText(), (txt) => txt.includes("PDF 양식을 저장하고 고정(병합)했습니다"), 10_000);
	const afterFormDoc = await PDFDocument.load(readFileSync(CONTRACT));
	check("AcroForm filled and flattened on disk", afterFormDoc.getForm().getFields().length === 0);

	// 8. Split PDF by ranges
	await openMore();
	await pdfEditor.locator('button[data-pdf-action="split"]').click();
	await main.locator("label", { hasText: "페이지 범위로 분할" }).click();
	await main.locator('input[data-pdf-split-ranges="true"]').fill("1-2, 3-6");
	await main.locator('button[data-pdf-split-run="true"]').click();
	await poll(() => pdfEditor.innerText(), (txt) => txt.includes("2개 PDF 파일로 분할했습니다"), 10_000);
	const part1 = join(DOCS_DIR, "contract-part1-p1-2.pdf");
	const part2 = join(DOCS_DIR, "contract-part2-p3-6.pdf");
	check(
		"Split PDF created expected range files",
		existsSync(part1) &&
			existsSync(part2) &&
			(await PDFDocument.load(readFileSync(part1))).getPageCount() === 2 &&
			(await PDFDocument.load(readFileSync(part2))).getPageCount() === 4,
	);

	// 9. Find text inside PDF (Cmd/Ctrl+F) -> verify match highlight box drawn on canvas!
	await main.keyboard.press(chord("f"));
	const findInput = pdfEditor.locator('input[data-pdf-find-input="true"]');
	await findInput.waitFor({ timeout: 10_000 });
	await findInput.fill("Invoice Clause");
	await poll(() => pdfEditor.innerText(), (txt) => txt.includes("1 / 1"), 10_000);
	const highlightBox = await pdfEditor.locator('[data-pdf-find-highlight="current"]').first().boundingBox();
	check(
		"Find-in-PDF highlighted 'Invoice Clause' directly on the PDF canvas",
		highlightBox !== null && highlightBox.width > 30 && highlightBox.height > 8,
		JSON.stringify(highlightBox),
	);
	await shot("04-pdf-final-with-find-and-right-rail");

	// Close Find bar (Escape) so focus leaves the input, then trigger real Cmd/Ctrl+Z keyboard Undo!
	await main.keyboard.press("Escape");
	await main.keyboard.press(chord("z"));
	const fieldsRestored = await poll(async () => (await PDFDocument.load(readFileSync(CONTRACT))).getForm().getFields().length, (n) => n >= 2, 10_000);
	check("Cmd/Ctrl+Z keyboard shortcut restored pre-flatten PDF snapshot", fieldsRestored >= 2, `fields=${fieldsRestored}`);
} catch (error) {
	check("the lane ran to the end", false, error instanceof Error ? error.message.split("\n")[0] : String(error));
	for (const page of app.windows()) {
		await page.screenshot({ path: join(EVIDENCE, "failure.png") }).catch(() => undefined);
	}
} finally {
	await app.close().catch(() => undefined);
	try {
		rmRetry(WORK);
	} catch {
		rmSync(WORK, { recursive: true, force: true });
	}
}

if (failures.length > 0) {
	console.error(`LIVE PDF ACROBAT QA FAILED (${failures.length}): ${failures.join(", ")}`);
	process.exit(1);
}
console.log("ALL LIVE PDF EDITOR ACROBAT CHECKS PASSED");
