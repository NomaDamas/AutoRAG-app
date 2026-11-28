/**
 * Live E2E: the main AutoRAG agent (AI 에이전트 tab) delegates a PDF edit to the app's `pdf-editor` host subagent.
 *
 * A real model gets one Korean request in the AI agent chat (not the PDF editor sidebar). The librarian's
 * `subagent` tool hands it to the same PDF edit agent the editor sidebar runs, which edits the file, checks it
 * visually, and reports back; the main agent relays the result. Verified by:
 *   - the main-process trace: a `[document-edit] subagent-pdf-…` run (only the subagent path uses that id)
 *     with the stamp / watermark / page-number tools and `pdf_render_page` after the last edit,
 *   - the PDF on disk (stamp, watermark and Korean header images), an untouched `review (원본 …).pdf` copy
 *     saved next to it before the edit (and named in the answer), and the reopened page,
 *   - the main agent's answer in the chat.
 *
 *   bun run qa script --host --skip-build scripts/manual-qa/run-qa-live-main-agent-pdf-subagent.mjs
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PDFDocument, PDFName, PDFRawStream, rgb, StandardFonts } from "pdf-lib";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { rmRetry } from "./platform.mjs";

const REAL_API = "https://api.dazziapp.com";
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-main-agent-pdf-subagent");
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

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-live-pdf-subagent-"));
const HOME_DIR = join(WORK, "home");
const DOCS_DIR = join(HOME_DIR, "Documents");
const AGENT_DIR = join(WORK, "pi-agent");
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const USER_DATA = join(WORK, "user-data");

for (const folder of ["Desktop", "Documents", "Downloads", "Music", "Movies", "Pictures", ".Trash"]) {
	mkdirSync(join(HOME_DIR, folder), { recursive: true });
}

const REVIEW = join(DOCS_DIR, "review.pdf");
const TARGET = "Account SSN";
let targetBox = null; // normalized box of "Account SSN" on page 1
{
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
	const p1 = pdf.addPage([595, 842]);
	p1.drawRectangle({ x: 48, y: 760, width: 330, height: 26, color: rgb(0.12, 0.3, 0.62) });
	p1.drawText("Service Agreement — Review Copy", { x: 48, y: 712, size: 18, font: bold, color: rgb(0.1, 0.1, 0.14) });
	p1.drawText(`${TARGET}: 900101-1234567 (Sensitive Line)`, { x: 48, y: 650, size: 12, font, color: rgb(0.2, 0.2, 0.25) });
	const body = [
		"1. Scope. The provider delivers the services described in Exhibit A.",
		"2. Term. This agreement starts on the effective date and lasts one year.",
		"3. Privacy. Personal data is processed only as required by law.",
	];
	body.forEach((line, i) => p1.drawText(line, { x: 48, y: 600 - i * 22, size: 11, font, color: rgb(0.2, 0.2, 0.25) }));
	const w = font.widthOfTextAtSize(TARGET, 12);
	const h = font.heightAtSize(12);
	targetBox = { x: 48 / 595, y: (842 - 650 - h * 0.8) / 842, width: w / 595, height: h / 842 };
	const p2 = pdf.addPage([595, 842]);
	p2.drawText("Payment Terms", { x: 48, y: 760, size: 18, font: bold, color: rgb(0.1, 0.1, 0.14) });
	p2.drawText("Invoices are due within 30 days of receipt.", { x: 48, y: 720, size: 11, font, color: rgb(0.2, 0.2, 0.25) });
	writeFileSync(REVIEW, await pdf.save());
}

// A transparent-background logo: an opaque teal ring on alpha 0.
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
const LOGO = join(DOCS_DIR, "logo-transparent.png");
{
	const size = 120;
	const raw = Buffer.alloc((1 + size * 4) * size);
	for (let y = 0; y < size; y += 1) {
		for (let x = 0; x < size; x += 1) {
			const d = Math.hypot(x - size / 2, y - size / 2);
			if (d > 40 && d < 56) raw.set([13, 148, 136, 255], y * (1 + size * 4) + 1 + x * 4);
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	writeFileSync(LOGO, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]));
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

// Nobody is there to approve a file change in a headless lane: `full` lets the subagent write (readonly blocks it).
mkdirSync(join(USER_DATA, "settings"), { recursive: true });
writeFileSync(join(USER_DATA, "settings", "settings-state.json"), `${JSON.stringify({ settings: { language: "ko", approvalMode: "full" }, permissions: {} }, null, 2)}\n`);

const app = await launchFinder({ userDataDir: USER_DATA, env, language: "ko" });
try {
	const main = await finderWindow(app, 30_000);
	main.setDefaultTimeout(60_000);
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
	const mainLog = join(EVIDENCE, "main.log");
	writeFileSync(mainLog, "");
	for (const stream of [app.process().stdout, app.process().stderr]) stream?.on("data", (chunk) => appendFileSync(mainLog, chunk));

	await main.locator(".sidebar .sidebar__item", { hasText: "문서" }).click();
	await rowFor("review.pdf").waitFor({ timeout: 30_000 });

	// Ask the MAIN agent (AI 에이전트 tab), not the editor sidebar.
	await main.locator(".sidebar .sidebar__item", { hasText: "AI 에이전트" }).click();
	const AI_PANEL = '[data-ai-tab] section.ai:not([aria-hidden="true"])';
	const composer = main.locator(`${AI_PANEL} .compose-box textarea`);
	await composer.waitFor({ timeout: 20_000 });
	const before = readFileSync(REVIEW);
	const imagesBefore = await countImages(before);
	await composer.fill(
		`${REVIEW} 파일 1페이지 오른쪽 위 여백에 승인 도장을 찍고, 모든 페이지에 대외비 워터마크를 넣어줘. 하단 가운데에 페이지 번호를 넣고 머리글은 '2026 사업계획 검토본'으로 해줘.`,
	);
	await main.keyboard.press("Enter");
	await main.locator(`${AI_PANEL} .user-msg`).waitFor({ timeout: 20_000 });
	await sleep(1500);
	const settled = await main
		.waitForFunction(() => document.querySelector('button[aria-label="중단"]') === null, null, { timeout: 480_000 })
		.then(() => true, () => false);
	check("The main agent's turn finished", settled);
	await sleep(800);
	const answer = (await main.locator(`${AI_PANEL} .assistant-msg .assistant-prose`).allTextContents()).map((t) => t.trim()).filter(Boolean).join("\n");
	console.log(`main agent answer:\n${answer}`);
	writeFileSync(join(EVIDENCE, "answer.txt"), answer);
	await shot("01-main-agent-answer");

	// 1. Delegation happened through the subagent path, and the subagent self-checked visually.
	const trace = readFileSync(mainLog, "utf8").split("\n").filter((line) => line.includes("[document-edit] subagent-pdf-"));
	console.log(`subagent trace:\n${trace.join("\n")}`);
	check("The main agent delegated to the pdf-editor subagent (a subagent-pdf run in the trace)", trace.length >= 1, `${trace.length} run(s)`);
	const tools = trace.flatMap((line) => line.split(" pdf tools: ")[1]?.split(", ").map((name) => name.trim()) ?? []);
	check("The subagent stamped, watermarked and numbered pages", ["pdf_add_stamp", "pdf_add_watermark"].every((name) => tools.includes(name)) && (tools.includes("pdf_add_page_numbers") || tools.includes("pdf_apply_ops")), tools.join(", "));
	const editTools = new Set(["pdf_apply_ops", "pdf_add_note", "pdf_add_stamp", "pdf_add_text_box", "pdf_insert_image", "pdf_add_watermark", "pdf_add_page_numbers"]);
	const lastEdit = tools.reduce((at, name, i) => (editTools.has(name) ? i : at), -1);
	check("The subagent ran pdf_render_page after its last edit (visual QA)", tools.lastIndexOf("pdf_render_page") > lastEdit, tools.join(", "));
	check("The main agent did not edit the PDF itself with shell or file tools", !/\[search\].*(bash|write).*review\.pdf/.test(readFileSync(mainLog, "utf8")));

	// 2. The PDF changed on disk: stamp, watermark and the Korean header line are embedded images.
	const after = readFileSync(REVIEW);
	const imagesAfter = await countImages(after);
	check("review.pdf was edited on disk", !after.equals(before));
	check("Stamp, watermark and Korean header embedded (>= 3 new images incl. masks)", imagesAfter - imagesBefore >= 3, `images ${imagesBefore} -> ${imagesAfter}`);

	// 2b. The untouched original was saved next to it before the edit, and the user is told where.
	const copies = readdirSync(DOCS_DIR).filter((name) => /^review \(원본 \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}( \d+)?\)\.pdf$/u.test(name));
	console.log(`original copies: ${JSON.stringify(copies)}`);
	check("An original copy was saved next to the PDF before the edit", copies.length === 1, JSON.stringify(readdirSync(DOCS_DIR)));
	check("The original copy is byte-identical to the PDF before the edit", copies.length === 1 && readFileSync(join(DOCS_DIR, copies[0])).equals(before));
	check("The main agent tells the user where the original copy is", copies.length === 1 && answer.includes("원본") && (answer.includes(copies[0]) || answer.includes(copies[0].replace(/\.pdf$/u, ""))), answer.slice(0, 400));

	// 3. The main agent relayed the result.
	check("The main agent's answer reports the edit", answer.length > 0 && /(도장|승인|워터마크|대외비|페이지 번호)/.test(answer), answer.slice(0, 200));

	// 3b. Prompt cache: with the subagent tool and its prompt section in place, the main agent's later model calls
	// in the turn read the cached prefix (system prompt + tools) instead of resending it.
	const sessionDir = join(USER_DATA, "chat-sessions");
	const usages = [];
	for (const file of existsSync(sessionDir) ? readdirSync(sessionDir, { recursive: true }).filter((name) => String(name).endsWith(".jsonl")) : []) {
		for (const line of readFileSync(join(sessionDir, String(file)), "utf8").split("\n")) {
			try {
				const entry = JSON.parse(line);
				const message = entry.message ?? entry;
				if (message?.role === "assistant" && message.usage !== undefined) usages.push(message.usage);
			} catch {
				// not a JSON line
			}
		}
	}
	console.log(`main agent usage per model call: ${JSON.stringify(usages.map((u) => ({ input: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite })))}`);
	check(
		"Main agent model calls after the first hit the prompt cache (cacheRead > 0)",
		usages.length >= 2 && usages.slice(1).some((u) => (u.cacheRead ?? 0) > 0),
		JSON.stringify(usages.map((u) => u.cacheRead ?? 0)),
	);

	// 4. Open the edited PDF to look at the result (the sidebar link navigated the editor's tab to the AI agent).
	await main.locator(".sidebar .sidebar__item", { hasText: "문서" }).click();
	await rowFor("review.pdf").waitFor({ timeout: 30_000 });
	await rowFor("review.pdf").click({ modifiers: ["Alt"] });
	await main.locator(`[data-document-editor="${REVIEW}"][data-editor-surface="pdf"] [data-pdf-thumb="2"]`).waitFor({ timeout: 15_000 });
	await sleep(1500);
	await shot("02-edited-pdf-page1");
} catch (error) {
	check("the lane ran to the end", false, error instanceof Error ? error.message.split("\n")[0] : String(error));
	for (const [index, page] of app.windows().entries()) await page.screenshot({ path: join(EVIDENCE, `failure-${index}.png`) }).catch(() => undefined);
} finally {
	await app.close().catch(() => undefined);
	service?.close();
	try {
		rmRetry(WORK);
	} catch {
		rmSync(WORK, { recursive: true, force: true });
	}
}

async function countImages(bytes) {
	const doc = await PDFDocument.load(bytes);
	return doc.context.enumerateIndirectObjects().filter(([, obj]) => obj instanceof PDFRawStream && obj.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")).length;
}

if (failures.length > 0) {
	console.error(`LIVE MAIN AGENT PDF SUBAGENT QA FAILED (${failures.length}): ${failures.join(", ")}`);
	process.exit(1);
}
console.log("ALL LIVE MAIN AGENT PDF SUBAGENT CHECKS PASSED");
