import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AI_PANEL, finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";
import { seedSyntheticLog } from "./ltr-seed.mjs";
import { homeEnv } from "./platform.mjs";

/**
 * Live QA: learning to rank end to end in the real built app. Real MinSync index (dense + SPLADE), a real OpenRouter
 * reranker, the real hosted Jev judge, a real 2026 chat model, real AI Chat searches that fill the log, then Train now
 * and Use the trained model from Settings, and one more real search that the trained model reorders.
 *
 *   A. Real searches in AI Chat fill the ranking log: each answered search appends one record with the reranker's own
 *      rank and score, the exposure and the cited-or-not label. The page counts them.
 *   B. The log is topped up to a trainable size with runs of the same shape (a handful of real searches cannot reach
 *      100); this proves the path, not model quality, and the lane says so.
 *   C. Settings → Search Ranking → Train now fits in a child process; the window's event loop is never blocked.
 *   D. Use the trained model writes `ltr.enabled`; the next real search is served by it: the record carries
 *      `ltr.modelId`, and nothing was added or dropped from the candidates.
 *
 * Needs an OpenRouter key (QA_OPENROUTER_KEY, OPENROUTER_API_KEY or ~/.pi/agent/auth.json) and the dense embedding model
 * in the MinSync cache; without either it exits 2 and says why.
 *
 *   bun run build
 *   bun scripts/manual-qa/run-qa-live-ltr.mjs
 */

const EVIDENCE = process.env.QA_OUT ?? fileURLToPath(new URL("../../.omo/evidence/live-ltr/", import.meta.url));
mkdirSync(EVIDENCE, { recursive: true });
const fails = [];
const check = (name, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined || ok ? "" : ` — ${detail}`}`);
	if (!ok) fails.push(name);
};

const MODELS = process.env.FASTEMBED_CACHE_DIR ?? join(process.env.HOME ?? "", ".cache", "minsync", "models");
if (!existsSync(join(MODELS, "models--Qwen--Qwen3-Embedding-0.6B"))) {
	console.log(`SKIP: no dense embedding model in ${MODELS}`);
	process.exit(2);
}
function openRouterKey() {
	const fromEnv = process.env.QA_OPENROUTER_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim();
	if (fromEnv) return fromEnv;
	try {
		const entry = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8")).openrouter;
		return typeof entry?.access === "string" && entry.access.length > 0 ? entry.access : typeof entry?.key === "string" ? entry.key : null;
	} catch {
		return null;
	}
}
const KEY = openRouterKey();
if (KEY === null) {
	console.log("SKIP: no OpenRouter key (QA_OPENROUTER_KEY, OPENROUTER_API_KEY, or ~/.pi/agent/auth.json)");
	process.exit(2);
}
// Both are 2026 models (qwen3.7-flash 2026-07-28, listed by OpenRouter); the reranker is the one AutoRAG's own live e2e used.
const ANSWER_MODEL = process.env.QA_ANSWER_MODEL?.trim() || "qwen/qwen3.7-flash";
const RERANK_MODEL = process.env.QA_RERANK_MODEL?.trim() || "qwen/qwen3-reranker-8b";

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-live-ltr-"));
const HOME = join(WORK, "home");
const docs = join(WORK, "docs");
const memoryPath = join(WORK, "memory.json");
const configPath = join(WORK, "config.json");
for (const dir of [docs, join(WORK, "pi-agent"), join(HOME, ".cache", "minsync")]) mkdirSync(dir, { recursive: true });
if (process.platform !== "win32") symlinkSync(MODELS, join(HOME, ".cache", "minsync", "models"));

const FACTS = [
	["policy-refund", "Refund exceptions above 500 dollars require director approval before payout. The refund desk is open on weekdays."],
	["policy-travel", "Overseas travel requires the finance manager to approve the budget in advance. Hotels are capped at 200 dollars a night."],
	["policy-laptop", "A replacement laptop is issued after three years. IT stores the old laptop for thirty days before wiping it."],
	["policy-remote", "Remote work is allowed on Wednesdays and Fridays. Employees must be reachable on chat from nine to five."],
	["policy-security", "Security badges expire every twelve months. A lost badge must be reported to the front desk within one day."],
	["policy-onboarding", "New hires finish compliance training in their first two weeks. The buddy program pairs each hire with a mentor."],
	["policy-expense", "Expense reports are due on the fifth of each month. Receipts under 20 dollars do not need to be attached."],
	["policy-holiday", "The office closes for the last week of December. On-call engineers receive a day of leave in exchange."],
];
for (const [name, text] of FACTS) writeFileSync(join(docs, `${name}.md`), `# ${name}\n\n${text}\n`);
const QUESTIONS = [
	"Who has to approve a refund over 500 dollars?",
	"How much can a hotel cost per night when travelling overseas?",
	"How long does IT keep an old laptop before wiping it?",
	"On which weekdays is remote work allowed?",
	"How often do security badges expire?",
	"When are expense reports due each month?",
	"What is the hotel limit abroad?",
	"Where must a lost badge be reported?",
];
/** Synthetic runs added so the log can be trained on (the librarian needs 100 usable ones). */
const TOP_UP = 200;
/** Asked with serving on. Jev's router sends some plain factual questions down a no-retrieval route that has no baseline to reorder, so a few are tried. */
const FOLLOW_UPS = [
	"When does the office close at the end of the year?",
	"How long do new hires have to finish compliance training?",
	"Who pairs with a new hire in the buddy program?",
	"How much can an expense receipt be before it needs attaching?",
];

const modelBlock = { provider: "openrouter", id: ANSWER_MODEL, name: ANSWER_MODEL, api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", reasoning: false, input: ["text"] };
const config = {
	searchPaths: [docs],
	workspacePath: join(WORK, "workspace"),
	memoryPath,
	minSync: { enabled: true, autoInstall: false, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } },
	jikji: false,
	webSearch: { enabled: false },
	jev: { backend: "sllm" },
	rerank: { enabled: true, provider: "openrouter", model: RERANK_MODEL },
	model: modelBlock,
	queryDecomposition: false,
};
// Jev's hosted backend needs the Dazzi plan sign-in, so the small chat model decides instead: the lane needs only the key.
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
const readConfig = () => JSON.parse(readFileSync(configPath, "utf8"));

const env = {
	AUTORAG_HOME: join(WORK, "autorag-home"),
	...homeEnv(HOME),
	AUTORAG_CONFIG: configPath,
	PI_CODING_AGENT_DIR: join(WORK, "pi-agent"),
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	ELECTRON_RENDERER_URL: "",
	OPENROUTER_API_KEY: KEY,
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
	FASTEMBED_CACHE_DIR: MODELS,
};

const CLI = join(ROOT, "node_modules", "@autorag", "librarian", "dist", "cli", "index.js");
const librarian = (...args) => JSON.parse(execFileSync(process.execPath, [CLI, ...args, "--json"], { env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
/** The runs in the ranking log, read through SQLite exactly as the librarian stores them. */
const loggedRuns = () =>
	JSON.parse(
		execFileSync(
			process.execPath,
			[
				"-e",
				`const {DatabaseSync}=require("node:sqlite");const p=process.argv[1]+".ranking.db";const out=require("node:fs").existsSync(p)?new DatabaseSync(p).prepare("SELECT record FROM runs ORDER BY started_at").all().map(r=>JSON.parse(r.record)):[];console.log(JSON.stringify(out))`,
				memoryPath,
			],
			{ encoding: "utf8" },
		),
	);
const waitFor = async (predicate, timeoutMs = 20_000) => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await predicate();
		if (value) return value;
		if (Date.now() > deadline) return value;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
};

async function ask(page, question) {
	await page.locator(`${AI_PANEL} button[aria-label="New chat"]`).click();
	await page.fill('textarea[aria-label="Ask AI"]', question);
	await page.keyboard.press("Enter");
	const deadline = Date.now() + 300_000;
	await page.waitForTimeout(1500);
	const allowOnce = page.getByRole("button", { name: "Allow once", exact: true });
	for (;;) {
		const done = await page.evaluate(() => document.querySelector('button[aria-label="Stop"]') === null && document.querySelector(".user-msg") !== null);
		if (done) break;
		if (Date.now() > deadline) throw new Error(`the answer to "${question}" did not finish within 300s`);
		if (await allowOnce.isVisible().catch(() => false)) await allowOnce.click();
		await page.waitForTimeout(500);
	}
	const error = (await page.locator(".ai .text-danger-text").first().textContent({ timeout: 1000 }).catch(() => null)) ?? "";
	const proses = page.locator(".assistant-msg .assistant-prose");
	let answer = "";
	for (let index = 0; index < (await proses.count()); index += 1) answer += `${await proses.nth(index).innerText()}\n`;
	return { answer, error };
}

let app = null;
const pageErrors = [];
try {
	app = await launchFinder({ userDataDir: join(WORK, "user-data"), env, language: "en" });
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(30_000);
	page.on("pageerror", (error) => pageErrors.push(String(error)));
	await page.waitForSelector(".sidebar__item", { timeout: 30_000 });

	const built = await page.evaluate(() => window.autorag.settings.configRefresh());
	check("the dense + SPLADE index builds", built.ok === true, JSON.stringify({ ok: built.ok, error: built.error }));

	// ── A. real searches fill the log ────────────────────────────────────────────────────────────
	await openAiSearch(page);
	let answered = 0;
	for (const question of QUESTIONS) {
		const { answer, error } = await ask(page, question);
		if (error === "" && answer.trim().length > 0) answered += 1;
		else console.log(`INFO "${question}" -> error="${error}" answer="${answer.slice(0, 80)}"`);
	}
	await page.screenshot({ path: join(EVIDENCE, "01-searches.png") });
	check("every real search was answered without an error", answered === QUESTIONS.length, `${answered}/${QUESTIONS.length}`);
	const real = await waitFor(() => (loggedRuns().length >= QUESTIONS.length ? loggedRuns() : null), 60_000);
	check("each answered search appended one record to the ranking log", Array.isArray(real) && real.length === QUESTIONS.length, `${real?.length ?? 0} records`);
	let reranked = [];
	if (Array.isArray(real)) {
		// Jev's router sends some plain factual questions down the `extra` route (no retrieval, no baseline, so nothing
		// is reranked). That is the router's call; those runs are logged and training skips them.
		reranked = real.filter((run) => run.reranker !== undefined);
		const skipped = real.length - reranked.length;
		console.log(`INFO ${reranked.length}/${real.length} real searches were routed through retrieval and reranked; ${skipped} took the no-retrieval route and are skipped by training`);
		check("most real searches went through retrieval and the reranker", reranked.length >= Math.ceil(QUESTIONS.length / 2), `${reranked.length}/${real.length}`);
		check("every reranked record names the real reranker", reranked.every((run) => run.reranker?.model === RERANK_MODEL), JSON.stringify(reranked.map((run) => run.reranker)));
		check("…and carries the reranker's own rank and score on its candidates", reranked.every((run) => run.candidates.length > 0 && run.candidates.some((c) => c.rerank !== undefined)));
		check("a search that skipped retrieval has no reranker and no rerank ranks, as the page says", real.filter((run) => run.reranker === undefined).every((run) => run.candidates.every((c) => c.rerank === undefined)));
		check("every record carries exposures and a cited-or-not label", real.every((run) => run.candidates.every((c) => typeof c.labels.citedFinal === "boolean")));
		check("at least one reranked search cited a candidate (otherwise the log has no signal)", reranked.some((run) => run.candidates.some((c) => c.labels.citedFinal)));
		check("no record carries chunk text", real.every((run) => run.candidates.every((c) => !("content" in c) && !("excerpt" in c) && Object.values(c.text).every((value) => typeof value === "number"))));
	}

	// ── B. top up the log to a trainable size ────────────────────────────────────────────────────
	// A handful of real searches cannot reach the librarian's 100-run minimum, and replaying them teaches a model nothing:
	// on this tiny corpus the reranker already puts the cited chunk first every time, so no model can beat it (the gate
	// rightly rejects it). The top-up is therefore synthetic runs with a planted signal, written after the real ones so the
	// real runs are in the training part. What this proves is the path from a real log, through Train now and Use the
	// trained model, to a real search that is reordered. It proves nothing about how a model does on real searches.
	seedSyntheticLog({ memoryPath, count: TOP_UP, idPrefix: "synthetic", startedAt: Math.max(...loggedRuns().map((run) => run.startedAt)) + 60_000 });
	console.log(`INFO the log was topped up with ${TOP_UP} synthetic runs (planted signal) after the ${loggedRuns().length - TOP_UP} real ones: this proves the path, not model quality`);

	// ── C. Settings → Search Ranking → Train now ─────────────────────────────────────────────────
	await page.locator(".sidebar__item--settings").click();
	await page.waitForSelector(".settings-panel");
	await page.locator(".settings-nav-item", { hasText: "Search Ranking" }).first().click();
	await page.locator(".settings-ltr").waitFor();
	const body = () => page.locator(".settings-ltr").innerText();
	await page.reload();
	await page.waitForSelector(".sidebar__item");
	await page.locator(".sidebar__item--settings").click();
	await page.locator(".settings-nav-item", { hasText: "Search Ranking" }).first().click();
	await page.locator(".settings-ltr").waitFor();
	const count = await waitFor(async () => /searches logged/u.test(await body()));
	const expectedCount = QUESTIONS.length + TOP_UP;
	check("the page counts the real log", count === true && new RegExp(`${expectedCount} searches logged`, "u").test(await body()), (await body()).slice(0, 200));
	check("the reranker is on, so there is no warning", !/Search result ordering is off/u.test(await body()));
	await page.screenshot({ path: join(EVIDENCE, "02-ready.png") });

	await page.getByRole("button", { name: "Train now" }).click();
	const lag = await page.evaluate(
		() =>
			new Promise((resolve) => {
				let worst = 0;
				let last = performance.now();
				const timer = setInterval(() => {
					const now = performance.now();
					worst = Math.max(worst, now - last - 20);
					last = now;
				}, 20);
				setTimeout(() => {
					clearInterval(timer);
					resolve(worst);
				}, 2000);
			}),
	);
	check("the window is never blocked while the model trains", lag < 250, `worst stall ${Math.round(lag)} ms`);
	const verdict = await waitFor(async () => /Training finished|did not pass|not enough data|Training failed/u.test(await body()), 240_000);
	await page.screenshot({ path: join(EVIDENCE, "03-trained.png") });
	check("training ends with a verdict on the page", verdict === true, (await body()).slice(0, 400));
	const status = librarian("ltr", "status");
	check("the librarian has stored a model", status.models.length >= 1, JSON.stringify(status.models.map((m) => m.id)));
	const passed = status.models[0]?.passedGate === true;
	console.log(`INFO verdict: ${passed ? "passed" : "not passed"}; holdout ${JSON.stringify(status.models[0]?.holdout)}`);

	// ── D. serve it on the next real search ──────────────────────────────────────────────────────
	if (!passed) {
		console.log("INFO the model did not pass its gate on this (small, replayed) log, so it must not serve; checking that");
		await page.locator('.settings-ltr [aria-label="Use the trained model"]').click();
		await waitFor(() => readConfig().ltr?.enabled === true);
		check("with no passing model, turning serving on leaves the order unchanged and says so", (await waitFor(async () => /no model has passed yet/u.test(await body()))) === true, (await body()).slice(0, 300));
		const before = loggedRuns().length;
		await page.getByRole("button", { name: "Back to app" }).click();
		await openAiSearch(page);
		const { error } = await ask(page, FOLLOW_UPS[0]);
		check("a search with serving on and no passing model still answers", error === "", error);
		const after = await waitFor(() => (loggedRuns().length > before ? loggedRuns() : null), 60_000);
		check("…and its record names no LTR model", Array.isArray(after) && after.at(-1)?.ltr === undefined, JSON.stringify(after?.at(-1)?.ltr));
	} else {
		await page.locator('.settings-ltr [aria-label="Use the trained model"]').click();
		check("turning serving on writes ltr.enabled", (await waitFor(() => readConfig().ltr?.enabled === true)) === true, JSON.stringify(readConfig().ltr));
		check("the page names the model that serves", (await waitFor(async () => /Adjusting the order with model xgb-/u.test(await body()))) === true, (await body()).slice(0, 300));
		await page.screenshot({ path: join(EVIDENCE, "04-serving.png") });
		await page.getByRole("button", { name: "Back to app" }).click();
		await openAiSearch(page);
		let served;
		const tried = [];
		for (const question of FOLLOW_UPS) {
			const { answer, error } = await ask(page, question);
			check(`a real search with the model serving answers without an error (${question.slice(0, 40)}…)`, error === "" && answer.trim().length > 0, error || answer.slice(0, 100));
			// The record is found by its question, not by position: the synthetic top-up runs sit later in time than this search.
			const record = await waitFor(() => loggedRuns().find((run) => run.question === question), 60_000);
			tried.push(`${question.slice(0, 30)}…: ${record === undefined ? "no record" : record.reranker === undefined ? "no-retrieval route" : "retrieval"}`);
			if (record !== undefined && record.reranker !== undefined) {
				served = record;
				break;
			}
		}
		console.log(`INFO ${tried.join(" | ")}`);
		check("at least one follow-up question was routed through retrieval, so there was a baseline to reorder", served !== undefined, tried.join(" | "));
		check("its record says which model reordered what the model read", served?.ltr?.modelId === status.models[0].id, JSON.stringify(served?.ltr));
		check("the record still holds the reranker's own rank for every candidate that was ranked", served !== undefined && served.candidates.some((c) => c.rerank !== undefined) && served.candidates.every((c) => c.rerank !== undefined || c.exposures.length === 0 || c.observations.length > 0));
		check("serving added and dropped no candidates: everything exposed was ranked by the reranker", served !== undefined && served.candidates.filter((c) => c.exposures.some((e) => e.surface === "baseline")).every((c) => c.rerank !== undefined));
		await page.screenshot({ path: join(EVIDENCE, "05-served-search.png") });
	}
	check("no renderer page error", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
} catch (error) {
	check("run completed", false, String(error?.stack ?? error).slice(0, 900));
	const page = app === null ? null : await finderWindow(app, 2000).catch(() => null);
	await page?.screenshot({ path: join(EVIDENCE, "failure.png") }).catch(() => undefined);
} finally {
	await app?.close().catch(() => undefined);
	console.log(`RESULT ${fails.length === 0 ? "ALL PASS" : `${fails.length} FAILURES: ${fails.join(" | ")}`}`);
	rmSync(WORK, { recursive: true, force: true });
	process.exitCode = fails.length === 0 ? 0 : 1;
}
