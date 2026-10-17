// Live end-to-end: a fresh profile that only signed in to Dazzi must be able to
// run AI Search with no other provider configured.
//
// The real app is launched on an empty profile (empty Pi agent dir, no provider
// key in the environment) and signs in through its real account service. The
// browser step is replaced by a loopback stand-in for the Dazzi web sign-in
// (`/desktop/authorize` redirects straight back with a code, `/api/desktop/token`
// hands out a real account key); every `/v1/*` call is forwarded unchanged to the
// live Dazzi API, so the model answers for real.
//
// The account key comes from QA_DAZZI_TOKEN, else from the `dazzi` entry of the
// developer's own `~/.pi/agent/auth.json`; it is read at run time and only ever
// handed to the throwaway profile. Run `bun run build` first.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";

const REAL_API = "https://api.dazziapp.com";
const EVIDENCE = join(ROOT, ".omo/evidence/dazzi-login-ai-search");
mkdirSync(EVIDENCE, { recursive: true });

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

const WORK = mkdtempSync(join(tmpdir(), "autorag-qa-dazzi-login-"));
const AGENT_DIR = join(WORK, "pi-agent");
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const DOCS = join(WORK, "docs");
mkdirSync(DOCS, { recursive: true });
mkdirSync(AUTORAG_HOME, { recursive: true });
writeFileSync(join(DOCS, "refund-policy.txt"), "환불 예외(exception)는 지급 전 반드시 임원(director) 승인이 필요하다.\n");
// A bare config: exactly what a first run holds before sign-in picks the plan's models.
writeFileSync(
	CONFIG,
	`${JSON.stringify({ searchPaths: [DOCS], workspacePath: join(WORK, "workspace"), memoryPath: join(WORK, "memory.json"), minSync: { enabled: true, autoInstall: true, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } }, jikji: false }, null, 2)}\n`,
);

// Loopback stand-in for the Dazzi service.
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
	forwarded.push(`${req.method} ${url.pathname}`);
	const upstream = httpsRequest(`${REAL_API}${req.url}`, { method: req.method, headers }, (reply) => {
		res.writeHead(reply.statusCode ?? 502, reply.headers);
		reply.pipe(res);
	});
	upstream.on("error", () => res.writeHead(502).end());
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
	// No other provider: a stray key in the developer's shell must not mask the bug.
	OPENROUTER_API_KEY: "",
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
};

const app = await launchFinder({ userDataDir: join(WORK, "user-data"), env });
try {
	app.process().stderr?.on("data", (chunk) => {
		const text = String(chunk).trim();
		if (/\[account\]|\[providers\]|No API key/.test(text)) console.log(`[main:err] ${text.slice(0, 300)}`);
	});
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(30_000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));

	// The browser step: follow the authorize redirect ourselves.
	await app.evaluate(({ shell }) => {
		shell.openExternal = async (url) => {
			await fetch(url);
		};
	});

	const signedOut = await page.evaluate(() => window.autorag.account.status());
	check("fresh profile starts signed out", signedOut.state === "signedOut", signedOut.state);
	const before = existsSync(join(AGENT_DIR, "auth.json")) ? JSON.parse(readFileSync(join(AGENT_DIR, "auth.json"), "utf8")) : {};
	check("fresh profile has no Pi credential", Object.keys(before).length === 0, JSON.stringify(Object.keys(before)));

	const status = await page.evaluate(() => window.autorag.account.signIn());
	check("Dazzi sign-in completes", status.state === "signedIn", `${status.state} ${status.error ?? ""}`);
	const auth = existsSync(join(AGENT_DIR, "auth.json")) ? JSON.parse(readFileSync(join(AGENT_DIR, "auth.json"), "utf8")) : {};
	check("sign-in leaves only the Dazzi credential", JSON.stringify(Object.keys(auth)) === '["dazzi"]', JSON.stringify(Object.keys(auth)));

	await openAiSearch(page);
	await page.fill('input[aria-label="Ask Dazzi"]', "환불 예외는 누구 승인이 필요해?");
	await page.keyboard.press("Enter");
	const finished = () => {
		const input = document.querySelector('input[aria-label="Ask Dazzi"]');
		const done = input !== null && document.querySelector('button[aria-label="Stop"]') === null && document.querySelector(".user-msg") !== null;
		return done || document.querySelector(".ai .text-danger-text")?.textContent;
	};
	await page.waitForFunction(finished, null, { timeout: 240_000 });
	const error = (await page.locator(".ai .text-danger-text").first().textContent({ timeout: 1000 }).catch(() => null)) ?? "";
	await page.screenshot({ path: join(EVIDENCE, "ai-search-after-dazzi-login.png") });
	const answer = (await page.locator(".assistant-msg .assistant-prose").allTextContents()).join("\n").trim();
	check("AI Search shows no credential error", !/No API key|\/login/.test(error), error || "no error");
	check("AI Search answered", answer.length > 0, `${answer.length} chars: ${answer.slice(0, 120).replace(/\s+/g, " ")}`);
	check("the model request went through the Dazzi service", forwarded.some((entry) => entry.startsWith("POST /v1/")), forwarded.slice(-4).join(", "));
} catch (error) {
	check("run completed", false, String(error).slice(0, 500));
} finally {
	await app.close().catch(() => undefined);
	service.close();
}

if (failures.length > 0) {
	console.log(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
