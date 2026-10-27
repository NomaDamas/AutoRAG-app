// Live end-to-end: "AI로 고치기" with a real model, and the error box with a real server's own error wording.
//
// Same harness as run-qa-live-ai-search-interaction.mjs: a fresh profile signs in through a loopback stand-in for the Dazzi
// web sign-in, and every `/v1/*` call is forwarded unchanged to the live Dazzi API, so the model's decisions are its own.
// The account key comes from QA_DAZZI_TOKEN, else from the `dazzi` entry of the developer's `~/.pi/agent/auth.json`; it is only
// handed to the throwaway profile, whose config, agent dir and user data all live under a temp directory (the developer's own
// config is never read or written). Run `bun run build` first, on this machine (the key is not forwarded into a VM):
//
//   bun scripts/manual-qa/run-qa-live-ai-search-error-fix.mjs
//
// QA_LIVE_MODEL picks the Dazzi plan model (default deepseek/deepseek-v4.1-flash, listed by OpenRouter's live catalog with
// created=2026-09-10; never pick a model from memory, read https://openrouter.ai/api/v1/models).
//
//   1. The search folder in the config is gone (it was moved up one level). AI Search says so; "Fix with AI" runs the real model
//      as the error-fix agent with pi's own file and shell tools; it must look (read, ls, find, diagnose), repoint the folder in the config file (edit or write), leave a backup of the
//      old config, and report `fixed`. The config on disk is then checked, not just the dialog. "Search again" answers from the
//      file in the repaired folder (a number only that file holds).
//   2. The server rejects the key (the stand-in swaps the Authorization header of /v1/responses for an invalid one, so the real
//      server answers 401 in its own words): the box classifies the server's real wording as a model problem, offers no AI
//      fix, and leads to the model settings and the subscription page; the real wording is printed.
//   3. The same rejection during the fix: the dialog explains the model problem instead of retrying.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { AI_PANEL, finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";

const REAL_API = "https://api.dazziapp.com";
const MODEL_ID = process.env.QA_LIVE_MODEL?.trim() || "deepseek/deepseek-v4.1-flash";
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-ai-search-error-fix");
mkdirSync(EVIDENCE, { recursive: true });

/** The Dazzi key for the throwaway profile: from the environment, else the developer's own `~/.pi/agent/auth.json` (read at run time, never written anywhere). */
function realToken() {
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
const TOKEN = realToken();
if (TOKEN === null) {
	console.error("A Dazzi account key is required: set QA_DAZZI_TOKEN or sign in to Dazzi on this machine.");
	process.exit(2);
}

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-live-errfix-"));
const AGENT_DIR = join(WORK, "pi-agent");
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const REPORTS = join(WORK, "Reports");
const MOVED_FROM = join(WORK, "archive", "Reports");
mkdirSync(REPORTS, { recursive: true });
mkdirSync(join(WORK, "archive"), { recursive: true });
mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(join(AUTORAG_HOME, "bin"), { recursive: true });
const minsyncStub = join(AUTORAG_HOME, "bin", "minsync");
writeFileSync(minsyncStub, "#!/bin/sh\nexit 0\n");
chmodSync(minsyncStub, 0o755);
const CODE = "7421";
writeFileSync(join(REPORTS, "a.txt"), `The vault access number is ${CODE}.\n`);

const baseConfig = (searchPaths) => ({
	searchPaths,
	workspacePath: join(WORK, "workspace"),
	memoryPath: join(WORK, "memory.json"),
	minSync: { enabled: true, autoInstall: true, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } },
	jikji: false,
});
writeFileSync(CONFIG, `${JSON.stringify(baseConfig([MOVED_FROM]), null, 2)}\n`);

let badKey = false;
const forwarded = [];
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
	// The server's own 401: only the model calls carry the wrong key, so the account and catalog calls still work.
	if (badKey && url.pathname.startsWith("/v1/responses")) headers.authorization = "Bearer dz_qa_invalid_key_for_error_fix";
	forwarded.push(`${req.method} ${url.pathname}${badKey && url.pathname.startsWith("/v1/responses") ? " (bad key)" : ""}`);
	const upstream = httpsRequest(`${REAL_API}${req.url}`, { method: req.method, headers }, (reply) => {
		res.writeHead(reply.statusCode ?? 502, reply.headers);
		reply.pipe(res);
	});
	upstream.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
	req.pipe(upstream);
});
await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${service.address().port}`;

const env = {
	AUTORAG_HOME,
	AUTORAG_CONFIG: CONFIG,
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

const app = await launchFinder({ userDataDir: join(WORK, "user-data"), env });
try {
	app.process().stderr?.on("data", (chunk) => {
		const text = String(chunk).trim();
		if (/\[account\]|\[providers\]|No API key|error-fix/i.test(text)) console.log(`[main:err] ${text.slice(0, 300)}`);
	});
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(60_000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
	await app.evaluate(({ shell }) => {
		shell.openExternal = async (url) => {
			await fetch(url);
		};
	});

	const status = await page.evaluate(() => window.autorag.account.signIn());
	check("Dazzi sign-in completes", status.state === "signedIn", `${status.state} ${status.error ?? ""}`);
	const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
	cfg.model = { provider: "dazzi", id: MODEL_ID, name: MODEL_ID, baseUrl: `${baseUrl}/v1`, api: "openai-responses", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 32000 };
	writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`);
	const modelBefore = JSON.stringify(cfg.model);
	console.log(`model: ${MODEL_ID}`);

	await openAiSearch(page);
	const panel = page.locator(AI_PANEL);
	const composer = panel.locator('input[aria-label="Ask Dazzi"]');
	const notice = panel.locator('[role="alert"]');
	const dialog = page.getByRole("dialog");
	const shot = async (name) => {
		await page.waitForTimeout(450);
		await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
	};
	const ask = async (text) => {
		await panel.locator('button[aria-label="New chat"]').click();
		await composer.click();
		await page.keyboard.type(text);
		await page.keyboard.press("Enter");
	};
	const finished = () =>
		page.waitForFunction(() => document.querySelector('input[aria-label="Ask Dazzi"]') !== null && document.querySelector('button[aria-label="Stop"]') === null, null, { timeout: 300_000 });
	const answerText = async () => (await page.locator(".assistant-msg .assistant-prose").allTextContents()).join("\n");
	const pageTitle = (title) => page.locator("h1.linear-title", { hasText: title }).waitFor();
	const backToAiSearch = () => page.locator('[data-ai-search="true"] .tab__title').click();

	// ── 1. The folder is gone: the real model repairs the config. ───────────
	await ask("What is the vault access number in a.txt?");
	await notice.waitFor({ timeout: 120_000 });
	const brokenText = await notice.innerText();
	console.log(`the error as the person sees it: ${brokenText.replace(/\s+/g, " ").slice(0, 300)}`);
	check("AI Search reports the missing folder and offers Fix with AI", brokenText.includes(MOVED_FROM) && (await panel.getByRole("button", { name: "Fix with AI", exact: true }).count()) === 1);
	await shot("01-broken-folder");

	const configBefore = JSON.parse(readFileSync(CONFIG, "utf8"));
	await panel.getByRole("button", { name: "Fix with AI", exact: true }).click();
	await dialog.waitFor();
	await shot("02-fix-started");
	// The run is over when its Stop button is gone (the X in the corner is there all along).
	const startedAt = Date.now();
	const watcher = setInterval(() => {
		void dialog.innerText({ timeout: 2000 }).then((text) => console.log(`[${Math.round((Date.now() - startedAt) / 1000)}s] steps so far: ${text.split("\n").filter((line) => /^(Reading|Looking|Finding|Searching|Running|Editing|Writing|Checking|Rebuilding)/.test(line)).length}; last: ${text.split("\n").filter((line) => /^(Reading|Looking|Finding|Searching|Running|Editing|Writing|Checking|Rebuilding)/.test(line)).at(-1)?.slice(0, 140)}`), () => undefined);
	}, 30_000);
	await dialog.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "detached", timeout: 0 });
	clearInterval(watcher);
	const outcome = await dialog.innerText();
	console.log(`dialog after the real run:\n${outcome}`);
	await shot("03-fix-finished");
	const steps = outcome;
	const lookedAt = ["Checking settings and status", "Reading file", "Looking in folder", "Finding files", "Searching contents", "Running command"];
	const firstLook = Math.min(...lookedAt.map((label) => (steps.includes(label) ? steps.indexOf(label) : Number.POSITIVE_INFINITY)));
	const firstChange = Math.min(...["Editing file", "Writing file"].map((label) => (steps.includes(label) ? steps.indexOf(label) : Number.POSITIVE_INFINITY)));
	check("the real agent looked before it changed anything", Number.isFinite(firstLook) && firstLook < firstChange, `look at ${firstLook}, change at ${firstChange}`);
	const after = JSON.parse(readFileSync(CONFIG, "utf8"));
	check("the config now points at the folder that exists", Array.isArray(after.searchPaths) && after.searchPaths.length >= 1 && after.searchPaths.every((path) => existsSync(path)) && after.searchPaths.includes(REPORTS), JSON.stringify(after.searchPaths));
	check("the model setting was not touched", JSON.stringify(after.model) === modelBefore);
	const untouched = Object.keys({ ...configBefore, ...after }).filter((key) => key !== "searchPaths" && JSON.stringify(configBefore[key]) !== JSON.stringify(after[key]));
	check("nothing but the search folder changed in the config (no key, token or other setting)", untouched.length === 0, JSON.stringify(untouched));
	const backups = readdirSync(WORK).filter((name) => /^config\.json\.bak-\d{14}-before-error-fix$/.test(name));
	check("the old config was kept before the change", backups.length === 1 && JSON.parse(readFileSync(join(WORK, backups[0]), "utf8")).searchPaths[0] === MOVED_FROM, JSON.stringify(backups));
	check("the dialog reports it as fixed and shows the change", outcome.includes("Fixed") && outcome.includes("searchPaths"));
	check("the agent reached the model only through the Dazzi account (no other provider)", forwarded.some((entry) => entry.startsWith("POST /v1/responses")), forwarded.slice(0, 5).join(", "));

	await dialog.getByRole("button", { name: "Search again" }).click();
	await dialog.waitFor({ state: "detached" });
	await finished();
	const answer = await answerText();
	console.log(`answer after Search again: ${answer.replace(/\s+/g, " ").slice(0, 300)}`);
	check("Search again answers from the repaired folder", answer.includes(CODE), answer.replace(/\s+/g, " ").slice(0, 200));
	await shot("04-searched-again");

	// ── 2. The real server rejects the key: its own wording is a model problem. ─
	badKey = true;
	await ask("What is the vault access number in a.txt, one more time?");
	await notice.waitFor({ timeout: 0 });
	const rejected = await notice.innerText();
	console.log(`the real server's rejection as the person sees it: ${rejected.replace(/\s+/g, " ").slice(0, 400)}`);
	check("the box says the model cannot be used", /AI model can’t be used|subscription or usage limit|No AI model is set up|can’t be found/.test(rejected), rejected.replace(/\s+/g, " ").slice(0, 200));
	check("the box offers no AI fix but the way to the settings", (await panel.getByRole("button", { name: "Fix with AI", exact: true }).count()) === 0 && (await panel.getByRole("button", { name: "Open model settings", exact: true }).count()) === 1);
	await shot("05-real-rejection");
	await panel.getByRole("button", { name: "Open model settings", exact: true }).click();
	await pageTitle("AI Models");
	check("the button opens the AI models page", true);
	await backToAiSearch();

	// ── 3. The same rejection during a fix. ──────────────────────────────────
	writeFileSync(CONFIG, `${JSON.stringify({ ...baseConfig([MOVED_FROM]), model: cfg.model }, null, 2)}\n`);
	badKey = false;
	await ask("And once more for the fix, what is in a.txt?");
	await notice.waitFor({ timeout: 120_000 });
	check("the broken folder is an app-setup error again", (await panel.getByRole("button", { name: "Fix with AI", exact: true }).count()) === 1, (await notice.innerText()).replace(/\s+/g, " ").slice(0, 160));
	badKey = true;
	await panel.getByRole("button", { name: "Fix with AI", exact: true }).click();
	await dialog.getByRole("button", { name: "Open model settings" }).waitFor({ timeout: 0 });
	const downText = await dialog.innerText();
	console.log(`dialog when the model rejects the key during the fix:\n${downText}`);
	check("the dialog explains the model problem instead of a bare failure", /can’t be used|subscription|usage limit|No AI model|can’t be found/.test(downText), downText.replace(/\s+/g, " ").slice(0, 200));
	check("the config was left alone", JSON.parse(readFileSync(CONFIG, "utf8")).searchPaths[0] === MOVED_FROM);
	await shot("06-fix-model-rejected");
	await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
	await backToAiSearch();

	// ── 4. The folder is really gone: the real AI cannot repair it and must hand the person the way there. ──
	badKey = false;
	const GONE_FOR_GOOD = join(WORK, "Archive-2019");
	const other = join(WORK, "Projects");
	mkdirSync(other, { recursive: true });
	writeFileSync(CONFIG, `${JSON.stringify({ ...baseConfig([GONE_FOR_GOOD]), model: cfg.model }, null, 2)}\n`);
	await ask("What is in a.txt?");
	await notice.waitFor({ timeout: 120_000 });
	await panel.getByRole("button", { name: "Fix with AI", exact: true }).click();
	// The plan allows a few requests a minute and the scenarios before this one used them: a 429 is the plan, not the feature, so wait a minute and try again.
	let handOver = "";
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		// The run is over when its Stop button has appeared and then gone: before it first renders it is "not there" too.
		await dialog.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
		await dialog.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "detached", timeout: 0 });
		handOver = await dialog.innerText();
		if (!handOver.includes("Too many requests right now")) break;
		console.log(`attempt ${attempt} hit the plan's rate limit; waiting before the next`);
		await page.waitForTimeout(65_000);
		await dialog.getByRole("button", { name: "Retry", exact: true }).click();
	}
	console.log(`dialog when the real AI cannot repair it:\n${handOver}`);
	const buttonLabels = (await dialog.locator("button").allInnerTexts()).filter((label) => !["Close", "Retry", "Search again", "Show details", "Hide details", ""].includes(label));
	console.log(`buttons the real AI put in its answer: ${JSON.stringify(buttonLabels)}`);
	check("the real AI did not claim a repair it could not make", !handOver.includes("Fixed"), handOver.replace(/\s+/g, " ").slice(0, 200));
	check("the real AI gave the person a button to go and choose the folder", buttonLabels.length >= 1, JSON.stringify(buttonLabels));
	check("every button is labelled in words, not as a bare page id", buttonLabels.every((label) => label.length > 2 && !/^(scope|ai|plan|indexing|apps)$/u.test(label)), JSON.stringify(buttonLabels));
	check("the config was not touched when nothing could be repaired", JSON.parse(readFileSync(CONFIG, "utf8")).searchPaths[0] === GONE_FOR_GOOD);
	await shot("07-ai-handed-buttons");
	if (buttonLabels[0] !== undefined) {
		await dialog.getByRole("button", { name: buttonLabels[0], exact: true }).click();
		await page.waitForTimeout(800);
		check("the first button of the real AI closed the dialog", (await page.getByRole("dialog").count()) === 0);
		const pageHeading = await page.locator("h1.linear-title").first().innerText().catch(() => "");
		console.log(`the page the real AI's first button opened: ${pageHeading}`);
		check("it opened the page where the search folders are chosen (Search Scope), not the indexing progress page", /Search scope/iu.test(pageHeading), pageHeading);
		await shot("08-after-the-ai-button");
		await backToAiSearch();
	}

	// ── 5. A cause outside the app's settings: the real AI must say so and must not invent a place to send the person. ──
	// The settings are fine here; the error is one only something outside the app can cause, and the app still classifies it as its own (so the fix is offered).
	writeFileSync(CONFIG, `${JSON.stringify({ ...baseConfig([REPORTS]), model: cfg.model }, null, 2)}\n`);
	const outsideMessage = "EACCES: permission denied, open '/Library/Application Support/com.apple.TCC/TCC.db' (the operating system refused access to a protected file)";
	const askFixer = (text) =>
		page.evaluate(
			(message) =>
				new Promise((resolve) => {
					const runId = crypto.randomUUID();
					const events = [];
					window.autorag.errorFix.onEvent((event) => {
						if (event.runId !== runId) return;
						events.push(event);
						if (event.type === "result" || event.type === "error" || event.type === "cancelled") resolve(events);
					});
					void window.autorag.errorFix.start(runId, { message, surface: "ai-search" });
				}),
			text,
		);
	// Each one is a cause outside Dazzi that the app still classifies as its own (so the fix is offered), with nothing to change in a Dazzi setting.
	const outsideCases = [
		{ label: "the operating system refused a permission", message: outsideMessage },
		{ label: "a file held by another program", message: "EBUSY: resource busy or locked, open '/Users/me/Documents/ledger.xlsx' (another program has the file open)" },
		{ label: "the provider's service is down", message: 'The answer service returned an error: {"status":"unavailable","detail":"The upstream search provider is not responding"}' },
	];
	for (const outside of outsideCases) {
		let outsideEnd;
		// The plan allows a limited number of requests a minute: a 429 is the plan, not the feature, so wait it out and ask again.
		for (let attempt = 1; attempt <= 4; attempt += 1) {
			outsideEnd = (await askFixer(outside.message)).at(-1);
			if (!(outsideEnd?.type === "error" && /Too many requests|\(429\)|rate_limit/iu.test(outsideEnd.message))) break;
			console.log(`attempt ${attempt} hit the plan's rate limit; waiting before the next`);
			await page.waitForTimeout(70_000);
		}
		console.log(`what the real AI answered (${outside.label}): ${JSON.stringify(outsideEnd).slice(0, 900)}`);
		const answered = outsideEnd?.type === "result";
		check(`${outside.label}: the real AI answered (not an error)`, answered, JSON.stringify(outsideEnd).slice(0, 200));
		check(`${outside.label}: the real AI did not claim a repair for a cause it cannot reach`, answered && outsideEnd.result.status !== "fixed", answered ? outsideEnd.result.status : "");
		check(`${outside.label}: the real AI gave no button, since no Dazzi setting is the fix`, answered && outsideEnd.result.actions.length === 0, answered ? JSON.stringify(outsideEnd.result.actions) : "");
		check(`${outside.label}: the real AI changed nothing in the config`, JSON.parse(readFileSync(CONFIG, "utf8")).searchPaths[0] === REPORTS && answered && outsideEnd.result.changes.length === 0);
	}
} finally {
	await app.close().catch(() => undefined);
	service.close();
	try {
		rmSync(WORK, { recursive: true, force: true });
	} catch {
		console.log(`cleanup: ${WORK} stayed behind`);
	}
}

console.log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
process.exitCode = failures.length === 0 ? 0 : 1;
