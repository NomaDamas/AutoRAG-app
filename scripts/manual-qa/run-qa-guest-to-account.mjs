// Live end-to-end: a signed-out launch answers on an anonymous guest key, and the
// moment the person signs in, every later request (model, Jev, rerank, decomposition)
// must carry the account key, in the SAME chat whose agent was built on the guest key.
//
// The real app runs on an empty profile (empty Pi agent dir, no provider key). A loopback
// stand-in sits in front of the live Dazzi API:
//   - `/api/desktop/guest` and every `/v1/*` call are forwarded unchanged, so the guest key is a
//     real one and the models answer for real;
//   - the browser sign-in step is replaced (`/desktop/authorize` redirects back with a code,
//     `/api/desktop/token` hands out the account key), and from then on the stand-in answers 401
//     to any `dzg_` key, as the server does once it carries the guest's usage onto the account.
// The account key comes from QA_DAZZI_TOKEN, else the developer's own `~/.pi/agent/auth.json`; it is
// only handed to the throwaway profile. Run `bun run build` first. Host-only: the VM has no key.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";
import { rmRetry } from "./platform.mjs";

const REAL_API = "https://api.dazziapp.com";
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/guest-to-account");
mkdirSync(EVIDENCE, { recursive: true });

function realToken() {
	const fromEnv = process.env.QA_DAZZI_TOKEN?.trim();
	if (fromEnv) return fromEnv;
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	if (!existsSync(authPath)) return null;
	try {
		const access = JSON.parse(readFileSync(authPath, "utf8")).dazzi?.access;
		return typeof access === "string" && access.startsWith("dz_") ? access : null;
	} catch {
		return null;
	}
}
const TOKEN = realToken();
if (TOKEN === null) {
	console.error("An account key (dz_…) is required: set QA_DAZZI_TOKEN or sign in to Dazzi on this machine.");
	process.exit(2);
}

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

const WORK = mkdtempSync(join(tmpdir(), "autorag-qa-guest-to-account-"));
const AGENT_DIR = join(WORK, "pi-agent");
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const DOCS = join(WORK, "docs");
mkdirSync(DOCS, { recursive: true });
mkdirSync(join(AUTORAG_HOME, "bin"), { recursive: true });
const minsyncStub = join(AUTORAG_HOME, "bin", "minsync");
mkdirSync(join(WORK, "workspace"), { recursive: true });
writeFileSync(minsyncStub, "#!/bin/sh\nexit 0\n");
chmodSync(minsyncStub, 0o755);
writeFileSync(join(DOCS, "refund-policy.txt"), "환불 예외(exception)는 지급 전 반드시 임원(director) 승인이 필요하다.\n");
// A bare config: exactly what a first run holds before any model is chosen.
writeFileSync(
	CONFIG,
	`${JSON.stringify({ searchPaths: [DOCS], workspacePath: join(WORK, "workspace"), memoryPath: join(WORK, "memory.json"), minSync: { enabled: true, autoInstall: true, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } }, jikji: false }, null, 2)}\n`,
);

/** Every request the app made, in order: what it was and which kind of key it carried. */
const seen = [];
let signedIn = false;
const kindOf = (header) => {
	const bearer = String(header ?? "").replace(/^Bearer\s+/i, "");
	return bearer.startsWith("dzg_") ? "guest" : bearer.startsWith("dz_") ? "account" : bearer === "" ? "none" : "other";
};
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
		signedIn = true;
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: TOKEN }));
		return;
	}
	const key = kindOf(req.headers.authorization);
	if (signedIn && key === "guest") {
		req.resume();
		seen.push({ path: url.pathname, key, status: 401, afterSignIn: true });
		res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "This guest key was claimed by an account.", type: "invalid_request_error", code: "invalid_api_key" } }));
		return;
	}
	const entry = { path: url.pathname, key, status: 0, afterSignIn: signedIn };
	seen.push(entry);
	const headers = { ...req.headers, host: new URL(REAL_API).host };
	delete headers["accept-encoding"];
	const upstream = httpsRequest(`${REAL_API}${req.url}`, { method: req.method, headers }, (reply) => {
		entry.status = reply.statusCode ?? 502;
		res.writeHead(entry.status, reply.headers);
		reply.pipe(res);
	});
	upstream.on("error", () => {
		entry.status = 502;
		res.writeHead(502).end();
	});
	req.pipe(upstream);
});
await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${service.address().port}`;

const env = {
	AUTORAG_HOME,
	AUTORAG_CONFIG: CONFIG,
	AUTORAG_BASE_URL: baseUrl,
	// Unpackaged builds honor this: a throwaway device, so the live guest allowance of this machine is untouched.
	AUTORAG_DEV_DEVICE_SEED: `qa-guest-to-account-${Date.now()}-${Math.random()}`,
	PI_CODING_AGENT_DIR: AGENT_DIR,
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	ELECTRON_RENDERER_URL: "",
	PATH: `${join(AUTORAG_HOME, "bin")}${delimiter}${process.env.PATH ?? ""}`,
	OPENROUTER_API_KEY: "",
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
};
const readAuth = () => (existsSync(join(AGENT_DIR, "auth.json")) ? JSON.parse(readFileSync(join(AGENT_DIR, "auth.json"), "utf8")) : {});
const readConfig = () => JSON.parse(readFileSync(CONFIG, "utf8"));
const modelSide = (from) => seen.slice(from).filter((entry) => /^\/v1\/(responses|jev|rerank|chat)/.test(entry.path));

const app = await launchFinder({ userDataDir: join(WORK, "user-data"), env });
try {
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(30_000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
	await app.evaluate(({ shell }) => {
		shell.openExternal = async (url) => {
			await fetch(url);
		};
	});

	// 1. Signed out, the app provisions a guest key by itself and points the config at the plan's models.
	await page.waitForFunction(() => window.autorag.account.status().then((s) => s.state === "signedOut"), null, { timeout: 30_000 });
	const deadline = Date.now() + 45_000;
	while (Date.now() < deadline && !String(readAuth().dazzi?.access ?? "").startsWith("dzg_")) await page.waitForTimeout(500);
	check("a signed-out launch holds a guest key", String(readAuth().dazzi?.access ?? "").startsWith("dzg_"));
	await page.waitForTimeout(1500);
	check("the account status stays signed out on a guest key", (await page.evaluate(() => window.autorag.account.status())).state === "signedOut");
	check("the config now names a plan model", readConfig().model?.provider === "dazzi", JSON.stringify(readConfig().model?.id));

	// 2. A question on the guest key.
	await openAiSearch(page);
	const ask = async (text, turns) => {
		await page.fill('textarea[aria-label="Ask AI"]', text);
		await page.keyboard.press("Enter");
		await page.waitForFunction(
			(count) => document.querySelectorAll(".user-msg").length >= count && document.querySelector('button[aria-label="Stop"]') === null && document.querySelector('textarea[aria-label="Ask AI"]') !== null,
			turns,
			{ timeout: 240_000 },
		);
		const error = (await page.locator(".ai .text-danger-text").last().textContent({ timeout: 1000 }).catch(() => null)) ?? "";
		const answer = ((await page.locator(".assistant-msg .assistant-prose").allTextContents()).map((s) => s.trim()).filter(Boolean).at(-1)) ?? "";
		return { error: error.trim(), answer };
	};
	const beforeAsk = seen.length;
	const first = await ask("환불 예외는 누구 승인이 필요해?", 1);
	await page.screenshot({ path: join(EVIDENCE, "01-answer-on-guest-key.png") });
	check("the question answered on the guest key", first.error === "" && first.answer.length > 0, first.error || first.answer.slice(0, 100).replace(/\s+/g, " "));
	const guestCalls = modelSide(beforeAsk);
	check("those model-side calls carried only the guest key", guestCalls.length > 0 && guestCalls.every((entry) => entry.key === "guest"), guestCalls.map((e) => `${e.path}:${e.key}`).join(", "));

	// 3. Sign in (the live account key stands in for the real browser step).
	const status = await page.evaluate(() => window.autorag.account.signIn());
	check("sign-in completes", status.state === "signedIn", `${status.state} ${status.error ?? ""}`);
	check("auth.json holds the account key, not the guest key", String(readAuth().dazzi?.access ?? "").startsWith("dz_"));
	check("the config still names a plan model", readConfig().model?.provider === "dazzi");

	// 4. A follow-up in the SAME chat: its agent was built before sign-in.
	const afterSignIn = seen.length;
	const second = await ask("그 승인은 언제까지 받아야 해?", 2);
	await page.screenshot({ path: join(EVIDENCE, "02-follow-up-after-sign-in.png") });
	const accountCalls = modelSide(afterSignIn);
	check("the follow-up in the same chat answered", second.error === "" && second.answer.length > 0, second.error || second.answer.slice(0, 100).replace(/\s+/g, " "));
	check("the follow-up reached the model", accountCalls.length > 0, String(accountCalls.length));
	check("every later model-side call carried the account key", accountCalls.every((entry) => entry.key === "account"), accountCalls.map((e) => `${e.path}:${e.key}`).join(", "));
	const rejected = seen.filter((entry) => entry.afterSignIn && entry.status === 401);
	check("nothing was refused for carrying the old guest key", rejected.length === 0, rejected.map((e) => e.path).join(", "));

	// 5. Signing out must not leave the account key in any live agent either.
	await page.evaluate(() => window.autorag.account.signOut());
	check("signing out removes the account key from auth.json", readAuth().dazzi === undefined, JSON.stringify(Object.keys(readAuth())));
} catch (error) {
	check("run completed", false, String(error).slice(0, 500));
} finally {
	await app.close().catch(() => undefined);
	service.close();
	rmRetry(WORK);
}

if (failures.length > 0) {
	console.log(`\n${failures.length} check(s) failed: ${failures.join("; ")}`);
	process.exit(1);
}
console.log("\nall checks passed");
