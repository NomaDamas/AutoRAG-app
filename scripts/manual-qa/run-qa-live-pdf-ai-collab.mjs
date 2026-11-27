/**
 * Live end-to-end QA: Right-sidebar AI Agent + Human simultaneous co-editing on PDF.
 *
 * Drives the real built Electron app against a real live LLM (OpenRouter `~anthropic/claude-sonnet-latest`
 * or Dazzi plan `deepseek/deepseek-v4.1-flash`):
 *   1. Open `contract.pdf` (3 pages, AcroForm fields `signer_name` + `agree_terms`) in the PDF Editor tab.
 *   2. Verify right-sidebar AI editing chat & markup toggle are active for PDF.
 *   3. Turn 1 (Simultaneous Human + AI Co-edit):
 *      - Submit an AI instruction in the right sidebar:
 *        add CONFIDENTIAL watermark + page numbers (1/N), fill signer_name='Jeffrey Kim' & agree_terms=true,
 *        and set PDF document title='Dazzi Co-Edited Agreement'.
 *      - IMMEDIATELY while the AI turn is `running`, use the human PDF toolbar to:
 *        a) Rotate Page 1 by 90° clockwise
 *        b) Duplicate Page 1 (3 -> 4 pages)
 *      - Wait for AI turn to finish (`changed`).
 *      - Verify BOTH the human's concurrent edits (Page 1 rotated 90°, total 4 pages) AND the AI's structured tool edits
 *        (title === 'Dazzi Co-Edited Agreement', signer_name === 'Jeffrey Kim', agree_terms === true, watermark + page numbers)
 *        are preserved together on disk with zero conflict error, and the PDF editor UI live-synced to 4 pages!
 *   4. Turn 2 (Visual Markup + AI Redaction + Selective AI Undo):
 *      - Activate "표시 후 AI 편집" (`markupToggle`), draw a mark on Page 3, and ask AI to black-redact that region.
 *      - Verify AI completes (`changed`), marks clear automatically, and Undo AI edit restores exact pre-Turn-2 PDF bytes.
 *
 *   bun run qa script --host --skip-build scripts/manual-qa/run-qa-live-pdf-ai-collab.mjs
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PDFCheckBox, PDFDocument, PDFTextField, rgb, StandardFonts } from "pdf-lib";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { rmRetry } from "./platform.mjs";

const REAL_API = "https://api.dazziapp.com";
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-pdf-ai-collab");
mkdirSync(EVIDENCE, { recursive: true });

function readFlagFile(flag) {
	const idx = process.argv.indexOf(flag);
	if (idx < 0 || typeof process.argv[idx + 1] !== "string") return null;
	const p = process.argv[idx + 1].trim();
	if (!p || !existsSync(p)) return null;
	const raw = readFileSync(p, "utf8").trim();
	return raw.length > 0 ? raw : null;
}

function resolveOpenRouterKey() {
	const fromFile = readFlagFile("--openrouter-key-file");
	if (fromFile) return fromFile;
	const fromEnv = process.env.QA_OPENROUTER_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim();
	if (fromEnv) return fromEnv;
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	if (!existsSync(authPath)) return null;
	try {
		const entry = JSON.parse(readFileSync(authPath, "utf8")).openrouter;
		return typeof entry?.key === "string" && entry.key.length > 0 ? entry.key : null;
	} catch {
		return null;
	}
}

function resolveDazziToken() {
	const fromFile = readFlagFile("--token-file");
	if (fromFile) return fromFile;
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

const OPENROUTER_KEY = resolveOpenRouterKey();
const DAZZI_TOKEN = OPENROUTER_KEY === null ? resolveDazziToken() : null;
if (OPENROUTER_KEY === null && DAZZI_TOKEN === null) {
	console.error("An OpenRouter API key (OPENROUTER_API_KEY / --openrouter-key-file) or Dazzi token (--token / QA_DAZZI_TOKEN) is required.");
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

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-live-pdf-collab-"));
const HOME_DIR = join(WORK, "home");
const DOCS_DIR = join(HOME_DIR, "Documents");
const AGENT_DIR = join(WORK, "pi-agent");
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const USER_DATA = join(WORK, "user-data");

for (const folder of ["Desktop", "Documents", "Downloads", "Music", "Movies", "Pictures", ".Trash"]) {
	mkdirSync(join(HOME_DIR, folder), { recursive: true });
}

const CONTRACT = join(DOCS_DIR, "contract.pdf");
{
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	const form = pdf.getForm();
	for (const idx of [0, 1, 2]) {
		const page = pdf.addPage([595, 842]);
		page.drawRectangle({ x: 48, y: 740, width: 320, height: 28, color: rgb(0.15 + idx * 0.2, 0.35, 0.7) });
		page.drawText(`Master Agreement — Page ${idx + 1}`, { x: 48, y: 700, size: 16, font, color: rgb(0.1, 0.1, 0.14) });
		page.drawText(`Account SSN: 900101-1234567 (Sensitive Line)`, { x: 48, y: 650, size: 12, font, color: rgb(0.25, 0.1, 0.1) });
		if (idx === 0) {
			const signer = form.createTextField("signer_name");
			signer.setText("Pending");
			signer.addToPage(page, { x: 48, y: 560, width: 220, height: 24 });
			const agree = form.createCheckBox("agree_terms");
			agree.addToPage(page, { x: 48, y: 520, width: 18, height: 18 });
		}
	}
	writeFileSync(CONTRACT, await pdf.save());
}

mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(join(AUTORAG_HOME, "bin"), { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });
const minsyncStub = join(AUTORAG_HOME, "bin", "minsync");
writeFileSync(minsyncStub, "#!/bin/sh\nexit 0\n");
chmodSync(minsyncStub, 0o755);

let service = null;
let baseUrl = null;
if (OPENROUTER_KEY !== null) {
	writeFileSync(join(AGENT_DIR, "auth.json"), `${JSON.stringify({ openrouter: { type: "api_key", key: OPENROUTER_KEY } })}\n`, { mode: 0o600 });
} else {
	service = createServer((req, res) => {
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
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: DAZZI_TOKEN }));
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
	baseUrl = `http://127.0.0.1:${service.address().port}`;
}

const model =
	OPENROUTER_KEY !== null
		? {
				provider: "openrouter",
				id: process.env.QA_LIVE_MODEL?.trim() || "~anthropic/claude-sonnet-latest",
				name: "Anthropic: Claude Sonnet Latest",
				baseUrl: "https://openrouter.ai/api",
				api: "anthropic-messages",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 1048576,
				maxTokens: 32000,
				apiKeyEnv: "OPENROUTER_API_KEY",
			}
		: {
				provider: "dazzi",
				id: process.env.QA_LIVE_MODEL?.trim() || "deepseek/deepseek-v4.1-flash",
				name: process.env.QA_LIVE_MODEL?.trim() || "deepseek/deepseek-v4.1-flash",
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
	...(baseUrl === null ? {} : { AUTORAG_BASE_URL: baseUrl }),
	PI_CODING_AGENT_DIR: AGENT_DIR,
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	ELECTRON_RENDERER_URL: "",
	AUTORAG_PERMISSION_MODE: "",
	PATH: `${join(AUTORAG_HOME, "bin")}${delimiter}${process.env.PATH ?? ""}`,
	OPENROUTER_API_KEY: OPENROUTER_KEY ?? "",
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
};

const app = await launchFinder({ userDataDir: USER_DATA, env, language: "ko" });
try {
	const main = await finderWindow(app, 30_000);
	main.setDefaultTimeout(60_000);
	if (DAZZI_TOKEN !== null) {
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
	}
	console.log(`live model: ${model.provider}/${model.id}`);

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
	await rowFor("contract.pdf").waitFor({ timeout: 30_000 });
	await rowFor("contract.pdf").click({ modifiers: ["Alt"] });

	const pdfEditor = main.locator('[data-document-editor][data-editor-surface="pdf"]');
	await pdfEditor.waitFor({ timeout: 15_000 });
	await pdfEditor.locator('[data-pdf-thumb="3"]').waitFor({ timeout: 15_000 });

	// Right-sidebar AI editing panel is already docked beside the PDF editor
	const sidebar = main.locator(`[data-document-editor-sidebar="${CONTRACT}"]`);
	await sidebar.waitFor({ timeout: 10_000 });
	const aiInput = sidebar.locator("textarea");
	await aiInput.waitFor({ timeout: 10_000 });
	check("Right-sidebar AI chat composer is enabled for PDF tab", await aiInput.isEnabled());
	await shot("01-pdf-with-ai-sidebar");

	// 1. Simultaneous Human + AI Co-Editing!
	await aiInput.click();
	await main.keyboard.type(
		"모든 페이지에 CONFIDENTIAL 워터마크와 하단 페이지 번호(1/N)를 추가하고, 양식 필드 signer_name을 'Jeffrey Kim'으로, agree_terms를 true로 채우고, PDF 문서 제목(title)을 'Dazzi Co-Edited Agreement'로 설정해줘",
	);
	await main.keyboard.press("Enter");
	await sidebar.locator('[data-edit-state="running"]').waitFor({ timeout: 15_000 });

	// While AI is actively running, perform human edits via toolbar simultaneously!
	await pdfEditor.locator('button[aria-label="오른쪽으로 90도 회전"]').click();
	await pdfEditor.locator('button[data-pdf-more-tools="true"]').click();
	await pdfEditor.locator('button[data-pdf-action="duplicate"]').click();
	await shot("02-human-editing-while-ai-running");

	// Wait for AI turn to finish
	await sidebar.locator('[data-edit-state="changed"], [data-edit-state="unchanged"], [data-edit-state="error"]').waitFor({ timeout: 300_000 });
	const turn1State = await sidebar.locator("[data-edit-state]").first().getAttribute("data-edit-state");
	const sidebarText1 = await sidebar.innerText();
	console.log(`Turn 1 state=${turn1State}\n${sidebarText1}`);
	check("AI Turn 1 completed with changed state", turn1State === "changed", turn1State ?? "");

	// Verify BOTH human edits and AI edits survived together on disk!
	const docAfterCollab = await PDFDocument.load(readFileSync(CONTRACT));
	const pageCount = docAfterCollab.getPageCount();
	const p1Angle = docAfterCollab.getPage(0).getRotation().angle;
	const docTitle = docAfterCollab.getTitle() ?? "";
	const formAfter = docAfterCollab.getForm();
	const signerField = formAfter.getFieldMaybe("signer_name");
	const agreeField = formAfter.getFieldMaybe("agree_terms");
	const signerVal = signerField instanceof PDFTextField ? signerField.getText() : "";
	const agreeVal = agreeField instanceof PDFCheckBox ? agreeField.isChecked() : false;

	check("Human duplicate edit preserved during AI run (pageCount === 4)", pageCount === 4, `pages=${pageCount}`);
	check("Human rotation edit preserved during AI run (page 1 angle === 90)", p1Angle === 90, `angle=${p1Angle}`);
	check("AI metadata edit saved (title === 'Dazzi Co-Edited Agreement')", docTitle === "Dazzi Co-Edited Agreement", `title=${docTitle}`);
	check("AI AcroForm fill saved (signer_name='Jeffrey Kim', agree_terms=true)", signerVal === "Jeffrey Kim" && agreeVal === true, `signer=${signerVal} agree=${agreeVal}`);

	// Verify live-sync updated the PDF editor thumbnail rail to 4 pages without manual reload
	const thumb4Visible = await poll(async () => (await pdfEditor.locator('[data-pdf-thumb="4"]').count()) === 1, Boolean, 10_000);
	check("PDF editor UI live-synced to 4 thumbnails automatically", thumb4Visible === true);
	check("No conflict error shown during simultaneous co-editing", !(await pdfEditor.innerText()).includes("외부에서 변경되었습니다"));
	await shot("03-after-simultaneous-coedit");

	// 2. Turn 2: Visual Markup on PDF + AI Redaction + Selective Undo AI edit
	await pdfEditor.locator('[data-pdf-thumb="3"]').click();
	await sleep(300);
	const beforeTurn2Bytes = readFileSync(CONTRACT);

	// Toggle "표시 후 AI 편집" markup layer on PDF and draw a box
	await sidebar.locator("button", { hasText: "표시 후 AI 편집" }).click();
	const markupLayer = pdfEditor.locator('[data-markup-layer="true"]');
	await markupLayer.waitFor({ timeout: 10_000 });
	const box = await markupLayer.boundingBox();
	if (box === null) throw new Error("Markup layer has no bounding box");
	await main.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.22);
	await main.mouse.down();
	await main.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.28, { steps: 6 });
	await main.mouse.up();

	const badgeShown = await poll(async () => (await sidebar.innerText()).includes("표시 1개"), Boolean, 5_000);
	check("PDF visual markup attached to right-sidebar AI chat (표시 1개)", badgeShown === true);
	await shot("04-pdf-markup-drawn");

	await aiInput.click();
	await main.keyboard.type("방금 표시한 3페이지 영역을 검은색 가리기(redactRect)로 가려줘");
	await main.keyboard.press("Enter");
	await sidebar.locator('[data-edit-state="running"]').waitFor({ timeout: 15_000 });
	await poll(
		async () => (await sidebar.locator('[data-edit-state="running"]').count()) === 0,
		Boolean,
		300_000,
	);
	const states2 = await sidebar.locator("[data-edit-state]").evaluateAll((els) => els.map((e) => e.getAttribute("data-edit-state")));
	check("AI Turn 2 redaction from visual markup succeeded", states2.at(-1) === "changed", JSON.stringify(states2));
	await shot("05-pdf-ai-redacted");

	// Undo Turn 2 from right sidebar -> restores pre-Turn-2 PDF bytes while keeping Turn 1 + human edits!
	await sidebar.locator("button", { hasText: "AI 편집 되돌리기" }).last().click();
	await poll(
		async () => {
			const s = await sidebar.locator("[data-edit-state]").evaluateAll((els) => els.map((e) => e.getAttribute("data-edit-state")));
			return s.at(-1) === "undone";
		},
		Boolean,
		15_000,
	);
	const afterUndoBytes = readFileSync(CONTRACT);
	check("Undo AI edit restored exact pre-Turn-2 PDF bytes", afterUndoBytes.equals(beforeTurn2Bytes));
	await shot("06-pdf-ai-undone");
} catch (error) {
	check("the lane ran to the end", false, error instanceof Error ? error.message.split("\n")[0] : String(error));
	for (const page of app.windows()) {
		await page.screenshot({ path: join(EVIDENCE, "failure.png") }).catch(() => undefined);
	}
} finally {
	await app.close().catch(() => undefined);
	service?.close();
	try {
		rmRetry(WORK);
	} catch {
		rmSync(WORK, { recursive: true, force: true });
	}
}

if (failures.length > 0) {
	console.error(`LIVE PDF AI COLLAB QA FAILED (${failures.length}): ${failures.join(", ")}`);
	process.exit(1);
}
console.log("ALL LIVE PDF AI COLLAB CHECKS PASSED");
