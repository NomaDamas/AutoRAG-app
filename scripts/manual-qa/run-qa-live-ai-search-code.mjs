// Live end-to-end: a real model answers a question with fenced code blocks,
// and the real app must colour them by language.
//
// Same harness as run-qa-dazzi-login-ai-search.mjs: a fresh profile signs in
// through a loopback stand-in for the Dazzi web sign-in, and every `/v1/*` call is
// forwarded unchanged to the live Dazzi API, so the answer is the model's own
// output (not a seeded string). The account key comes from QA_DAZZI_TOKEN, else
// from the `dazzi` entry of the developer's `~/.pi/agent/auth.json`; it is only
// handed to the throwaway profile. Run `bun run build` first, then on this
// machine (the key is not forwarded into a VM):
//
//   bun scripts/manual-qa/run-qa-live-ai-search-code.mjs
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";

const REAL_API = "https://api.dazziapp.com";
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-ai-search-code");
mkdirSync(EVIDENCE, { recursive: true });

// QA_OPENROUTER_MODEL=<id> runs the same scenario against that OpenRouter model instead of the Dazzi plan (no Dazzi
// account needed). Pick an LLM from OpenRouter's live catalog, https://openrouter.ai/api/v1/models, never from memory.
const OPENROUTER_MODEL = process.env.QA_OPENROUTER_MODEL?.trim() || "";

function realToken() {
	const [provider, envName, field] = OPENROUTER_MODEL === "" ? ["dazzi", "QA_DAZZI_TOKEN", "access"] : ["openrouter", "QA_OPENROUTER_KEY", "access"];
	const fromEnv = process.env[envName]?.trim();
	if (fromEnv) return fromEnv;
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	if (!existsSync(authPath)) return null;
	try {
		const entry = JSON.parse(readFileSync(authPath, "utf8"))[provider];
		return typeof entry?.[field] === "string" && entry[field].length > 0 ? entry[field] : null;
	} catch {
		return null;
	}
}

const TOKEN = realToken();
if (TOKEN === null) {
	console.error(
		OPENROUTER_MODEL === ""
			? "A Dazzi account key is required: set QA_DAZZI_TOKEN or sign in to Dazzi on this machine."
			: "An OpenRouter key is required: set QA_OPENROUTER_KEY or add one to ~/.pi/agent/auth.json.",
	);
	process.exit(2);
}

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

const WORK = mkdtempSync(join(tmpdir(), "autorag-qa-live-code-"));
const AGENT_DIR = join(WORK, "pi-agent");
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const DOCS = join(WORK, "docs");
mkdirSync(DOCS, { recursive: true });
// pi's bash tool refuses to run from a missing working directory; onboarding creates the workspace in a real profile.
mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(join(AUTORAG_HOME, "bin"), { recursive: true });
const minsyncStub = join(AUTORAG_HOME, "bin", "minsync");
writeFileSync(minsyncStub, "#!/bin/sh\nexit 0\n");
chmodSync(minsyncStub, 0o755);
writeFileSync(
	join(DOCS, "backup-guide.txt"),
	[
		"백업 가이드",
		"백업은 rsync로 한다: rsync -av --delete ~/Documents /Volumes/backup/Documents",
		"백업 설정 파일 backup.json 예시: {\"source\": \"~/Documents\", \"target\": \"/Volumes/backup/Documents\", \"keepDays\": 14, \"verify\": true}",
		"요약 파이썬 스크립트 예시: def backup(source, target): return run_rsync(source, target)",
		"",
	].join("\n"),
);
writeFileSync(
	CONFIG,
	`${JSON.stringify({ searchPaths: [DOCS], workspacePath: join(WORK, "workspace"), memoryPath: join(WORK, "memory.json"), minSync: { enabled: true, autoInstall: true, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } }, jikji: false, ...(OPENROUTER_MODEL === "" ? {} : { jev: false, webSearch: false, queryDecomposition: false }) }, null, 2)}\n`,
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
	PATH: `${join(AUTORAG_HOME, "bin")}:${process.env.PATH ?? ""}`,
	OPENROUTER_API_KEY: OPENROUTER_MODEL === "" ? "" : TOKEN,
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
};

const app = await launchFinder({ userDataDir: join(WORK, "user-data"), env });
let page = null;
try {
	page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(30_000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
	await app.evaluate(({ shell }) => {
		shell.openExternal = async (url) => {
			await fetch(url);
		};
	});

	const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
	if (OPENROUTER_MODEL === "") {
		const status = await page.evaluate(() => window.autorag.account.signIn());
		check("Dazzi sign-in completes", status.state === "signedIn", `${status.state} ${status.error ?? ""}`);
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
	} else {
		cfg.model = {
			provider: "openrouter-qa",
			id: OPENROUTER_MODEL,
			name: OPENROUTER_MODEL,
			baseUrl: "https://openrouter.ai/api/v1",
			api: "openai-completions",
			apiKeyEnv: "OPENROUTER_API_KEY",
			reasoning: false,
			input: ["text"],
			contextWindow: 262144,
			maxTokens: 16000,
		};
	}
	console.log(`model: ${OPENROUTER_MODEL === "" ? "z-ai/glm-5.3-flash" : `${OPENROUTER_MODEL} (OpenRouter)`}`);
	writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`);

	await openAiSearch(page);
	await page.fill(
		'textarea[aria-label="Ask Dazzi"]',
		"backup-guide.txt를 근거로 백업 방법을 설명해줘. 실행 명령은 ```bash 코드블럭, backup.json 설정 예시는 ```json 코드블럭, 파이썬 스크립트 예시는 ```python 코드블럭으로 각각 언어 태그를 붙여서 보여줘.",
	);
	await page.keyboard.press("Enter");
	// The model may read the guide with a shell command; the file-change gate then shows an approval card. Allow it: this lane checks rendering.
	const finished = () =>
		page.evaluate(() => {
			const input = document.querySelector('textarea[aria-label="Ask Dazzi"]');
			const done = input !== null && document.querySelector('button[aria-label="Stop"]') === null && document.querySelector(".user-msg") !== null;
			return done || Boolean(document.querySelector(".ai .text-danger-text")?.textContent);
		});
	const deadline = Date.now() + 240_000;
	let approvals = 0;
	while (!(await finished())) {
		if (Date.now() > deadline) throw new Error("the answer did not finish within 240s");
		const allow = page.locator('[role="alertdialog"] button', { hasText: "Allow once" });
		if ((await allow.count()) > 0) {
			approvals += 1;
			await allow.first().click();
		}
		await page.waitForTimeout(500);
	}
	console.log(`approval cards allowed: ${approvals}`);
	const error = (await page.locator(".ai .text-danger-text").first().textContent({ timeout: 1000 }).catch(() => null)) ?? "";
	check("AI Search shows no error", error === "", error);

	const proses = page.locator(".assistant-msg .assistant-prose");
	const count = await proses.count();
	const blocks = [];
	let raw = "";
	for (let index = 0; index < count; index += 1) {
		const prose = proses.nth(index);
		raw += `${await prose.innerText()}\n`;
		for (const pre of await prose.locator("pre").all()) {
			blocks.push({
				text: (await pre.textContent()) ?? "",
				language: await pre.getAttribute("data-language"),
				tokens: await pre.locator('[class^="hljs-"], [class*=" hljs-"]').count(),
			});
		}
	}
	await page.screenshot({ path: join(EVIDENCE, "live-answer-code.png") });
	console.log(`model answer (rendered text): ${raw.replace(/\s+/g, " ").slice(0, 500)}`);
	console.log(`code blocks: ${JSON.stringify(blocks.map((block) => ({ language: block.language, tokens: block.tokens, text: block.text.slice(0, 60) })))}`);
	check("the model's fences render as code blocks", blocks.length >= 1, `blocks=${blocks.length}`);
	check("no literal ``` fence marker is printed", !/```/u.test(raw));
	const tagged = blocks.filter((block) => block.language !== null);
	check("the model tagged at least one fence with a language", tagged.length >= 1, JSON.stringify(tagged.map((block) => block.language)));
	// Grammars with rich token sets must colour every block; a bare shell command (`rsync -av a b`) has no token highlight.js marks.
	const rich = tagged.filter((block) => /^(?:json|python|py|javascript|js|typescript|ts)$/u.test(block.language));
	check("every json / python block the model wrote is coloured", rich.length >= 1 && rich.every((block) => block.tokens > 0), JSON.stringify(rich.map((block) => [block.language, block.tokens])));
	const coloured = blocks.filter((block) => block.tokens > 0);
	check("at least one block carries highlight tokens", coloured.length >= 1, `coloured=${coloured.length}`);
	check("a coloured block still holds the source (rsync / keepDays / def backup)", coloured.some((block) => /rsync|keepDays|def backup/u.test(block.text)), coloured.map((block) => block.text.slice(0, 40)).join(" | "));
} catch (error) {
	check("run completed", false, String(error).slice(0, 500));
	if (page !== null) {
		await page.screenshot({ path: join(EVIDENCE, "live-failure.png") }).catch(() => undefined);
		console.log(`panel text at failure: ${((await page.locator("body").innerText().catch(() => "")) ?? "").replace(/\s+/g, " ").slice(0, 600)}`);
	}
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
