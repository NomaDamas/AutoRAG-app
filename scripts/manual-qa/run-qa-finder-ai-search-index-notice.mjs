/**
 * Manual QA — AI Search warns when the index it is about to search is not ready, in the real app.
 *
 * A question that takes the local track (the librarian searches the person's own index) over an index that is
 * empty, small, or still being built shows a warning under the question, with a button to Settings → Indexing. A
 * question over a healthy index shows nothing. The model is a scripted loopback endpoint and Jev is off, so every
 * question takes the local track; the index states are made the way a person makes them (documents in a folder,
 * Settings' own refresh), and the counts the warning quotes are checked against the ones Settings → Indexing shows.
 *
 *   bun run build
 *   bun run qa script scripts/manual-qa/run-qa-finder-ai-search-index-notice.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { AI_PANEL, finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";
import { homeEnv, rmRetry, writeMinsyncStub } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/qa-ai-search-index-notice");
mkdirSync(EVIDENCE, { recursive: true });
const LOG = join(EVIDENCE, "run.log");
writeFileSync(LOG, "");
const log = (line) => {
	console.log(line);
	writeFileSync(LOG, `${line}\n`, { flag: "a" });
};
const failures = [];
const check = (label, ok, detail) => {
	log(`${ok ? "PASS" : "FAIL"} ${label}${ok || detail === undefined ? "" : ` — ${detail}`}`);
	if (!ok) failures.push(label);
};

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-index-notice-"));
const AUTORAG_HOME = join(WORK, "autorag-home");
const BIN = join(AUTORAG_HOME, "bin");
const AGENT_DIR = join(WORK, "pi-agent");
const CONFIG = join(WORK, "config.json");
const DOCS = join(WORK, "docs");
const USER_DATA = join(WORK, "user-data");
mkdirSync(DOCS, { recursive: true });
mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });
mkdirSync(join(WORK, "home"), { recursive: true });
writeMinsyncStub(BIN);

const addDocs = (from, to) => {
	for (let n = from; n <= to; n += 1) writeFileSync(join(DOCS, `note-${n}.txt`), `Note ${n}: the quarterly figure is ${n * 7}.\n`);
};

// ── The scripted model: an OpenAI-compatible chat-completions endpoint on loopback. ──
const ANSWER = "The notes carry a quarterly figure.";
const frame = (delta, finish) =>
	`data: ${JSON.stringify({ id: "chatcmpl-qa", object: "chat.completion.chunk", created: 0, model: "qa-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const server = createServer((req, res) => {
	req.resume();
	req.on("end", () => {
		if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/v1/chat/completions") {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		res.write(frame({ role: "assistant", content: ANSWER }, null));
		res.write(frame({}, "stop"));
		res.write(`data: ${JSON.stringify({ id: "chatcmpl-qa", object: "chat.completion.chunk", created: 0, model: "qa-model", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const MODEL_URL = `http://127.0.0.1:${server.address().port}`;

writeFileSync(
	CONFIG,
	`${JSON.stringify(
		{
			searchPaths: [DOCS],
			workspacePath: join(WORK, "workspace"),
			memoryPath: join(WORK, "memory.json"),
			minSync: { enabled: true, autoInstall: false, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } },
			jikji: false,
			jev: false,
			webSearch: false,
			queryDecomposition: false,
			model: { provider: "qa", id: "qa-model", name: "QA", baseUrl: `${MODEL_URL}/v1`, api: "openai-completions", apiKeyEnv: "QA_API_KEY", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 },
		},
		null,
		2,
	)}\n`,
);

let app;
let swept = false;
const sweep = (patient) => {
	if (swept) return;
	swept = true;
	app?.close().catch(() => undefined);
	server.close();
	try {
		if (patient === true) rmRetry(WORK);
		else rmSync(WORK, { recursive: true, force: true });
	} catch (error) {
		log(`cleanup: ${WORK} stayed behind (${error.code ?? error.message})`);
	}
};
process.on("exit", () => sweep(false));

const APP_ENV = {
	AUTORAG_HOME,
	...homeEnv(join(WORK, "home")),
	AUTORAG_CONFIG: CONFIG,
	PI_CODING_AGENT_DIR: AGENT_DIR,
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	ELECTRON_RENDERER_URL: "",
	QA_API_KEY: "qa-key",
	PATH: `${BIN}${delimiter}${process.env.PATH ?? ""}`,
	OPENROUTER_API_KEY: "",
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
	AUTORAG_PERMISSION_MODE: "",
	// No on-device embedding model in this profile, in a VM (where the runner copies the host's cache into the home) or on the host.
	FASTEMBED_CACHE_DIR: join(WORK, "model-cache"),
};

let page;
let panel;
let composer;
/** The panel's own labels per interface language (the shared helpers look for the English ones). */
const LABELS = {
	en: { sidebar: "AI Search", panel: "AI Search", ask: "Ask Dazzi", stop: "Stop", newChat: "New chat" },
	ko: { sidebar: "AI 검색", panel: "AI 검색", ask: "Dazzi에게 물어보기", stop: "중지", newChat: "새 대화" },
};
let labels = LABELS.en;
const start = async (language) => {
	labels = LABELS[language];
	app = await launchFinder({ userDataDir: join(USER_DATA, language), env: APP_ENV, language });
	page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(20_000);
	page.on("pageerror", (error) => log(`[pageerror] ${String(error).slice(0, 300)}`));
	await page.waitForSelector(".sidebar__item", { timeout: 30_000 });
	await page.locator(".sidebar__item", { hasText: labels.sidebar }).click();
	panel = page.locator(`section[aria-label="${labels.panel}"]:not([aria-hidden="true"])`);
	composer = panel.locator(`textarea[aria-label="${labels.ask}"]`);
	await composer.waitFor({ timeout: 30_000 });
};
const stop = async () => {
	await app.close();
	app = undefined;
};
const shot = async (name) => {
	await page.waitForTimeout(450);
	await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
};
const finished = () =>
	page.waitForFunction(
		({ ask, stopLabel }) => document.querySelector(`input[aria-label="${ask}"]`) !== null && document.querySelector(`button[aria-label="${stopLabel}"]`) === null,
		{ ask: labels.ask, stopLabel: labels.stop },
		{ timeout: 60_000 },
	);
const ask = async (text) => {
	await composer.click();
	await page.keyboard.type(text);
	await page.keyboard.press("Enter");
	await finished();
};
const newChat = () => panel.locator(`button[aria-label="${labels.newChat}"]`).click();
/** The warning boxes the panel shows (the panel has no other `status` region that talks about the index). */
const notices = () => panel.locator('[role="status"]', { hasText: /index|インデックス|索引|인덱싱/iu });
const indexedCount = async () => (await page.evaluate(() => window.autorag.settings.sourcesList())).local.documentCount;

// ── 0. The Korean interface, empty index: the layout and the words in a second language. ──
await start("ko");
log("app ready (ko)");
await ask("note 파일에 분기 수치가 있나요?");
await notices().first().waitFor();
const ko = await notices().first().innerText();
check("Korean: the warning says nothing is indexed", /인덱싱된 문서가 없어/.test(ko), ko.replace(/\s+/g, " "));
check("Korean: the warning carries the button", (await notices().first().getByRole("button", { name: "인덱싱 관리" }).count()) === 1);
await shot("00-ko-empty-index");
await stop();

// ── 1. English, empty index: the warning, the answer, and the way to Settings → Indexing. ──
await start("en");
log("app ready (en)");
await ask("do the notes have a quarterly figure?");
await notices().first().waitFor();
const empty = await notices().first().innerText();
check("an empty index is named", /No documents are indexed/.test(empty), empty.replace(/\s+/g, " "));
check("the question was still answered", (await panel.getByText(ANSWER).count()) > 0);
check("the warning offers exactly one button, Manage indexing", (await notices().first().getByRole("button").count()) === 1 && (await notices().first().getByRole("button", { name: "Manage indexing" }).count()) === 1);
check("one warning per run", (await notices().count()) === 1);
await shot("01-empty-index");

await notices().first().getByRole("button", { name: "Manage indexing" }).click();
await page.waitForSelector(".settings-view", { timeout: 20_000 });
const active = await page.locator(".settings-nav-item.is-active").first().innerText();
check("the button opens Settings on the Indexing page", /Indexing/.test(active), active.replace(/\s+/g, " "));
const indexingPage = page.getByText("Check that your search folders and connected apps are up to date").first();
await indexingPage.waitFor();
check("the Indexing page is the one showing", await indexingPage.isVisible());
await shot("02-settings-indexing");
check("the AI Search tab keeps the warning while Settings is open", (await page.locator('section[aria-label="AI Search"]', { hasText: "No documents are indexed" }).count()) === 1);

// ── 2. A run that stopped: Settings' own refresh needs the on-device model, which this profile does not have. ──
addDocs(1, 3);
await page.evaluate(() => window.autorag.settings.configRefresh());
const problem = await page.evaluate(() => window.autorag.indexProblem.get());
check("the app recorded the stopped run", problem.failure !== null, JSON.stringify(problem));
await openAiSearch(page);
panel = page.locator(AI_PANEL);
composer = panel.locator('textarea[aria-label="Ask Dazzi"]');
await newChat();
await ask("do the notes have a quarterly figure?");
await notices().first().waitFor();
const failed = await notices().first().innerText();
check("a stopped run is named", /The last indexing run stopped before it finished/.test(failed), failed.replace(/\s+/g, " "));
await shot("03-stopped-run");

// ── 3. A small index: the warning quotes the count Settings → Indexing shows. ──
await page.evaluate(() => window.autorag.settings.configRefresh(["parsed"]));
const small = await indexedCount();
check("Settings' own refresh indexed the three documents", small === 3, `local.documentCount=${small}`);
check("a refresh that finished clears the stopped run", (await page.evaluate(() => window.autorag.indexProblem.get())).failure === null);
await newChat();
await ask("do the notes have a quarterly figure?");
await notices().first().waitFor();
const few = await notices().first().innerText();
check("a small index quotes how many documents it holds", /Only 3 documents are indexed/.test(few), few.replace(/\s+/g, " "));
await shot("04-small-index");

// ── 4. An index with enough in it: no warning. ──
addDocs(4, 15);
await page.evaluate(() => window.autorag.settings.configRefresh(["parsed"]));
const enough = await indexedCount();
check("the refresh indexed all fifteen documents", enough === 15, `local.documentCount=${enough}`);
await newChat();
await ask("do the notes have a quarterly figure?");
check("a ready index shows no warning", (await notices().count()) === 0, (await notices().allInnerTexts()).join(" | "));
check("and the question was answered", (await panel.getByText(ANSWER).count()) > 0);
await shot("05-ready-index");

// ── 5. A run in progress (here `autorag watch` in another process): the warning says indexing is not finished, whatever the index holds. ──
const progressFile = join(WORK, "workspace", ".autorag", "refresh-progress.json");
mkdirSync(join(WORK, "workspace", ".autorag"), { recursive: true });
const startedAt = new Date().toISOString();
writeFileSync(progressFile, JSON.stringify({ state: "running", phase: "minsync", pid: process.pid, startedAt }));
await page.waitForFunction(async () => (await window.autorag.indexActivity.get()).state === "running", null, { timeout: 30_000 });
check("the app sees the other process indexing", (await page.evaluate(() => window.autorag.indexActivity.get())).state === "running");
await newChat();
await ask("do the notes have a quarterly figure?");
await notices().first().waitFor();
const running = await notices().first().innerText();
check("a run in progress is named, although fifteen documents are already indexed", /Indexing isn't finished yet/.test(running), running.replace(/\s+/g, " "));
await shot("06-indexing-in-progress");

// ── 6. The run ends: no warning. ──
writeFileSync(progressFile, JSON.stringify({ state: "success", phase: "finalizing", pid: process.pid, startedAt, finishedAt: new Date().toISOString() }));
await page.waitForFunction(async () => (await window.autorag.indexActivity.get()).state !== "running", null, { timeout: 30_000 });
await newChat();
await ask("do the notes have a quarterly figure?");
check("once the run is over the warning is gone", (await notices().count()) === 0, (await notices().allInnerTexts()).join(" | "));

log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
await app?.close().catch(() => undefined);
sweep(true);
process.exitCode = failures.length === 0 ? 0 : 1;
