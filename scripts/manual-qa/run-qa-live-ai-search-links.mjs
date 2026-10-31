// Live end-to-end: a real model answers with a markdown link and a bare URL,
// and the real app must render both as clickable links that open in the OS
// browser.
//
// Same harness as run-qa-live-ai-search-table.mjs: a fresh profile signs in
// through a loopback stand-in for the Dazzi web sign-in, and every `/v1/*` call is
// forwarded unchanged to the live Dazzi API, so the answer is the model's own
// output (not a seeded string). The account key comes from QA_DAZZI_TOKEN, else
// from the `dazzi` entry of the developer's `~/.pi/agent/auth.json`; it is only
// handed to the throwaway profile. When the Dazzi credits are used up, run the
// same model (`z-ai/glm-5.3-flash`, released 2026-08-26) through OpenRouter with
// QA_LIVE_PROVIDER=openrouter; its key comes from QA_OPENROUTER_KEY, else from
// the `openrouter` entry of the same auth file. `shell.openExternal` is replaced
// in the main process: the loopback sign-in URL is fetched, every other URL is
// recorded instead of opening a browser. Run `bun run build` first, then on this
// machine (the key is not forwarded into a VM):
//
//   bun scripts/manual-qa/run-qa-live-ai-search-links.mjs
//   QA_LIVE_PROVIDER=openrouter bun scripts/manual-qa/run-qa-live-ai-search-links.mjs
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";

const REAL_API = "https://api.dazziapp.com";
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-ai-search-links");
mkdirSync(EVIDENCE, { recursive: true });

const PROVIDER = process.env.QA_LIVE_PROVIDER === "openrouter" ? "openrouter" : "dazzi";

function realToken() {
	const fromEnv = (PROVIDER === "openrouter" ? process.env.QA_OPENROUTER_KEY : process.env.QA_DAZZI_TOKEN)?.trim();
	if (fromEnv) return fromEnv;
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	if (!existsSync(authPath)) return null;
	try {
		const entry = JSON.parse(readFileSync(authPath, "utf8"))[PROVIDER];
		return typeof entry?.access === "string" && entry.access.length > 0 ? entry.access : null;
	} catch {
		return null;
	}
}

const TOKEN = realToken();
if (TOKEN === null) {
	console.error(`A ${PROVIDER} key is required: set ${PROVIDER === "openrouter" ? "QA_OPENROUTER_KEY" : "QA_DAZZI_TOKEN"} or sign in to ${PROVIDER} on this machine.`);
	process.exit(2);
}

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

const DOCS_URL = "https://example.com/dazzi-docs";
const PRICING_URL = "https://example.com/dazzi-pricing";

const WORK = mkdtempSync(join(tmpdir(), "autorag-qa-live-links-"));
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
writeFileSync(
	join(DOCS, "links.txt"),
	["Dazzi 안내 링크 모음", `공식 문서 주소: ${DOCS_URL}`, `요금 안내 주소: ${PRICING_URL}`, ""].join("\n"),
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
	PATH: `${join(AUTORAG_HOME, "bin")}:${process.env.PATH ?? ""}`,
	OPENROUTER_API_KEY: PROVIDER === "openrouter" ? TOKEN : "",
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
};

const app = await launchFinder({ userDataDir: join(WORK, "user-data"), env });
try {
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(30_000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
	await app.evaluate(({ shell }) => {
		globalThis.__opened = [];
		shell.openExternal = async (url) => {
			if (new URL(url).hostname === "127.0.0.1") await fetch(url);
			else globalThis.__opened.push(url);
		};
	});
	const opened = () => app.evaluate(() => globalThis.__opened.slice());
	const startUrl = page.url();

	if (PROVIDER === "dazzi") {
		const status = await page.evaluate(() => window.autorag.account.signIn());
		check("Dazzi sign-in completes", status.state === "signedIn", `${status.state} ${status.error ?? ""}`);
	}

	const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
	cfg.model =
		PROVIDER === "openrouter"
			? {
					provider: "openrouter",
					id: "z-ai/glm-5.3-flash",
					name: "GLM 5.3 Flash",
					baseUrl: "https://openrouter.ai/api/v1",
					api: "openai-completions",
					reasoning: true,
					input: ["text"],
					contextWindow: 1048576,
					maxTokens: 32000,
				}
			: {
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
	await page.fill(
		'textarea[aria-label="Ask Dazzi"]',
		"links.txt를 근거로 Dazzi 공식 문서 주소와 요금 안내 주소를 알려줘. 공식 문서는 마크다운 링크 [제목](주소) 형식으로, 요금 안내는 주소 자체를 그대로 한 줄에 써줘.",
	);
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
	let raw = "";
	for (let index = 0; index < count; index += 1) raw += `${await proses.nth(index).innerText()}\n`;
	await page.screenshot({ path: join(EVIDENCE, "live-answer-links.png") });
	console.log(`model answer (rendered text): ${raw.replace(/\s+/g, " ").slice(0, 500)}`);

	const links = proses.locator("a");
	const found = await links.evaluateAll((nodes) => nodes.map((node) => ({ href: node.getAttribute("href"), text: node.textContent })));
	console.log(`links in the answer: ${JSON.stringify(found)}`);
	const hrefs = found.map((link) => link.href);
	check("the answer holds the docs link as an <a>", hrefs.includes(DOCS_URL), JSON.stringify(hrefs));
	check("the answer holds the pricing link as an <a>", hrefs.includes(PRICING_URL), JSON.stringify(hrefs));
	check("no link points anywhere but the two source URLs", hrefs.every((href) => href === DOCS_URL || href === PRICING_URL), JSON.stringify(hrefs));
	check("no markdown link to a web URL is printed as text", !/\]\(\s*<?https?:\/\//u.test(raw), raw.replace(/\s+/g, " ").slice(0, 200));
	check("a link with a label shows the label, not the markdown", found.some((link) => link.text !== link.href && !(link.text ?? "").includes("](")), JSON.stringify(found));

	const target = hrefs.indexOf(PRICING_URL) === -1 ? 0 : hrefs.indexOf(PRICING_URL);
	await links.nth(target).click();
	const afterClick = await opened();
	check("clicking a link hands its URL to the OS browser", afterClick.at(-1) === hrefs[target], JSON.stringify(afterClick));
	check("the Finder window did not navigate", page.url() === startUrl, page.url());
	await page.screenshot({ path: join(EVIDENCE, "live-answer-links-clicked.png") });
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
