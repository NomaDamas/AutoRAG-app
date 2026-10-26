/**
 * Manual QA — what AI Search's error box offers, and "AI로 고치기", in the real app.
 *
 * The real app runs end to end: the real librarian agent, the real error-fix helper (a pi session with the app's own
 * tools), the real preload bridge and renderer. Only the model is scripted: a loopback OpenAI-compatible server hands
 * out the steps each scenario queues, or answers with an HTTP error, so what the person sees is deterministic.
 * Real mouse and keyboard input; the config file on disk and the requests the model receives are checked, not just pixels.
 *
 *   1. an error in the app's own setup (a search folder that is gone) shows the plain message with "Fix with AI" on the
 *      right; the fix agent is told that error and offered only the app's five tools; it looks, repoints the folder,
 *      the old config is backed up, the dialog lists the steps and the change, and "Search again" then answers;
 *   2. a model that cannot be used (rejected key, spent plan, retired model) says so in plain words, offers no AI fix
 *      and leads to the model settings and the subscription page; a rate limit and a lost connection say to wait / check
 *      the connection;
 *   3. when the model goes down during the fix, the dialog says the same, with the same buttons;
 *   4. Stop ends the run; "needs you" results lead to the Settings page that helps;
 *   5. the same screens in Korean, Japanese and Chinese (length and wrapping).
 *
 * POSIX only (a shell stub for MinSync): not part of run-all.mjs. Run it in a VM:
 *   bun run qa script scripts/manual-qa/run-qa-finder-ai-search-error-fix.mjs
 * Screenshots land in $QA_OUT (default .omo/evidence/ai-finder-app/qa-ai-search-error-fix/). Prereq: bun run build.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { AI_PANEL, finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";
import { rmRetry, writeMinsyncStub } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/qa-ai-search-error-fix");
mkdirSync(EVIDENCE, { recursive: true });
const LOG = join(EVIDENCE, "run.log");
writeFileSync(LOG, "");
const log = (line) => {
	console.log(line);
	appendFileSync(LOG, `${line}\n`);
};
const failures = [];
const check = (label, ok, detail) => {
	log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`);
	if (!ok) failures.push(label);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-errfix-"));
const AUTORAG_HOME = join(WORK, "autorag-home");
const AGENT_DIR = join(WORK, "pi-agent");
const CONFIG = join(WORK, "config.json");
const DOCS = join(WORK, "Documents");
const GONE = join(WORK, "Documents-old");
const USER_DATA = join(WORK, "user-data");
mkdirSync(DOCS, { recursive: true });
mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });
writeMinsyncStub(join(AUTORAG_HOME, "bin"));
writeFileSync(join(DOCS, "a.txt"), "hello from a.txt\n");

// ── The scripted model: an OpenAI-compatible chat-completions endpoint on loopback. ──
/** `script`: hand out the queued steps; `http`: answer every request with that status and body; `drop`: cut the connection. */
let behaviour = { kind: "script" };
const queue = [];
const seen = [];
const frame = (delta, finish) =>
	`data: ${JSON.stringify({ id: "chatcmpl-qa", object: "chat.completion.chunk", created: 0, model: "qa-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const chunks = [];
	req.on("data", (chunk) => chunks.push(chunk));
	req.on("end", () => {
		if (url.pathname !== "/v1/chat/completions") {
			res.writeHead(404).end();
			return;
		}
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		seen.push({
			tools: (body.tools ?? []).map((tool) => tool.function?.name).sort(),
			system: body.messages?.find((message) => message.role === "system")?.content ?? "",
			messages: body.messages ?? [],
		});
		if (behaviour.kind === "drop") {
			req.socket.destroy();
			return;
		}
		if (behaviour.kind === "http") {
			res.writeHead(behaviour.status, { "content-type": "application/json" }).end(JSON.stringify(behaviour.body));
			return;
		}
		const step = queue.shift() ?? { text: "(nothing scripted)" };
		if (step.httpStatus) {
			res.writeHead(step.httpStatus, { "content-type": "application/json" }).end(JSON.stringify(step.body));
			return;
		}
		void (async () => {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			if (step.delayMs) await sleep(step.delayMs);
			if (step.tool) {
				const call = { index: 0, id: `call_${seen.length}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } };
				res.write(frame({ role: "assistant", tool_calls: [call] }, null));
				res.write(frame({}, "tool_calls"));
			} else {
				res.write(frame({ role: "assistant", content: step.text }, null));
				res.write(frame({}, "stop"));
			}
			res.write(`data: ${JSON.stringify({ id: "chatcmpl-qa", object: "chat.completion.chunk", created: 0, model: "qa-model", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
			res.end("data: [DONE]\n\n");
		})();
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const MODEL_URL = `http://127.0.0.1:${server.address().port}`;
const script = (steps) => {
	behaviour = { kind: "script" };
	queue.splice(0, queue.length, ...steps);
	seen.length = 0;
};
const failWith = (status, body) => {
	behaviour = { kind: "http", status, body };
	seen.length = 0;
};

const configWith = (searchPaths) => ({
	searchPaths,
	workspacePath: join(WORK, "workspace"),
	memoryPath: join(WORK, "memory.json"),
	minSync: { enabled: true, autoInstall: false, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } },
	jikji: false,
	jev: false,
	webSearch: { enabled: false },
	queryDecomposition: false,
	model: { provider: "qa", id: "qa-model", name: "QA", baseUrl: `${MODEL_URL}/v1`, api: "openai-completions", apiKeyEnv: "QA_API_KEY", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 },
});
const writeConfig = (searchPaths) => writeFileSync(CONFIG, `${JSON.stringify(configWith(searchPaths), null, 2)}\n`);
const readConfig = () => JSON.parse(readFileSync(CONFIG, "utf8"));
writeConfig([GONE]);

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
	AUTORAG_CONFIG: CONFIG,
	PI_CODING_AGENT_DIR: AGENT_DIR,
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	ELECTRON_RENDERER_URL: "",
	QA_API_KEY: "qa-key",
	PATH: `${join(AUTORAG_HOME, "bin")}${delimiter}${process.env.PATH ?? ""}`,
	OPENROUTER_API_KEY: "",
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
};
let page;
/** Starts the app in `language` (the first run's is English) and opens AI Search, by position: the sidebar's labels are translated. */
const startApp = async (language, userDataDir) => {
	app = await launchFinder({ userDataDir, env: APP_ENV, language });
	page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(20_000);
	page.on("pageerror", (error) => log(`[pageerror] ${String(error).slice(0, 300)}`));
	app.process().stderr?.on("data", (chunk) => {
		const text = String(chunk).trim();
		if (/Error|error TS|not a function|undefined/i.test(text)) log(`[main:err] ${text.slice(0, 300)}`);
	});
	await page.waitForSelector(".sidebar__item", { timeout: 30_000 });
	await page.locator(".sidebar__item").first().click();
};
await startApp("en", USER_DATA);
let panel = page.locator(AI_PANEL);
await panel.locator('input[aria-label="Ask Dazzi"]').waitFor();
/** The composer and New chat button carry translated aria-labels; the lane reads them from the locale files it is checking against. */
const locale = (language, key) => key.split(".").reduce((node, part) => node[part], JSON.parse(readFileSync(join(ROOT, "src/shared/i18n/locales", `${language}.json`), "utf8")));
let ui = { askDazzi: locale("en", "aiSearch.askDazzi"), newChat: locale("en", "aiSearch.newChat") };
let notice = panel.locator('[role="alert"]');
/** Waits for something in the dialog; when it never comes, says what the dialog and the model side actually showed. */
const waitInDialog = async (locator, timeout = 60_000) => {
	try {
		await locator.waitFor({ timeout });
	} catch (error) {
		log(`TIMEOUT dialog text: ${(await page.getByRole("dialog").innerText().catch(() => "(no dialog)")).replace(/\s+/g, " ").slice(0, 700)}`);
		log(`model requests seen: ${seen.length}; queue left: ${queue.length}`);
		const toolTexts = seen.flatMap((request) => request.messages.filter((message) => message.role === "tool").map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content))));
		log(`tool results the model got: ${JSON.stringify(toolTexts.map((entry) => entry.slice(0, 160)))}`);
		await page.screenshot({ path: join(EVIDENCE, "timeout.png") });
		throw error;
	}
};
let dialog = page.getByRole("dialog");
const shot = async (name) => {
	await page.waitForTimeout(450);
	await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
};
const ask = async (text) => {
	await panel.locator(`button[aria-label="${ui.newChat}"]`).click();
	await panel.locator(`input[aria-label="${ui.askDazzi}"]`).click();
	await page.keyboard.type(text);
	await page.keyboard.press("Enter");
};
const finished = () =>
	page.waitForFunction(() => document.querySelector('input[aria-label="Ask Dazzi"]') !== null && document.querySelector('button[aria-label="Stop"]') === null, null, { timeout: 60_000 });
const pageTitle = (title) => page.locator("h1.linear-title", { hasText: title }).waitFor();
const backToAiSearch = () => page.locator('[data-ai-search="true"] .tab__title').click();
const fixButton = (name) => panel.getByRole("button", { name, exact: true });
log("app ready");

// ── 1. An error in the app's own setup: Fix with AI. ─────────────────────
await ask("what does a.txt say?");
await notice.waitFor();
const otherText = await notice.innerText();
log(`message shown: ${otherText.replace(/\s+/g, " ").slice(0, 220)}`);
check("the notice names the plain problem and keeps the original message", otherText.includes("Something went wrong") && otherText.includes(GONE), otherText.slice(0, 200));
check("the notice offers Fix with AI and nothing else", (await panel.locator('[role="alert"] button').allInnerTexts()).join("|") === "Fix with AI");
const geometry = await notice.evaluate((root) => {
	const text = root.querySelector("span.select-text")?.getBoundingClientRect();
	const button = root.querySelector("button")?.getBoundingClientRect();
	return text && button ? { textRight: text.right, buttonLeft: button.left, buttonRight: button.right, noticeRight: root.getBoundingClientRect().right } : null;
});
check("the button sits to the right of the message, inside the box", geometry !== null && geometry.buttonLeft >= geometry.textRight - 1 && geometry.buttonRight <= geometry.noticeRight, JSON.stringify(geometry));
await shot("01-other-error-notice");

script([
	{ tool: "diagnose", args: {}, delayMs: 1500 },
	{ tool: "check_path", args: { path: WORK } },
	{ tool: "update_config", args: { updates: [{ path: ["searchPaths"], value: [DOCS] }] } },
	{ tool: "diagnose", args: {} },
	{ tool: "report_result", args: { status: "fixed", summary: "The search folder was renamed from Documents-old to Documents, so I pointed the setting at Documents.", nextSteps: [] } },
	{ text: "done" },
]);
await fixButton("Fix with AI").click();
await dialog.waitFor();
check("the dialog says what the agent will and will not do", (await dialog.innerText()).includes("never changes your model"), (await dialog.innerText()).slice(0, 200));
check("the dialog shows the error that is being fixed", (await dialog.innerText()).includes(GONE));
await shot("02-fix-running");
await waitInDialog(dialog.getByText("Fixed", { exact: true }));
const doneText = await dialog.innerText();
check("the dialog lists what the agent did, in order", doneText.includes("Checking settings and status") && doneText.includes(`Checking path: ${WORK}`) && doneText.includes("Changing setting: searchPaths"), doneText.replace(/\s+/g, " ").slice(0, 400));
check("the dialog shows the agent's own summary", doneText.includes("pointed the setting at Documents"));
check("the dialog shows the change, before and after", doneText.includes("searchPaths") && doneText.includes(GONE) && doneText.includes(DOCS), doneText.replace(/\s+/g, " ").slice(0, 500));
check("the config on disk now points at the folder that exists", JSON.stringify(readConfig().searchPaths) === JSON.stringify([DOCS]), JSON.stringify(readConfig().searchPaths));
const backups = readdirSync(WORK).filter((name) => /^config\.json\.bak-\d{14}-before-error-fix$/.test(name));
check("the old config was kept beside it, and the dialog names where", backups.length === 1 && doneText.includes(backups[0] ?? "?"), JSON.stringify(backups));
check("the backup holds the old folder", backups.length === 1 && JSON.parse(readFileSync(join(WORK, backups[0]), "utf8")).searchPaths[0] === GONE);
check("the model got the error text and exactly the app's five tools, no pi file or shell tool", seen[0]?.system.includes(GONE) && JSON.stringify(seen[0]?.tools) === JSON.stringify(["check_path", "diagnose", "refresh_index", "report_result", "update_config"]), JSON.stringify(seen[0]?.tools));
check("the model was never told a secret: the redacted config has no key", !JSON.stringify(seen.map((entry) => entry.messages)).includes("qa-key"));
await shot("03-fix-done");

script([{ text: "a.txt says hello." }]);
await dialog.getByRole("button", { name: "Search again" }).click();
await dialog.waitFor({ state: "detached" });
await finished();
const answer = await panel.innerText();
check("Search again asks the question once more and it now answers", answer.includes("a.txt says hello"), answer.replace(/\s+/g, " ").slice(-200));
check("the earlier turn's error stays as plain words, without buttons", (await panel.locator('[role="alert"] button').count()) === 0);
await shot("04-searched-again");

// ── 2. A model that cannot be used: no AI fix, but a way out. ────────────
const modelCases = [
	{ label: "a rejected key", status: 401, body: { error: { message: "Incorrect API key provided: qa-key.", type: "invalid_request_error", code: "invalid_api_key" } }, title: "sign-in or key was rejected", buttons: ["Open model settings", "Open Subscription & Usage"] },
	{ label: "a spent plan", status: 429, body: { error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" } }, title: "Your subscription or usage limit is blocking the AI model", buttons: ["Open Subscription & Usage", "Open model settings"] },
	{ label: "a retired model", status: 404, body: { error: { message: "The model `qa-model` does not exist or you do not have access to it.", type: "invalid_request_error", code: "model_not_found" } }, title: "The selected AI model can’t be found", buttons: ["Open model settings"] },
	{ label: "a rate limit", status: 429, body: { error: { message: "Rate limit reached for requests", type: "requests", code: "rate_limit_exceeded" } }, title: "Too many requests right now", buttons: ["Open model settings"] },
];
let index = 0;
for (const entry of modelCases) {
	index += 1;
	failWith(entry.status, entry.body);
	await ask(`question for ${entry.label}`);
	await notice.waitFor({ timeout: 90_000 });
	const text = await notice.innerText();
	log(`${entry.label} → message shown: ${text.replace(/\s+/g, " ").slice(0, 260)}`);
	check(`${entry.label}: the notice says plainly what is wrong`, text.includes(entry.title), text.replace(/\s+/g, " ").slice(0, 200));
	const names = (await panel.locator('[role="alert"] button').allInnerTexts()).filter((name) => name !== "Show details");
	check(`${entry.label}: the buttons are ${entry.buttons.join(" + ")} and there is no AI fix`, JSON.stringify(names) === JSON.stringify(entry.buttons), JSON.stringify(names));
	check(`${entry.label}: the provider's code and JSON stay out of sight until "Show details"`, !text.includes(entry.body.error.code) && !text.includes("{"), text.replace(/\s+/g, " ").slice(0, 200));
	await shot(`05-${index}-${entry.label.replaceAll(" ", "-")}`);
	await panel.getByRole("button", { name: "Show details", exact: true }).first().click();
	check(`${entry.label}: "Show details" shows the provider's own words`, (await notice.innerText()).includes(entry.body.error.code), entry.body.error.code);
	await shot(`05b-${index}-${entry.label.replaceAll(" ", "-")}-details`);
}

failWith(401, { error: { message: "Incorrect API key provided: qa-key." } });
await ask("go to the settings, please");
await notice.waitFor({ timeout: 90_000 });
await fixButton("Open model settings").click();
await pageTitle("AI Models");
check("Open model settings opens Settings on the AI models page", true);
await shot("06-model-settings");
await backToAiSearch();
await notice.waitFor();
await fixButton("Open Subscription & Usage").click();
await pageTitle("Subscription & Usage");
check("Open Subscription & Usage opens the plan page", true);
await shot("07-plan-page");
await backToAiSearch();

behaviour = { kind: "drop" };
await ask("question while offline");
await notice.waitFor({ timeout: 90_000 });
const dropText = await notice.innerText();
log(`connection cut → message shown: ${dropText.replace(/\s+/g, " ").slice(0, 260)}`);
check("a lost connection says to check the connection, with no AI fix", dropText.includes("Can’t reach the AI model’s server") && (await panel.getByRole("button", { name: "Fix with AI" }).count()) === 0, dropText.replace(/\s+/g, " ").slice(0, 200));
await shot("08-connection-lost");

// ── 3. The model goes down during the fix. ────────────────────────────────
writeConfig([GONE]);
script([{ text: "(unused)" }]);
await ask("what does a.txt say, once more?");
await notice.waitFor();
check("the broken folder is an app-setup error again", (await notice.innerText()).includes("Something went wrong"));
failWith(401, { error: { message: "Incorrect API key provided: qa-key." } });
await fixButton("Fix with AI").click();
await dialog.getByText("sign-in or key was rejected").waitFor({ timeout: 90_000 });
const downText = await dialog.innerText();
check("the dialog says the model cannot be used, with the hint about the subscription", downText.includes("check that your subscription is active"), downText.replace(/\s+/g, " ").slice(0, 300));
check("it offers the settings buttons and no retry that could not help", (await dialog.getByRole("button", { name: "Open model settings" }).count()) === 1 && (await dialog.getByRole("button", { name: "Retry" }).count()) === 0);
await shot("09-fix-model-down");
await dialog.getByRole("button", { name: "Open model settings" }).click();
await pageTitle("AI Models");
check("the dialog closed and Settings opened on the AI models page", (await page.getByRole("dialog").count()) === 0);
await backToAiSearch();

// ── 4. Stop, and results that need the person. ───────────────────────────
script([{ tool: "diagnose", args: {}, delayMs: 15_000 }, { text: "done" }]);
await notice.waitFor();
await fixButton("Fix with AI").click();
await dialog.waitFor();
await dialog.getByRole("button", { name: "Stop" }).click();
await dialog.getByText("Stopped.", { exact: true }).waitFor();
check("Stop ends the run and says so", true);
await shot("10-fix-stopped");
await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
check("closing leaves the original error in place", (await notice.count()) === 1);

const needsUserSteps = () => [
	{ tool: "diagnose", args: {} },
	{
		tool: "report_result",
		args: {
			status: "needs-user",
			summary: "The Documents-old folder no longer exists and I could not tell where it went.",
			nextSteps: ["Pick the folder that holds your documents."],
			actions: [
				{ kind: "settings", target: "scope", label: "Pick the search folder again" },
				{ kind: "folder", target: DOCS, label: "Look at the Documents folder" },
				{ kind: "settings", target: "nowhere", label: "A page that does not exist" },
			],
		},
	},
	{ text: "done" },
];
script(needsUserSteps());
await fixButton("Fix with AI").click();
await waitInDialog(dialog.getByText("There is something you need to do"));
const needsText = await dialog.innerText();
check("the dialog lists what the person has to do", needsText.includes("Pick the folder that holds your documents."));
check("there is no 'Search again' when nothing was fixed", (await dialog.getByRole("button", { name: "Search again" }).count()) === 0);
const buttonNames = await dialog.locator("button").allInnerTexts();
check("the AI's buttons carry the labels the AI wrote, and the one with a page that does not exist was dropped", buttonNames.includes("Pick the search folder again") && buttonNames.includes("Look at the Documents folder") && !buttonNames.includes("A page that does not exist"), JSON.stringify(buttonNames));
await shot("11-fix-needs-user");
await dialog.getByRole("button", { name: "Look at the Documents folder", exact: true }).click();
await page.locator(".path-bar, [data-path-bar], .pathbar").first().waitFor({ state: "attached", timeout: 10_000 }).catch(() => undefined);
check("the folder button closed the dialog and opened a Finder tab on that folder", (await page.getByRole("dialog").count()) === 0 && (await page.locator(`[data-tab-id]`, { hasText: "Documents" }).count()) >= 1, await page.locator("[data-tab-id]").allInnerTexts().then((names) => JSON.stringify(names)));
await shot("11b-folder-button-opened-a-tab");
await backToAiSearch();
script(needsUserSteps());
await fixButton("Fix with AI").click();
await waitInDialog(dialog.getByText("There is something you need to do"));
await dialog.getByRole("button", { name: "Pick the search folder again", exact: true }).click();
await pageTitle("Search Scope");
check("the settings button opens the Settings page the AI named", true);
await backToAiSearch();

// ── 4b. The rest of the endings, for the report. ─────────────────────────
script([{ tool: "diagnose", args: {} }, { tool: "report_result", args: { status: "cannot-fix", summary: "The folder is gone and nothing nearby looks like it, so I could not repair it.", nextSteps: ["Restore the folder, or choose another one in Search Scope."], actions: [{ kind: "settings", target: "scope", label: "Choose another folder" }] } }, { text: "done" }]);
await fixButton("Fix with AI").click();
await waitInDialog(dialog.getByText("Couldn’t fix it", { exact: true }));
check("a 'cannot fix' result says so and still leads where the AI pointed", (await dialog.getByRole("button", { name: "Choose another folder", exact: true }).count()) === 1);
await shot("15-fix-cannot-fix");
await page.keyboard.press("Escape");
await dialog.waitFor({ state: "detached" });

script([{ tool: "diagnose", args: {} }, { text: "I think it is fine." }]);
await fixButton("Fix with AI").click();
await waitInDialog(dialog.getByText("Couldn’t fix it with AI"));
check("an agent that ends without an answer is a failure with a retry", (await dialog.getByRole("button", { name: "Retry" }).count()) === 1);
await shot("16-fix-no-result");
script([{ tool: "diagnose", args: {} }, { tool: "report_result", args: { status: "cannot-fix", summary: "Second try: nothing I can reach explains it.", nextSteps: [] } }, { text: "done" }]);
await dialog.getByRole("button", { name: "Retry" }).click();
await waitInDialog(dialog.getByText("Second try", { exact: false }));
await shot("17-fix-retry-result");
await page.keyboard.press("Escape");
await dialog.waitFor({ state: "detached" });

// The model goes down AFTER the agent already changed the config: the change is not hidden.
script([
	{ tool: "update_config", args: { updates: [{ path: ["searchPaths"], value: [DOCS] }] } },
	{ httpStatus: 401, body: { error: { message: "Incorrect API key provided: qa-key." } } },
]);
await fixButton("Fix with AI").click();
await waitInDialog(dialog.getByText("sign-in or key was rejected"));
check("a change made before the model went down is still shown", (await dialog.innerText()).includes("searchPaths"));
await shot("18-fix-changed-then-model-down");
await page.keyboard.press("Escape");
await dialog.waitFor({ state: "detached" });
writeConfig([GONE]);

// No model is chosen at all.
const withoutModel = { ...configWith([DOCS]) };
delete withoutModel.model;
writeFileSync(CONFIG, `${JSON.stringify(withoutModel, null, 2)}\n`);
await ask("question without any model");
await notice.waitFor({ timeout: 90_000 });
log(`no model → message shown: ${(await notice.innerText()).replace(/\s+/g, " ").slice(0, 300)}`);
await shot("19-no-model");
writeConfig([GONE]);
// ── 5. The same screens in the other interface languages. ────────────────
for (const [language, fixLabel, titleText] of [
	["ko", "AI로 고치기", "문제가 생겼어요"],
	["ja", "AIで修正", "問題が発生しました"],
	["zh", "用 AI 修复", "出现了问题"],
]) {
	writeConfig([GONE]);
	await app.close().catch(() => undefined);
	await startApp(language, `${USER_DATA}-${language}`);
	dialog = page.getByRole("dialog");
	behaviour = { kind: "script" };
	script([{ text: "(unused)" }]);
	ui = { askDazzi: locale(language, "aiSearch.askDazzi"), newChat: locale(language, "aiSearch.newChat") };
	// The panel's own aria-label is translated too.
	panel = page.locator(`section[aria-label="${locale(language, "aiSearch.title")}"]:not([aria-hidden="true"])`);
	notice = panel.locator('[role="alert"]');
	await ask(`language ${language}`);
	await notice.waitFor();
	const text = await notice.innerText();
	check(`${language}: the notice and its button are translated`, text.includes(titleText) && (await fixButton(fixLabel).count()) === 1, text.replace(/\s+/g, " ").slice(0, 160));
	await shot(`12-${language}-notice`);
	script([{ tool: "diagnose", args: {} }, { tool: "report_result", args: { status: "cannot-fix", summary: "x", nextSteps: ["y"] } }, { text: "done" }]);
	await fixButton(fixLabel).click();
	await dialog.waitFor();
	await page.waitForTimeout(2500);
	await shot(`13-${language}-dialog`);
	await page.keyboard.press("Escape");
	await dialog.waitFor({ state: "detached" });
	// The folder works again, so this question reaches the model, which rejects the key.
	writeConfig([DOCS]);
	failWith(401, { error: { message: "Incorrect API key provided: qa-key." } });
	await ask(`model ${language}`);
	await notice.waitFor({ timeout: 90_000 });
	await shot(`14-${language}-model-error`);
}

log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
await app?.close().catch(() => undefined);
sweep(true);
process.exitCode = failures.length === 0 ? 0 : 1;
