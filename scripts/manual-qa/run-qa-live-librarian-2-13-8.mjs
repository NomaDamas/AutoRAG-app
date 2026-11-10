/**
 * Live QA — the app on librarian 2.13.8, on the real built app with a real index and a real model.
 *
 * Librarian 2.13.8 gives the AI Search agent an exact `calculator` tool and turns the record cut on by default, so
 * one long document cannot take every slot of a search. This lane checks, end to end through the app:
 *
 *   - a date question asked in AI Search is answered through the `calculator` tool, with the exact day count;
 *   - with the record cut on (the default), the agent's first local search shows the model several documents,
 *     not only the long one that matches everywhere; with `limits.recordCut.enabled: false` it shows fewer;
 *   - the app's config writes keep a `limits.recordCut` block the librarian accepts.
 *
 * The model is a real OpenRouter model released in 2026, reached through a loopback proxy that records, and never
 * alters, what passes. The key comes from QA_OPENROUTER_KEY, else OPENROUTER_API_KEY, else the `openrouter` entry of
 * ~/.pi/agent/auth.json. Pick another model from https://openrouter.ai/api/v1/models, never from memory: QA_ANSWER_MODEL.
 *
 *   bun run build
 *   bun scripts/manual-qa/run-qa-live-librarian-2-13-8.mjs
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";
import { homeEnv } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-librarian-2-13-8");
mkdirSync(EVIDENCE, { recursive: true });
const LOG = join(EVIDENCE, "run.log");
writeFileSync(LOG, "");
const log = (line) => {
	console.log(line);
	appendFileSync(LOG, `${line}\n`);
};
const failures = [];
const check = (label, ok, detail) => {
	log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` — ${detail}`}`);
	if (!ok) failures.push(label);
};

const ANSWER_MODEL = process.env.QA_ANSWER_MODEL?.trim() || "z-ai/glm-5.3-flash";
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
	console.error("An OpenRouter key is required: set QA_OPENROUTER_KEY or OPENROUTER_API_KEY.");
	process.exit(2);
}
const MODELS = process.env.FASTEMBED_CACHE_DIR ?? join(process.env.HOME ?? "", ".cache", "minsync", "models");
if (!existsSync(MODELS)) {
	console.log(`SKIP: no on-device sparse model cache at ${MODELS}; real indexing cannot run`);
	process.exit(2);
}

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-2138-"));
const CONFIG = join(WORK, "config.json");
const DOCS = join(WORK, "docs");
const WORKSPACE = join(WORK, "workspace");
for (const dir of [DOCS, WORKSPACE, join(WORK, "pi-agent"), join(WORK, "home", ".cache", "minsync")]) mkdirSync(dir, { recursive: true });
if (process.platform !== "win32") symlinkSync(MODELS, join(WORK, "home", ".cache", "minsync", "models"));

// One long manual whose every section talks about the topic, and six short notes that each mention it once.
const TOPIC = "glacierbolt";
const LONG = "glacierbolt-manual.md";
const sections = Array.from({ length: 60 }, (_, i) =>
	[`## Section ${i + 1}: ${TOPIC} maintenance step ${i + 1}`, "", `${TOPIC} pump ${i + 1} needs its valve checked, the ${TOPIC} seal replaced, and the ${TOPIC} log signed. `.repeat(12), ""].join("\n"),
);
writeFileSync(join(DOCS, LONG), `# ${TOPIC} field manual\n\n${sections.join("\n")}`);
const SHORT = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"].map((name) => `${name}-note.md`);
SHORT.forEach((name, i) => writeFileSync(join(DOCS, name), `# ${name}\n\nOn site ${i + 1} the ${TOPIC} pump was inspected by team ${i + 1}; owner code ${name.slice(0, 1).toUpperCase()}${i + 7}.\n`));
const FILES = [LONG, ...SHORT];

// A loopback proxy in front of OpenRouter that records, and never alters, what passes.
const traffic = { requests: [], statuses: [] };
const proxy = createServer((req, res) => {
	const chunks = [];
	req.on("data", (chunk) => chunks.push(chunk));
	req.on("end", () => {
		const body = Buffer.concat(chunks);
		try {
			traffic.requests.push(JSON.parse(body.toString("utf8")));
		} catch {
			// not JSON: pass it through
		}
		const headers = { ...req.headers, host: "openrouter.ai", "content-length": String(body.length) };
		delete headers["accept-encoding"];
		const upstream = httpsRequest(`https://openrouter.ai${req.url}`, { method: req.method, headers }, (reply) => {
			traffic.statuses.push(reply.statusCode);
			res.writeHead(reply.statusCode ?? 502, reply.headers);
			reply.pipe(res);
		});
		upstream.on("error", (error) => {
			res.writeHead(502);
			res.end(String(error));
		});
		upstream.end(body);
	});
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const PROXY_URL = `http://127.0.0.1:${proxy.address().port}/api/v1`;

const modelBlock = (id) => ({ provider: "openrouter-qa", id, name: id, baseUrl: PROXY_URL, api: "openai-completions", apiKeyEnv: "OPENROUTER_API_KEY", reasoning: false, input: ["text"], contextWindow: 262144, maxTokens: 16000 });
const readConfig = () => JSON.parse(readFileSync(CONFIG, "utf8"));
const writeConfig = (config) => writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
writeConfig({
	searchPaths: [DOCS],
	workspacePath: WORKSPACE,
	memoryPath: join(WORK, "memory.json"),
	minSync: { enabled: true, autoInstall: false, embedder: { id: "none" } },
	jikji: false,
	jev: { backend: "sllm" },
	webSearch: { enabled: false },
	model: modelBlock(ANSWER_MODEL),
	queryDecomposition: { model: modelBlock(ANSWER_MODEL) },
});

const env = {
	AUTORAG_HOME: join(WORK, "autorag-home"),
	...homeEnv(join(WORK, "home")),
	AUTORAG_CONFIG: CONFIG,
	PI_CODING_AGENT_DIR: join(WORK, "pi-agent"),
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	ELECTRON_RENDERER_URL: "",
	OPENROUTER_API_KEY: KEY,
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
	FASTEMBED_CACHE_DIR: MODELS,
};

/** The text of every tool result the model was shown, with the tool's name, from what passed the proxy. */
function toolResults(requests) {
	const names = new Map();
	const results = [];
	for (const request of requests) {
		for (const message of request.messages ?? []) {
			for (const call of message.tool_calls ?? []) names.set(call.id, call.function?.name ?? "");
			if (message.role === "tool") {
				const text = typeof message.content === "string" ? message.content : (message.content ?? []).map((part) => part.text ?? "").join("");
				results.push({ id: message.tool_call_id, name: names.get(message.tool_call_id) ?? "", text });
			}
		}
	}
	return [...new Map(results.map((result) => [result.id, result])).values()];
}

async function ask(page, question) {
	const before = traffic.requests.length;
	await openAiSearch(page);
	await page.fill('textarea[aria-label="Ask Dazzi"]', question);
	await page.keyboard.press("Enter");
	const finished = () =>
		page.evaluate(() => {
			const input = document.querySelector('textarea[aria-label="Ask Dazzi"]');
			const done = input !== null && document.querySelector('button[aria-label="Stop"]') === null && document.querySelector(".user-msg") !== null;
			return done || Boolean(document.querySelector(".ai .text-danger-text")?.textContent);
		});
	const deadline = Date.now() + 300_000;
	await page.waitForTimeout(1500);
	while (!(await finished())) {
		if (Date.now() > deadline) throw new Error("the answer did not finish within 300s");
		await page.waitForTimeout(500);
	}
	const error = (await page.locator(".ai .text-danger-text").first().textContent({ timeout: 1000 }).catch(() => null)) ?? "";
	const proses = page.locator(".assistant-msg .assistant-prose");
	let answer = "";
	for (let index = 0; index < (await proses.count()); index += 1) answer += `${await proses.nth(index).innerText()}\n`;
	return { error, answer, results: toolResults(traffic.requests.slice(before)) };
}

async function launch(label) {
	const app = await launchFinder({ userDataDir: join(WORK, `user-data-${label}`), env, language: "en" });
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(30_000);
	const pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(String(error)));
	await page.waitForSelector(".sidebar__item", { timeout: 30_000 });
	return { app, page, pageErrors };
}

/** Which corpus files a search result names, and how often the long manual appears in it. */
function spread(text) {
	return { files: FILES.filter((name) => text.includes(name)), longHits: text.split(LONG).length - 1 };
}

async function localSearchSpread(page, label) {
	const { error, answer, results } = await ask(page, `내 문서에서 ${TOPIC} 펌프를 점검한 팀과 owner code를 모두 찾아줘. 문서마다 정리해줘.`);
	const searches = results.filter((result) => result.name !== "calculator" && FILES.some((name) => result.text.includes(name)));
	writeFileSync(join(EVIDENCE, `search-results-${label}.json`), JSON.stringify(results, null, 2));
	log(`[${label}] tools: ${results.map((result) => result.name).join(", ")}; answer: ${answer.replace(/\s+/g, " ").slice(0, 300)}`);
	check(`[${label}] AI Search shows no error`, error === "", error);
	const first = searches[0];
	const measured = first === undefined ? { files: [], longHits: 0 } : spread(first.text);
	log(`[${label}] first local search (${first?.name ?? "none"}): ${measured.files.length} files, manual named ${measured.longHits} times`);
	return measured;
}

let session = null;
try {
	// 1. index the corpus through Settings → Indexing, the way a person would
	session = await launch("cut-on");
	const { page } = session;
	await page.locator(".sidebar__item--settings").click();
	await page.waitForSelector(".settings-panel");
	await page.locator(".settings-nav-item", { hasText: "Indexing" }).first().click();
	await page.getByRole("button", { name: "Refresh local folders now" }).click();
	const progressPath = join(WORKSPACE, ".autorag", "refresh-progress.json");
	const deadline = Date.now() + 600_000;
	let progress = null;
	while (Date.now() < deadline) {
		await page.waitForTimeout(1000);
		try {
			progress = JSON.parse(readFileSync(progressPath, "utf8"));
		} catch {
			continue;
		}
		if (progress.state === "success" || progress.state === "failed") break;
	}
	check("the index was built over every file", progress?.state === "success" && (progress.parsedCounts?.scanned ?? 0) >= FILES.length, JSON.stringify({ state: progress?.state, scanned: progress?.parsedCounts?.scanned }));
	await page.locator(".settings-sidebar-back").click();

	// 2. the calculator: exact day count, served by the tool
	const calc = await ask(page, "2026년 11월 10일부터 2027년 3월 1일까지 정확히 며칠이야? 숫자만 답해줘.");
	await page.screenshot({ path: join(EVIDENCE, "01-calculator-answer.png") });
	log(`calculator answer: ${calc.answer.replace(/\s+/g, " ").slice(0, 300)}; tools: ${calc.results.map((result) => result.name).join(", ")}`);
	check("the date question shows no error", calc.error === "", calc.error);
	const calculatorResults = calc.results.filter((result) => result.name === "calculator");
	check("the agent called the calculator tool", calculatorResults.length >= 1, calc.results.map((result) => result.name).join(","));
	check("the calculator returned 111 days", calculatorResults.some((result) => /\b111\b/u.test(result.text)), calculatorResults.map((result) => result.text.slice(0, 200)).join(" | "));
	check("the answer shows 111", /\b111\b/u.test(calc.answer), calc.answer.slice(0, 200));

	// 3. the record cut on (the default): the first local search spreads across documents
	const on = await localSearchSpread(page, "cut-on");
	await page.screenshot({ path: join(EVIDENCE, "02-cut-on-answer.png") });
	check("with the record cut on, the first search shows the model at least 4 documents", on.files.length >= 4, JSON.stringify(on));

	// 4. Settings writes keep a `limits.recordCut` block the librarian accepts
	const patched = await page.evaluate(() => window.autorag.settings.configPatch([{ path: ["limits"], value: { recordCut: { enabled: false } } }]).then((snap) => ({ ok: true, error: snap.error }), (error) => ({ ok: false, error: String(error) })));
	check("a config write of `limits.recordCut.enabled: false` is accepted", patched.ok && patched.error === null, JSON.stringify(patched));
	check("…and lands in the shared config", readConfig().limits?.recordCut?.enabled === false, JSON.stringify(readConfig().limits));
	check("no renderer page error (cut on)", session.pageErrors.length === 0, session.pageErrors.slice(0, 2).join(" | "));
	await session.app.close().catch(() => undefined);

	// 5. the record cut off: the same question, a fresh app, the long manual takes more of the first search
	session = await launch("cut-off");
	const off = await localSearchSpread(session.page, "cut-off");
	await session.page.screenshot({ path: join(EVIDENCE, "03-cut-off-answer.png") });
	check("with the record cut off, the first search shows fewer documents than with it on", off.files.length < on.files.length, `on=${JSON.stringify(on)} off=${JSON.stringify(off)}`);
	check("no renderer page error (cut off)", session.pageErrors.length === 0, session.pageErrors.slice(0, 2).join(" | "));
	check("every upstream request succeeded", traffic.statuses.every((status) => status === 200), JSON.stringify(traffic.statuses));
} catch (error) {
	check("run completed", false, String(error?.stack ?? error).slice(0, 800));
	await session?.page.screenshot({ path: join(EVIDENCE, "failure.png") }).catch(() => undefined);
} finally {
	await session?.app.close().catch(() => undefined);
	proxy.close();
	log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
	rmSync(WORK, { recursive: true, force: true });
	process.exitCode = failures.length === 0 ? 0 : 1;
}
