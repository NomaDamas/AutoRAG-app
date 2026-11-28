/**
 * Live end-to-end QA: the right-sidebar PDF agent can use everything the toolbar can, draws shapes
 * accurately at real text, and visually verifies its own work.
 *
 * One Korean instruction asks a real model to circle existing text, point an arrow at it, stick a memo,
 * stamp, add a Korean text box, insert a transparent PNG and add a Korean watermark, then check the result.
 * Verified by: the per-run tool trace in the main-process log (every new tool used, `pdf_render_page`
 * after the last edit), the PDF on disk (images + soft mask), and canvas pixels around the target text.
 *
 *   bun run qa script --host --skip-build scripts/manual-qa/run-qa-live-pdf-agent-parity.mjs
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PDFDocument, PDFName, PDFRawStream, rgb, StandardFonts } from "pdf-lib";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { rmRetry } from "./platform.mjs";

const REAL_API = "https://api.dazziapp.com";
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-pdf-agent-parity");
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

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-live-pdf-parity-"));
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

	const mainLog = join(EVIDENCE, "main.log");
	writeFileSync(mainLog, "");
	for (const stream of [app.process().stdout, app.process().stderr]) stream?.on("data", (chunk) => appendFileSync(mainLog, chunk));

	await main.locator(".sidebar .sidebar__item", { hasText: "문서" }).click();
	await rowFor("review.pdf").waitFor({ timeout: 30_000 });
	await rowFor("review.pdf").click({ modifiers: ["Alt"] });
	const pdfEditor = main.locator('[data-document-editor][data-editor-surface="pdf"]');
	await pdfEditor.waitFor({ timeout: 15_000 });
	await pdfEditor.locator('[data-pdf-thumb="2"]').waitFor({ timeout: 15_000 });
	const sidebar = main.locator(`[data-document-editor-sidebar="${REVIEW}"]`);
	const aiInput = sidebar.locator("textarea");
	await aiInput.waitFor({ timeout: 10_000 });
	await shot("01-review-pdf-opened");

	const before = readFileSync(REVIEW);
	await aiInput.fill(
		[
			`1페이지의 '${TARGET}' 문구를 빨간 타원으로 감싸고, 오른쪽 빈 공간에서 그 문구를 가리키는 빨간 화살표를 그려줘.`,
			"화살표 꼬리 근처 빈 공간에 분홍색 메모로 '주민번호 노출 — 삭제 필요'를 붙여줘.",
			"1페이지 오른쪽 위 여백에 '검토 완료' 도장을 찍고, 1페이지 아래쪽 빈 공간에 '검토자 의견: 3조 개인정보 조항 수정 요망'이라는 텍스트 상자를 넣어줘.",
			`그리고 ${LOGO} 이미지를 2페이지 오른쪽 아래에 넣고, 모든 페이지에 '대외비' 워터마크를 넣어줘.`,
			"기존 글자를 가리지 않게 배치하고, 다 하면 결과를 직접 눈으로 확인해줘.",
		].join(" "),
	);
	await main.keyboard.press("Enter");
	await sidebar.locator('[data-edit-state="running"]').waitFor({ timeout: 15_000 });
	await sidebar.locator('[data-edit-state="changed"], [data-edit-state="unchanged"], [data-edit-state="error"]').waitFor({ timeout: 420_000 });
	const state = await sidebar.locator("[data-edit-state]").last().getAttribute("data-edit-state");
	console.log(`agent reply:\n${await sidebar.locator("[data-edit-state]").last().innerText()}`);
	check("Agent turn changed the PDF", state === "changed" && !readFileSync(REVIEW).equals(before), state ?? "");

	// 1. Tool trace: every capability the toolbar has was reachable, and the agent looked at the result after editing.
	const traceLine = await poll(
		() => readFileSync(mainLog, "utf8").split("\n").find((line) => line.includes("[document-edit]") && line.includes(" pdf tools: ")) ?? "",
		(line) => line !== "",
		10_000,
	);
	console.log(`tool trace: ${traceLine}`);
	const tools = traceLine.split(" pdf tools: ")[1]?.split(", ").map((name) => name.trim()) ?? [];
	for (const name of ["pdf_find_text", "pdf_apply_ops", "pdf_add_note", "pdf_add_stamp", "pdf_add_text_box", "pdf_insert_image", "pdf_add_watermark", "pdf_render_page"]) {
		check(`Agent used ${name}`, tools.includes(name), tools.join(", "));
	}
	const editTools = new Set(["pdf_apply_ops", "pdf_add_note", "pdf_add_stamp", "pdf_add_text_box", "pdf_insert_image", "pdf_add_watermark"]);
	const lastEdit = tools.reduce((at, name, i) => (editTools.has(name) ? i : at), -1);
	check("Agent ran pdf_render_page after its last edit (Visual QA)", tools.lastIndexOf("pdf_render_page") > lastEdit, tools.join(", "));
	check("Agent located the text with pdf_find_text before drawing", tools.indexOf("pdf_find_text") > -1 && tools.indexOf("pdf_find_text") < tools.indexOf("pdf_apply_ops"));

	// 2. On disk: content images were embedded and the transparent logo kept its alpha (SMask).
	const doc = await PDFDocument.load(readFileSync(REVIEW));
	const images = doc.context.enumerateIndirectObjects().filter(([, obj]) => obj instanceof PDFRawStream && obj.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
	const masked = images.filter(([, obj]) => obj.dict.has(PDFName.of("SMask")));
	check("Note, stamp, text box, logo and watermark images are embedded", images.length >= 5, `images=${images.length}`);
	check("Transparent logo kept its alpha channel", masked.length >= 1, `smask=${masked.length}`);

	// 3. Accuracy: red ellipse pixels surround the real "Account SSN" text on page 1's canvas.
	const ring = await poll(
		() =>
			main.evaluate((box) => {
				const canvas = document.querySelector('[data-pdf-page-stage="1"] > canvas');
				if (!(canvas instanceof HTMLCanvasElement)) return null;
				const { width, height } = canvas;
				const data = canvas.getContext("2d").getImageData(0, 0, width, height).data;
				const isRed = (x, y) => {
					const p = (Math.round(y * height) * width + Math.round(x * width)) * 4;
					return data[p] > 170 && data[p + 1] < 110 && data[p + 2] < 110;
				};
				const scan = (x0, x1, y0, y1) => {
					let hits = 0;
					for (let y = y0; y <= y1; y += 1 / height) for (let x = x0; x <= x1; x += 2 / width) if (isRed(x, y)) hits += 1;
					return hits;
				};
				const cy0 = box.y - 0.004;
				const cy1 = box.y + box.height + 0.004;
				return {
					left: scan(Math.max(0, box.x - 0.06), box.x + 0.01, cy0, cy1),
					above: scan(box.x, box.x + box.width, Math.max(0, box.y - 0.04), box.y - 0.002),
					below: scan(box.x, box.x + box.width, box.y + box.height + 0.002, box.y + box.height + 0.04),
					inside: scan(box.x, box.x + box.width, box.y, box.y + box.height),
				};
			}, targetBox),
		(r) => r !== null && r.left > 0 && r.above > 0 && r.below > 0,
		20_000,
	);
	check("Red ellipse encloses the 'Account SSN' text (red found left, above and below it)", ring !== null && ring.left > 0 && ring.above > 0 && ring.below > 0, JSON.stringify(ring));
	check("Ellipse and arrow do not cross the 'Account SSN' text itself (no red inside its box)", ring !== null && ring.inside === 0, JSON.stringify(ring));
	await shot("02-agent-page1-result");
	await pdfEditor.locator('[data-pdf-thumb="2"]').click();
	await sleep(800);
	await shot("03-agent-page2-result");
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
	console.error(`LIVE PDF AGENT PARITY QA FAILED (${failures.length}): ${failures.join(", ")}`);
	process.exit(1);
}
console.log("ALL LIVE PDF AGENT PARITY CHECKS PASSED");
