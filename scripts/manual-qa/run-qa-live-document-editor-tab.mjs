/**
 * Live end-to-end QA: Document Editor tab (Quick Look handoff + Option/Alt+click
 * + TipTap WYSIWYG + autosave + real 2026+ LLM AI edit & Undo).
 *
 * Drives real Electron UI actions:
 *   1. Open `plan.md` in Quick Look (Space), click the pen (edit) button ->
 *      Quick Look closes and a new Document Editor tab opens in Finder.
 *   2. Edit `plan.md` directly inside the TipTap WYSIWYG editor and verify
 *      autosave writes the edited Markdown to disk.
 *   3. Use the docked AI editor bar with real `deepseek/deepseek-v4.1-flash`
 *      (2026-09-10) to change the date -> verify bytes on disk, live reload in
 *      the editor, and Undo AI edit restores the prior bytes.
 *   4. Option+click (macOS) / Alt+click (Win/Linux) `notes.ts` in Finder ->
 *      opens a code editor tab directly, edit + Cmd/Ctrl+S saves to disk.
 *   5. Option+click `budget.docx` (macOS) -> opens package editor tab with
 *      preview + mark-up canvas, box the amount, ask AI to update it -> valid
 *      `.docx` updated on disk.
 *
 *   bun run qa script --vm scripts/manual-qa/run-qa-live-document-editor-tab.mjs --token "$TOKEN"
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { PDFDocument, rgb } from "pdf-lib";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createFinderPreview, finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { chord, isMac, rmRetry } from "./platform.mjs";

const REAL_API = "https://api.dazziapp.com";
const MODEL_ID = process.env.QA_LIVE_MODEL?.trim() || "deepseek/deepseek-v4.1-flash";
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-document-editor-tab");
mkdirSync(EVIDENCE, { recursive: true });

function resolveToken() {
	const flagIdx = process.argv.indexOf("--token");
	if (flagIdx >= 0 && typeof process.argv[flagIdx + 1] === "string" && process.argv[flagIdx + 1].trim().length > 0) {
		return process.argv[flagIdx + 1].trim();
	}
	const fromEnv = process.env.QA_DAZZI_TOKEN?.trim();
	if (fromEnv) return fromEnv;
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	if (!existsSync(authPath)) return null;
	try {
		const entry = JSON.parse(readFileSync(authPath, "utf8")).dazzi;
		return typeof entry?.access === "string" && entry.access.length > 0 ? entry.access : null;
	} catch {
		return null;
	}
}

const TOKEN = resolveToken();
if (TOKEN === null) {
	console.error("A Dazzi account key is required: pass --token, set QA_DAZZI_TOKEN, or sign in to Dazzi on this machine.");
	process.exit(2);
}

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
		await sleep(250);
		value = await read();
	}
	return value;
}

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-live-doc-editor-"));
const HOME_DIR = join(WORK, "home");
const DOCS_DIR = join(HOME_DIR, "Documents");
const AGENT_DIR = join(WORK, "pi-agent");
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const USER_DATA = join(WORK, "user-data");

for (const folder of ["Desktop", "Documents", "Downloads", "Music", "Movies", "Pictures", ".Trash"]) {
	mkdirSync(join(HOME_DIR, folder), { recursive: true });
}

const PLAN = join(DOCS_DIR, "plan.md");
const PLAN_TEXT = ["# 출시 계획", "", "출시일: 2026년 11월 15일", "", "담당: 김민수", ""].join("\n");
writeFileSync(PLAN, PLAN_TEXT, "utf8");

const NOTES = join(DOCS_DIR, "notes.ts");
const NOTES_TEXT = "export const version = 1;\n";
writeFileSync(NOTES, NOTES_TEXT, "utf8");

const BUDGET = join(DOCS_DIR, "budget.docx");
if (isMac) {
	const html = join(WORK, "budget.html");
	writeFileSync(html, '<html><body><h1>분기 예산</h1><p>예산: 300만 원</p><p>승인: 박지영</p></body></html>', "utf8");
	execFileSync("textutil", ["-inputencoding", "UTF-8", "-convert", "docx", "-output", BUDGET, html]);
}
const docxText = (path) => execFileSync("textutil", ["-convert", "txt", "-stdout", path], { encoding: "utf8" });

const CONTRACT = join(DOCS_DIR, "contract.pdf");
{
	const pdf = await PDFDocument.create();
	for (const idx of [0, 1, 2]) {
		const page = pdf.addPage([595, 842]);
		page.drawRectangle({ x: 48, y: 720, width: 220, height: 32, color: rgb(0.15 + idx * 0.2, 0.35, 0.7) });
		page.drawRectangle({ x: 48, y: 660, width: 320, height: 14, color: rgb(0.85, 0.87, 0.9) });
	}
	writeFileSync(CONTRACT, await pdf.save());
}

mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(join(AUTORAG_HOME, "bin"), { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });
const minsyncStub = join(AUTORAG_HOME, "bin", "minsync");
writeFileSync(minsyncStub, "#!/bin/sh\nexit 0\n");
chmodSync(minsyncStub, 0o755);

const service = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	if (url.pathname === "/desktop/authorize") {
		const target = new URL(url.searchParams.get("redirect_uri"));
		target.searchParams.set("code", "qa-code");
		target.searchParams.set("state", url.searchParams.get("state"));
		res.writeHead(302, { location: target.toString() }).end();
		return;
	}
	if (url.pathname === "/api/desktop/token") {
		req.resume();
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: TOKEN }));
		return;
	}
	const headers = { ...req.headers, host: new URL(REAL_API).host };
	delete headers["accept-encoding"];
	const upstream = httpsRequest(`${REAL_API}${req.url}`, { method: req.method, headers }, (reply) => {
		res.writeHead(reply.statusCode ?? 502, reply.headers);
		reply.pipe(res);
	});
	upstream.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
	req.pipe(upstream);
});
const listening = Promise.withResolvers();
service.listen(0, "127.0.0.1", listening.resolve);
await listening.promise;
const baseUrl = `http://127.0.0.1:${service.address().port}`;

const model = {
	provider: "dazzi",
	id: MODEL_ID,
	name: MODEL_ID,
	baseUrl: `${baseUrl}/v1`,
	api: "openai-responses",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 1048576,
	maxTokens: 32000,
};
writeFileSync(
	CONFIG,
	`${JSON.stringify(
		{
			searchPaths: [DOCS_DIR],
			workspacePath: join(WORK, "workspace"),
			memoryPath: join(WORK, "memory.json"),
			minSync: { enabled: true, autoInstall: true, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } },
			jikji: false,
			model,
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
	AUTORAG_BASE_URL: baseUrl,
	PI_CODING_AGENT_DIR: AGENT_DIR,
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	ELECTRON_RENDERER_URL: "",
	AUTORAG_PERMISSION_MODE: "",
	PATH: `${join(AUTORAG_HOME, "bin")}${delimiter}${process.env.PATH ?? ""}`,
	OPENROUTER_API_KEY: "",
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
};

const app = await launchFinder({ userDataDir: USER_DATA, env, language: "ko" });
try {
	const main = await finderWindow(app, 30_000);
	main.setDefaultTimeout(60_000);
	await app.evaluate(({ shell }) => {
		shell.openExternal = async (url) => {
			await fetch(url);
		};
	});
	const status = await main.evaluate(() => window.autorag.account.signIn());
	check("Dazzi sign-in completes", status.state === "signedIn", `${status.state} ${status.error ?? ""}`);
	const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
	cfg.model = model;
	writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`);
	console.log(`live model: ${MODEL_ID}`);

	const finderPreview = createFinderPreview(app, main);
	let preview;
	const ensurePreview = async () => {
		if (preview !== undefined) return preview;
		preview = await poll(() => finderPreview.page().catch(() => undefined), (page) => page !== undefined, 30_000);
		if (preview === undefined) throw new Error("Finder Quick Look window did not appear");
		preview.setDefaultTimeout(60_000);
		return preview;
	};
	const previewVisible = async () => (await finderPreview.state())?.visible ?? false;
	const shotMain = async (name) => {
		await sleep(350);
		await main.screenshot({ path: join(EVIDENCE, `${name}.png`) });
	};
	const shotPreview = async (name) => {
		await sleep(300);
		await preview.screenshot({ path: join(EVIDENCE, `${name}.png`) });
	};

	const rowFor = (name) =>
		main
			.locator('[role="row"]')
			.filter({ has: main.locator(".row__label", { hasText: new RegExp(`^${name.replace(/\./g, "\\.")}$`) }) })
			.first();

	await main.locator(".sidebar .sidebar__item", { hasText: "문서" }).click();
	await rowFor("plan.md").waitFor({ timeout: 30_000 });

	// 1. Quick Look pen button -> closes Quick Look and opens Document Editor tab in Finder.
	await rowFor("plan.md").click();
	await main.keyboard.press("Space");
	await ensurePreview();
	if ((await poll(previewVisible, Boolean, 15_000)) !== true) {
		await main.keyboard.press("Space");
		await poll(previewVisible, Boolean, 10_000);
	}
	await preview.locator(".qlw__name", { hasText: "plan.md" }).waitFor();
	const penBtn = preview.locator('button[aria-label="표시하고 편집"]');
	check("Quick Look shows pen button for plan.md", (await penBtn.count()) === 1);
	await shotPreview("01-quick-look-plan");

	await penBtn.click();
	const qlClosed = await poll(async () => (await previewVisible()) === false, Boolean, 10_000);
	check("Quick Look closes after pressing edit button", qlClosed === true);

	const mdEditor = main.locator('[data-document-editor][data-editor-surface="wysiwyg"]');
	await mdEditor.waitFor({ timeout: 15_000 });
	check("New Document Editor tab opened in WYSIWYG mode", (await main.locator('[data-document-editor-tab="true"]').count()) === 1);
	check("Freshly opened markdown starts cleanly in saved state", (await mdEditor.locator('[data-save-state="saved"]').count()) === 1);
	await shotMain("02-wysiwyg-opened");

	// 2. Direct WYSIWYG typing + autosave to disk.
	const prose = mdEditor.locator(".tiptap");
	await prose.click();
	await main.keyboard.press("End");
	await main.keyboard.press("Enter");
	await main.keyboard.type("검토자: 이영희");
	const autoSaved = await poll(() => readFileSync(PLAN, "utf8"), (txt) => txt.includes("검토자: 이영희"), 8_000);
	check("Direct WYSIWYG edit autosaved to disk", autoSaved.includes("검토자: 이영희"), autoSaved);
	await main.locator('[data-save-state="saved"]').waitFor({ timeout: 8_000 });
	await shotMain("03-wysiwyg-autosaved");

	// 3. Real LLM AI edit via the RIGHT SIDEBAR chat + Undo AI edit.
	const beforeAi = readFileSync(PLAN, "utf8");
	const sidebar = main.locator("[data-document-editor-sidebar]");
	await sidebar.waitFor({ timeout: 10_000 });
	const aiInput = sidebar.locator("textarea");
	await aiInput.click();
	await main.keyboard.type("출시일을 2026년 11월 25일로 바꿔줘");
	await main.keyboard.press("Enter");
	await sidebar.locator('[data-edit-state="running"]').waitFor({ timeout: 10_000 });
	await sidebar.locator('[data-edit-state="changed"], [data-edit-state="unchanged"], [data-edit-state="error"]').waitFor({ timeout: 300_000 });
	const planAfterAi = readFileSync(PLAN, "utf8");
	console.log(`plan.md after AI edit:\n${planAfterAi}`);
	check(
		"Right-sidebar AI edited plan.md on disk and preserved manual edit",
		planAfterAi.includes("11월 25일") && !planAfterAi.includes("11월 15일") && planAfterAi.includes("검토자: 이영희"),
		planAfterAi,
	);
	const editorReloaded = await poll(() => prose.innerText(), (txt) => txt.includes("11월 25일"), 10_000);
	check("WYSIWYG editor reloaded updated text after right-sidebar AI edit", editorReloaded.includes("11월 25일"));
	await shotMain("04-wysiwyg-ai-edited");

	await sidebar.locator("button", { hasText: "AI 편집 되돌리기" }).click();
	await sidebar.locator('[data-edit-state="undone"]').waitFor({ timeout: 15_000 });
	const planUndone = readFileSync(PLAN, "utf8");
	check("Undo AI edit in right sidebar restored pre-AI bytes", planUndone === beforeAi, planUndone);
	await shotMain("05-wysiwyg-ai-undone");
	// 4. Switch back to the folder tab and Option/Alt+click notes.ts -> opens code editor tab.
	await main.locator(".tabs .tab").first().click();
	await rowFor("notes.ts").waitFor({ timeout: 15_000 });
	await rowFor("notes.ts").click({ modifiers: ["Alt"] });

	const codeEditor = main.locator('[data-document-editor][data-editor-surface="code"]');
	await codeEditor.waitFor({ timeout: 15_000 });
	check("Option/Alt+click opened code editor tab for notes.ts", (await main.locator('[data-document-editor-tab="true"]').count()) === 2);
	const sourceArea = codeEditor.locator("textarea.doc-editor__source");
	await sourceArea.click();
	await sourceArea.fill("export const version = 2;\n");
	await main.keyboard.press(chord("s"));
	const notesSaved = await poll(() => readFileSync(NOTES, "utf8"), (txt) => txt.includes("version = 2"), 8_000);
	check("Code editor Cmd/Ctrl+S saved notes.ts to disk", notesSaved.includes("version = 2"), notesSaved);
	await shotMain("06-code-editor-saved");

	// 5. Option/Alt+click budget.docx (macOS) -> package preview + mark-up + live right-sidebar AI edit.
	if (isMac) {
		await main.locator(".tabs .tab").first().click();
		await rowFor("budget.docx").waitFor({ timeout: 15_000 });
		await rowFor("budget.docx").click({ modifiers: ["Alt"] });

		const pkgEditor = main.locator('[data-document-editor][data-editor-surface="package"]');
		await pkgEditor.waitFor({ timeout: 15_000 });
		await pkgEditor.locator('[data-markup-layer="true"]').waitFor({ timeout: 15_000 });
		await shotMain("07-package-editor-opened");

		const pkgSidebar = main.locator(`[data-document-editor-sidebar="${BUDGET}"]`);
		await pkgSidebar.waitFor({ timeout: 10_000 });
		const pkgAiInput = pkgSidebar.locator("textarea");
		await pkgAiInput.click();
		await main.keyboard.type("예산 금액을 450만 원으로 바꿔줘");
		await main.keyboard.press("Enter");
		await pkgSidebar.locator('[data-edit-state="running"]').waitFor({ timeout: 10_000 });
		await pkgSidebar.locator('[data-edit-state="changed"], [data-edit-state="unchanged"], [data-edit-state="error"]').waitFor({ timeout: 300_000 });
		const budgetAfter = docxText(BUDGET);
		console.log(`budget.docx after AI edit:\n${budgetAfter}`);
		check(
			"Package editor right-sidebar AI updated budget.docx validly",
			budgetAfter.includes("450만") && !budgetAfter.includes("300만") && budgetAfter.includes("승인: 박지영"),
			budgetAfter,
		);
		await shotMain("08-package-ai-edited");
	}

	// 6. Option/Alt+click contract.pdf -> PDF editor: signature pad + place, rotate, crop, delete page, extract page, undo.
	await main.locator(".tabs .tab").first().click();
	await rowFor("contract.pdf").waitFor({ timeout: 15_000 });
	await rowFor("contract.pdf").click({ modifiers: ["Alt"] });

	const pdfEditor = main.locator('[data-document-editor][data-editor-surface="pdf"]');
	await pdfEditor.waitFor({ timeout: 15_000 });
	await pdfEditor.locator('[data-pdf-thumb="1"]').waitFor({ timeout: 15_000 });
	await pdfEditor.locator('[data-pdf-thumb="3"]').waitFor({ timeout: 15_000 });
	await shotMain("09-pdf-editor-opened");

	// 6a. Draw signature on Signature Pad and apply to page 1.
	await pdfEditor.locator("button", { hasText: "서명 추가" }).click();
	const sigCanvas = main.locator('[data-signature-canvas="true"]');
	await sigCanvas.waitFor({ timeout: 10_000 });
	const sigBox = await sigCanvas.boundingBox();
	if (sigBox === null) throw new Error("Signature canvas has no bounding box");
	await main.mouse.move(sigBox.x + 60, sigBox.y + 80);
	await main.mouse.down();
	await main.mouse.move(sigBox.x + 150, sigBox.y + 40, { steps: 6 });
	await main.mouse.move(sigBox.x + 240, sigBox.y + 110, { steps: 6 });
	await main.mouse.up();
	await main.locator("button", { hasText: "서명 배치" }).click();
	await pdfEditor.locator('[data-pdf-stamp-box="true"]').waitFor({ timeout: 10_000 });
	await shotMain("10-pdf-signature-placing");
	await pdfEditor.locator('[data-pdf-commit-stamp="true"]').click();
	await poll(() => pdfEditor.innerText(), (txt) => txt.includes("서명을 PDF에 저장했습니다"), 10_000);
	check("PDF signature stamped and saved to disk", readFileSync(CONTRACT).byteLength > 0);

	// 6b. Rotate page 1 by 90 degrees.
	await pdfEditor.locator('button[aria-label="오른쪽으로 90도 회전"]').click();
	await poll(async () => (await PDFDocument.load(readFileSync(CONTRACT))).getPage(0).getRotation().angle, (deg) => deg === 90, 10_000);
	check("PDF page 1 rotated 90 degrees on disk", (await PDFDocument.load(readFileSync(CONTRACT))).getPage(0).getRotation().angle === 90);

	// 6c. Crop page 1.
	await pdfEditor.locator("button", { hasText: "자르기" }).click();
	await pdfEditor.locator('[data-pdf-crop-box="true"]').waitFor({ timeout: 10_000 });
	await pdfEditor.locator('[data-pdf-commit-crop="true"]').click();
	await poll(() => pdfEditor.innerText(), (txt) => txt.includes("페이지를 잘라 저장했습니다"), 10_000);
	const croppedBox = (await PDFDocument.load(readFileSync(CONTRACT))).getPage(0).getCropBox();
	check("PDF page 1 cropped (CropBox smaller than original 595x842)", croppedBox.width < 590 && croppedBox.height < 835, JSON.stringify(croppedBox));

	// 6d. Delete page 3 -> 2 pages remain, then extract page 1 into sibling PDF.
	await pdfEditor.locator('[data-pdf-thumb="3"]').click();
	await pdfEditor.locator('button[aria-label="페이지 삭제"]').click();
	const countAfterDelete = await poll(async () => (await PDFDocument.load(readFileSync(CONTRACT))).getPageCount(), (n) => n === 2, 10_000);
	check("PDF page deleted (3 -> 2 pages)", countAfterDelete === 2, `pages=${countAfterDelete}`);
	await shotMain("11-pdf-edited");

	await pdfEditor.locator('[data-pdf-thumb="1"]').click();
	await pdfEditor.locator("button", { hasText: "현재 페이지 추출" }).click();
	const extractedPath = join(DOCS_DIR, "contract-p1.pdf");
	const extractedExists = await poll(() => existsSync(extractedPath), Boolean, 10_000);
	check("PDF extracted current page to sibling contract-p1.pdf", extractedExists && (await PDFDocument.load(readFileSync(extractedPath))).getPageCount() === 1);

	// 6e. Undo restores deleted page back to 3 pages.
	await pdfEditor.locator("button", { hasText: "실행 취소" }).click();
	const countAfterUndo = await poll(async () => (await PDFDocument.load(readFileSync(CONTRACT))).getPageCount(), (n) => n === 3, 10_000);
	check("PDF undo restored deleted page (2 -> 3 pages)", countAfterUndo === 3, `pages=${countAfterUndo}`);
} catch (error) {
	check(
		"the lane ran to the end",
		false,
		error instanceof Error ? `${error.message.split("\n")[0]} @ ${(error.stack ?? "").split("\n").find((line) => line.includes("run-qa-live-document-editor-tab")) ?? ""}` : String(error),
	);
	for (const page of app.windows()) {
		const name = page.url().includes("quick-look.html") ? "failure-quick-look" : "failure-finder";
		await page.screenshot({ path: join(EVIDENCE, `${name}.png`) }).catch(() => undefined);
	}
} finally {
	await app.close().catch(() => undefined);
	service.close();
	try {
		rmRetry(WORK);
	} catch {
		rmSync(WORK, { recursive: true, force: true });
	}
}

if (failures.length > 0) {
	console.error(`LIVE QA FAILED (${failures.length}): ${failures.join(", ")}`);
	process.exit(1);
}
console.log("ALL LIVE DOCUMENT EDITOR TAB CHECKS PASSED");
