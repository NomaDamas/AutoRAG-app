/**
 * Live end-to-end QA: Quick Look mark-up-and-edit with a real 2026+ LLM
 * (`deepseek/deepseek-v4.1-flash`, created 2026-09-10) through the Dazzi account.
 *
 * Drives what a person does: select a file in the Finder, press Space, press the
 * pen button at the top right of the Quick Look window, draw on the document,
 * type an instruction, press Enter. The real `document-edit` pi profile edits the
 * file in place; the lane checks the bytes on disk, that the preview re-renders
 * the new content, and that Undo puts the original bytes back.
 *
 *   1. `plan.md` (text mode): underline a date, ask to move it.
 *   2. `budget.docx` (package mode, macOS: built with `textutil`): box the budget
 *      line, ask to change the amount; the result must still be a valid .docx.
 *
 *   bun run qa script --vm scripts/manual-qa/run-qa-live-quick-look-markup.mjs --token "$TOKEN"
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createFinderPreview, finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { isMac, rmRetry } from "./platform.mjs";

const REAL_API = "https://api.dazziapp.com";
const MODEL_ID = process.env.QA_LIVE_MODEL?.trim() || "deepseek/deepseek-v4.1-flash";
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-quick-look-markup");
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

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-live-markup-"));
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
const PLAN_TEXT = ["# 출시 계획", "", "출시일: 2026년 11월 15일", "", "담당: 김민수", "", "체크리스트는 금요일까지 공유합니다.", ""].join("\n");
writeFileSync(PLAN, PLAN_TEXT, "utf8");

const BUDGET = join(DOCS_DIR, "budget.docx");
if (isMac) {
	const html = join(WORK, "budget.html");
	writeFileSync(html, '<html><body><h1>분기 예산</h1><p>예산: 300만 원</p><p>승인: 박지영</p></body></html>', "utf8");
	execFileSync("textutil", ["-inputencoding", "UTF-8", "-convert", "docx", "-output", BUDGET, html]);
}
const docxText = (path) => execFileSync("textutil", ["-convert", "txt", "-stdout", path], { encoding: "utf8" });

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
	// Sign-in may rewrite the config; keep the lane's model.
	const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
	cfg.model = model;
	writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`);
	console.log(`live model: ${MODEL_ID}`);

	const finderPreview = createFinderPreview(app, main);
	const preview = await poll(() => finderPreview.page().catch(() => undefined), (page) => page !== undefined, 30_000);
	if (preview === undefined) throw new Error("the Finder Quick Look window did not pre-warm");
	preview.setDefaultTimeout(60_000);
	const shot = async (name) => {
		await sleep(300);
		await preview.screenshot({ path: join(EVIDENCE, `${name}.png`) });
	};
	const visible = async () => (await finderPreview.state())?.visible ?? false;
	const progress = [];
	await preview.exposeFunction("__qaEditProgress", (text) => progress.push(text));
	await preview.evaluate(() => window.quickLook.onEditEvent((event) => event.type === "progress" && window.__qaEditProgress(event.text)));

	await main.locator(".sidebar .sidebar__item", { hasText: "문서" }).click();
	async function open(name) {
		const row = main
			.locator('[role="row"]')
			.filter({ has: main.locator(".row__label", { hasText: new RegExp(`^${name.replace(/\./g, "\\.")}$`) }) })
			.first();
		await row.waitFor({ timeout: 30_000 });
		await row.click();
		await main.keyboard.press("Space");
		if ((await poll(visible, Boolean, 15_000)) !== true) {
			await main.keyboard.press("Space");
			await poll(visible, Boolean, 10_000);
		}
		await preview.locator(".qlw__name", { hasText: name }).waitFor();
		await sleep(600);
	}
	async function close() {
		await main.keyboard.press("Space");
		await poll(async () => (await visible()) === false, Boolean, 8000);
	}
	async function drag(from, to) {
		await preview.mouse.move(from.x, from.y);
		await preview.mouse.down();
		for (let step = 1; step <= 8; step += 1) {
			await preview.mouse.move(from.x + ((to.x - from.x) * step) / 8, from.y + ((to.y - from.y) * step) / 8);
		}
		await preview.mouse.up();
	}
	async function instruct(text) {
		const field = preview.locator(".ql-markup__composer textarea");
		await field.click();
		await preview.keyboard.type(text);
		await preview.keyboard.press("Enter");
		await preview.locator("[data-edit-state=running]").waitFor({ timeout: 10_000 });
		await shot(`${text.slice(0, 6)}-running`);
		await preview.locator("[data-edit-state=changed], [data-edit-state=unchanged], [data-edit-state=error]").waitFor({ timeout: 300_000 });
		return preview.locator("[data-edit-state]").first();
	}

	// 1. Markdown: underline the date and ask to move it.
	await open("plan.md");
	const pen = preview.locator('button[aria-label="표시하고 편집"]');
	check("The pen button sits in the Quick Look toolbar for plan.md", (await pen.count()) === 1);
	await shot("01-plan-preview");
	const windowHeight = () => preview.evaluate(() => window.innerHeight);
	const shortHeight = await windowHeight();
	await pen.click();
	await preview.locator("svg.ql-markup").waitFor();
	const grown = await poll(windowHeight, (height) => height >= Math.max(shortHeight, 460), 5000);
	check("Markup opens in a window at least 460px tall (a taller one keeps its size)", grown >= 460 && grown >= shortHeight, `${shortHeight} -> ${grown}`);
	await preview.locator('button[aria-label="밑줄"]').click();
	const date = await preview.getByText("2026년 11월 15일").first().boundingBox();
	if (date === null) throw new Error("the date line is not on screen");
	await drag({ x: date.x + 2, y: date.y + date.height + 3 }, { x: date.x + date.width - 2, y: date.y + date.height + 3 });
	check("The underline stays on the page as a mark", (await preview.locator("[data-mark=underline]").count()) === 1);
	await shot("02-plan-underlined");

	let state = await instruct("밑줄 친 날짜를 2026년 11월 20일로 바꿔줘");
	await shot("03-plan-edited");
	const planAfter = readFileSync(PLAN, "utf8");
	console.log(`plan.md after edit:\n${planAfter}`);
	console.log(`progress: ${JSON.stringify(progress)}`);
	check("The agent reports a change", (await state.getAttribute("data-edit-state")) === "changed", await state.innerText());
	check(
		"plan.md on disk has the new date and keeps the other lines",
		planAfter.includes("11월 20일") && !planAfter.includes("11월 15일") && planAfter.includes("담당: 김민수") && planAfter.includes("체크리스트는 금요일까지 공유합니다."),
		planAfter,
	);
	check("`i` progress streamed while editing", progress.length >= 1, JSON.stringify(progress));
	const reloaded = await poll(() => preview.getByText("11월 20일").count(), (count) => count > 0, 15_000);
	check("Quick Look re-rendered the edited document", reloaded > 0);

	await preview.locator("button", { hasText: "편집 되돌리기" }).click();
	await preview.locator("[data-edit-state=undone]").waitFor({ timeout: 15_000 });
	check("Undo restores the original bytes", readFileSync(PLAN, "utf8") === PLAN_TEXT, readFileSync(PLAN, "utf8"));
	const restored = await poll(() => preview.getByText("11월 15일").count(), (count) => count > 0, 15_000);
	check("Quick Look shows the original again after Undo", restored > 0);
	await shot("04-plan-undone");
	await preview.locator(".ql-markup__composer button", { hasText: "닫기" }).click();
	const restoredHeight = await poll(windowHeight, (height) => height === shortHeight, 5000);
	check("Closing markup gives the window its earlier size back", restoredHeight === shortHeight && (await preview.locator("svg.ql-markup").count()) === 0, `${shortHeight} -> ${grown} -> ${restoredHeight}`);
	await close();

	// 2. Word: box the budget line and ask to change the amount.
	if (isMac) {
		progress.length = 0;
		await open("budget.docx");
		// The Word viewer renders into a sandboxed iframe.
		const word = preview.frameLocator("iframe.ql__frame");
		await poll(() => word.getByText("300만").count(), (count) => count > 0, 30_000);
		await shot("05-budget-preview");
		await preview.locator('button[aria-label="표시하고 편집"]').click();
		await preview.locator("svg.ql-markup").waitFor();
		await preview.locator('button[aria-label="네모"]').click();
		const line = await word.getByText("300만").first().boundingBox();
		if (line === null) throw new Error("the budget line is not on screen");
		await drag({ x: line.x - 8, y: line.y - 6 }, { x: line.x + line.width + 8, y: line.y + line.height + 6 });
		check("The box stays on the page as a mark", (await preview.locator("[data-mark=box]").count()) === 1);
		await shot("06-budget-boxed");
		state = await instruct("네모 친 예산 금액을 450만 원으로 바꿔줘");
		await shot("07-budget-edited");
		const text = docxText(BUDGET);
		console.log(`budget.docx after edit:\n${text}`);
		check("The agent reports a change to the .docx", (await state.getAttribute("data-edit-state")) === "changed", await state.innerText());
		check("budget.docx is still a Word document with the new amount and the other paragraphs", text.includes("450만") && !text.includes("300만") && text.includes("승인: 박지영") && text.includes("분기 예산"), text);
		const shown = await poll(() => word.getByText("450만").count(), (count) => count > 0, 30_000);
		check("Quick Look re-rendered the edited .docx", shown > 0);
		await shot("08-budget-reloaded");
	}
} catch (error) {
	check("the lane ran to the end", false, error instanceof Error ? `${error.message.split("\n")[0]} @ ${(error.stack ?? "").split("\n").find((line) => line.includes("run-qa-live-quick-look-markup")) ?? ""}` : String(error));
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
console.log("ALL LIVE QUICK LOOK MARKUP CHECKS PASSED");
