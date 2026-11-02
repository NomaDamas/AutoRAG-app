// Live end-to-end: a real model answers a question with a markdown pipe table,
// and the real app must render it as a table.
//
// Same harness as run-qa-dazzi-login-ai-search.mjs: a fresh profile signs in
// through a loopback stand-in for the Dazzi web sign-in, and every `/v1/*` call is
// forwarded unchanged to the live Dazzi API, so the answer is the model's own
// output (not a seeded string). The account key comes from QA_DAZZI_TOKEN, else
// from the `dazzi` entry of the developer's `~/.pi/agent/auth.json`; it is only
// handed to the throwaway profile. Run `bun run build` first, then on this
// machine (the key is not forwarded into a VM):
//
//   bun scripts/manual-qa/run-qa-live-ai-search-table.mjs
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";

const REAL_API = "https://api.dazziapp.com";
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-ai-search-table");
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

const WORK = mkdtempSync(join(tmpdir(), "autorag-qa-live-table-"));
const AGENT_DIR = join(WORK, "pi-agent");
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const DOCS = join(WORK, "docs");
mkdirSync(DOCS, { recursive: true });
mkdirSync(join(AUTORAG_HOME, "bin"), { recursive: true });
const minsyncStub = join(AUTORAG_HOME, "bin", "minsync");
writeFileSync(minsyncStub, "#!/bin/sh\nexit 0\n");
chmodSync(minsyncStub, 0o755);
writeFileSync(
	join(DOCS, "plans.txt"),
	["요금제 안내", "Free 플랜: 월 0원, 사용자 1명, 저장공간 5GB.", "Pro 플랜: 월 20,000원, 사용자 5명, 저장공간 100GB.", "Team 플랜: 월 80,000원, 사용자 30명, 저장공간 1TB.", ""].join("\n"),
);
writeFileSync(
	CONFIG,
	`${JSON.stringify({ searchPaths: [DOCS], workspacePath: join(WORK, "workspace"), memoryPath: join(WORK, "memory.json"), minSync: { enabled: true, autoInstall: true, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } }, jikji: false }, null, 2)}\n`,
);

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
	PATH: `${join(AUTORAG_HOME, "bin")}${delimiter}${process.env.PATH ?? ""}`,
	OPENROUTER_API_KEY: "",
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
};

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

	const status = await page.evaluate(() => window.autorag.account.signIn());
	check("Dazzi sign-in completes", status.state === "signedIn", `${status.state} ${status.error ?? ""}`);

	const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
	cfg.model = {
		provider: "dazzi",
		id: "z-ai/glm-5.3-flash",
		name: "GLM 5.3 Flash",
		baseUrl: `${baseUrl}/v1`,
		api: "openai-responses",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 32000,
	};
	writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`);

	await openAiSearch(page);
	await page.fill('textarea[aria-label="Ask Dazzi"]', "plans.txt를 근거로 Free, Pro, Team 플랜의 월 요금, 사용자 수, 저장공간을 마크다운 표(| 로 구분하는 표)로 정리해줘.");
	await page.keyboard.press("Enter");
	await page.waitForFunction(
		() => {
			const input = document.querySelector('textarea[aria-label="Ask Dazzi"]');
			const done = input !== null && document.querySelector('button[aria-label="Stop"]') === null && document.querySelector(".user-msg") !== null;
			return done || document.querySelector(".ai .text-danger-text")?.textContent;
		},
		null,
		{ timeout: 240_000 },
	);
	const error = (await page.locator(".ai .text-danger-text").first().textContent({ timeout: 1000 }).catch(() => null)) ?? "";
	check("AI Search shows no error", error === "", error);

	const proses = page.locator(".assistant-msg .assistant-prose");
	const count = await proses.count();
	let tables = 0;
	let literal = false;
	let raw = "";
	for (let index = 0; index < count; index += 1) {
		const prose = proses.nth(index);
		tables += await prose.locator("table").count();
		const text = await prose.innerText();
		raw += `${text}\n`;
		if (/^\s*\|?\s*:?-{3,}:?\s*\|/mu.test(text) || /\|\s*(?:Free|Pro|Team)\b.*\|/u.test(text)) literal = true;
	}
	await page.screenshot({ path: join(EVIDENCE, "live-answer-table.png") });
	console.log(`model answer (rendered text): ${raw.replace(/\s+/g, " ").slice(0, 400)}`);
	check("the model's markdown table renders as a <table>", tables >= 1, `tables=${tables}`);
	check("no literal pipe/delimiter rows are printed", !literal);
	const cells = tables === 0 ? [] : await proses.locator("table td, table th").allTextContents();
	const joined = cells.join(" ");
	check("the table carries the plan data", /Free/u.test(joined) && /Pro/u.test(joined) && /Team/u.test(joined) && /20,?000/u.test(joined), joined.slice(0, 200));
} catch (error) {
	check("run completed", false, String(error).slice(0, 500));
} finally {
	await app.close().catch(() => undefined);
	service.close();
	rmSync(WORK, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.log(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
