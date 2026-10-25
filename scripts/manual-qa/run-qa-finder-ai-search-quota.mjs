/**
 * Manual QA — an AI Search question on a Dazzi account whose weekly credits are used up, in the real app.
 *
 * A loopback stand-in for the Dazzi service signs the profile in and reports an account over its weekly
 * credit limit (as GET /v1/account does for a real exhausted account); every model-side request is recorded
 * and answered 429 `insufficient_quota`, as the real server does. No account key and no network are needed.
 *
 *   1. the question is refused before any model-side request leaves the app (no /v1/responses, no /v1/jev);
 *   2. the panel says so in plain words, with the server's reset time rather than a guessed Monday;
 *   3. a button in that notice opens Settings on "Subscription & Usage", where the usage meter is full and the
 *      reset time is the same instant.
 *
 * POSIX only (a shell stub for MinSync): not part of run-all.mjs. Prereq: bun run build.
 *   bun run qa script scripts/manual-qa/run-qa-finder-ai-search-quota.mjs
 */
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { AI_PANEL, finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";
import { rmRetry } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/qa-ai-search-quota");
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

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-quota-"));
const AGENT_DIR = join(WORK, "pi-agent");
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const DOCS = join(WORK, "docs");
mkdirSync(DOCS, { recursive: true });
mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(join(AUTORAG_HOME, "bin"), { recursive: true });
const minsyncStub = join(AUTORAG_HOME, "bin", "minsync");
writeFileSync(minsyncStub, "#!/bin/sh\nexit 0\n");
chmodSync(minsyncStub, 0o755);
writeFileSync(join(DOCS, "a.txt"), "hello\n");

// A Tuesday 07:15 UTC: the server's week starts when the account's period did, so the instant is not a Monday 00:00.
const RESETS_AT = "2026-10-27T07:15:01.883Z";
const ACCOUNT = {
	email: "qa@example.com",
	plan: "free",
	status: "active",
	trialing: false,
	cancel_scheduled: false,
	period_end: null,
	credits: { used_cents: 50.753824, limit_cents: 50, period: "2026-10-20T07:15:01.883Z", resets_at: RESETS_AT },
	limits: { requests_per_minute: 10 },
	embeddings: false,
	billing: { air: true, pro: true, max: true, portal: false },
};
const modelSide = [];
const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	req.resume();
	const json = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
	if (url.pathname === "/desktop/authorize") {
		const target = new URL(url.searchParams.get("redirect_uri"));
		target.searchParams.set("code", "qa-code");
		target.searchParams.set("state", url.searchParams.get("state"));
		res.writeHead(302, { location: target.toString() }).end();
		return;
	}
	if (url.pathname === "/api/desktop/token") return json(200, { access_token: "dz_qa_key" });
	if (url.pathname === "/v1/account") return json(200, ACCOUNT);
	if (url.pathname === "/v1/models") return json(200, { object: "list", data: [] });
	modelSide.push(`${req.method} ${url.pathname}`);
	return json(429, { error: { message: "Weekly usage quota exceeded", type: "insufficient_quota", code: "insufficient_quota" } });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;
writeFileSync(
	CONFIG,
	`${JSON.stringify(
		{
			searchPaths: [DOCS],
			workspacePath: join(WORK, "workspace"),
			memoryPath: join(WORK, "memory.json"),
			minSync: { enabled: true, autoInstall: false, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } },
			jikji: false,
			model: { provider: "dazzi", id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", baseUrl: `${BASE}/v1`, api: "openai-responses", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 32000 },
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

app = await launchFinder({
	userDataDir: join(WORK, "user-data"),
	env: {
		AUTORAG_HOME,
		AUTORAG_CONFIG: CONFIG,
		AUTORAG_BASE_URL: BASE,
		PI_CODING_AGENT_DIR: AGENT_DIR,
		AUTORAG_SKIP_DUPEY_CHECK: "1",
		ELECTRON_RENDERER_URL: "",
		PATH: `${join(AUTORAG_HOME, "bin")}${delimiter}${process.env.PATH ?? ""}`,
		OPENROUTER_API_KEY: "",
		OPENAI_API_KEY: "",
		ANTHROPIC_API_KEY: "",
	},
});
const page = await finderWindow(app, 30_000);
page.setDefaultTimeout(20_000);
page.on("pageerror", (error) => log(`[pageerror] ${String(error).slice(0, 300)}`));
await app.evaluate(({ shell }) => {
	shell.openExternal = async (url) => {
		await fetch(url);
	};
});
const shot = async (name) => {
	await page.waitForTimeout(450);
	await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
};

const status = await page.evaluate(() => window.autorag.account.signIn());
check("the stand-in service signs the profile in", status.state === "signedIn", `${status.state} ${status.error ?? ""}`);
const account = await page.evaluate(() => window.autorag.account.status());
check("the app read the server's reset time", account.account?.creditsResetsAt === RESETS_AT, String(account.account?.creditsResetsAt));
modelSide.length = 0;

await openAiSearch(page);
const panel = page.locator(AI_PANEL);
await panel.locator('input[aria-label="Ask Dazzi"]').click();
await page.keyboard.type("what does a.txt say?");
await page.keyboard.press("Enter");
const notice = panel.locator(".text-danger-text", { hasText: "credits are used up" });
await notice.waitFor();
const text = await notice.innerText();

const resetsText = await page.evaluate((iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }), RESETS_AT);
check("the notice says nothing was sent and names the server's reset time", /nothing was sent/.test(text) && text.includes(resetsText), `${text.replace(/\s+/g, " ").slice(0, 200)} | expected ${resetsText}`);
check("no request reached the model side (no model call, no judgment-model call)", modelSide.length === 0, JSON.stringify(modelSide));
check("the run ended: the message box is idle again", (await panel.locator('button[aria-label="Stop"]').count()) === 0 && (await panel.locator('input[aria-label="Ask Dazzi"]').count()) === 1);
const button = panel.getByRole("button", { name: "Open Subscription & Usage" });
check("the notice offers a button to Subscription & Usage", (await button.count()) === 1);
await shot("01-quota-notice");

await button.click();
await page.waitForSelector(".settings-meter", { timeout: 20_000 });
const meter = await page.locator(".settings-meter").getAttribute("aria-valuenow");
check("the button opens Settings on the plan page, with the usage meter full", meter === "100", `aria-valuenow=${meter}`);
const planText = await page.locator("body").innerText();
check("the plan page shows the same reset instant, not a calendar guess", planText.includes(resetsText), resetsText);
await shot("02-plan-page");

// The question's own tab keeps its chat while Settings is in front: the notice is still there when the person goes back.
check("the AI Search tab keeps the notice while Settings is open", (await page.locator('section[aria-label="AI Search"]', { hasText: "credits are used up" }).count()) === 1);
check("nothing was sent at any point", modelSide.length === 0, JSON.stringify(modelSide));

log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
await app?.close().catch(() => undefined);
sweep(true);
process.exitCode = failures.length === 0 ? 0 : 1;
