// Live end-to-end: a screenshot on the OS clipboard is pasted into the AI Agent tab and into the right sidebar chat,
// sent with Enter, and a real vision model describes the picture it was given.
//
// Same harness as run-qa-live-ai-search-table.mjs: a fresh profile signs in through a loopback stand-in for the
// Dazzi web sign-in, and every `/v1/*` call is forwarded unchanged to the live Dazzi API, so the answer is the
// model's own output. The account key comes from QA_DAZZI_TOKEN, else from the `dazzi` entry of the developer's
// `~/.pi/agent/auth.json`; it is only handed to the throwaway profile. Run `bun run build` first, then on this
// machine (the key is not forwarded into a VM):
//
//   bun scripts/manual-qa/run-qa-live-ai-chat-paste-image.mjs
//
// macOS only: the clipboard is set with osascript, so it overwrites the developer's clipboard.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { AI_PANEL, finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";
import { chord } from "./platform.mjs";

const REAL_API = "https://api.dazziapp.com";
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-ai-chat-paste-image");
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

const WORK = mkdtempSync(join(tmpdir(), "autorag-qa-live-composer-"));
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

// A solid red picture: a vision model that really receives it can only answer "red".
const RED = join(WORK, "red.png");
execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=red:s=480x320", "-frames:v", "1", RED], { stdio: "ignore" });
const copyImage = () => execFileSync("osascript", ["-e", `set the clipboard to (read (POSIX file ${JSON.stringify(RED)}) as «class PNGf»)`]);
const redIn = (text) => /red|빨간|빨강|적색/iu.test(text);

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

	// AI Agent tab.
	await openAiSearch(page);
	const panel = page.locator(AI_PANEL);
	const field = panel.locator('textarea[aria-label="Ask Dazzi"]');
	copyImage();
	await field.click();
	await page.keyboard.press(chord("V"));
	await panel.locator(".composer-attach-pill").first().waitFor();
	check("the pasted screenshot is an attachment pill", (await panel.locator(".composer-attach-pill").count()) === 1);
	await page.keyboard.insertText("첨부한 이미지는 단색이야. 무슨 색인지 한 단어로만 답해줘. 파일을 검색하지 마.");
	await page.screenshot({ path: join(EVIDENCE, "live-01-tab-pasted.png") });
	await page.keyboard.press("Enter");
	await page.waitForFunction(
		(sel) => document.querySelector(`${sel} button[aria-label="Stop"]`) === null && document.querySelector(`${sel} .assistant-prose`) !== null,
		AI_PANEL,
		{ timeout: 240_000 },
	);
	const tabAnswer = (await panel.locator(".assistant-prose").allInnerTexts()).join(" ");
	console.log(`tab answer: ${tabAnswer.replace(/\s+/g, " ").slice(0, 300)}`);
	check("the real model saw the pasted picture (answers its colour)", redIn(tabAnswer), tabAnswer.slice(0, 200));
	check("no error shown in the tab", (await panel.getByText("Something went wrong").count()) === 0);
	await page.screenshot({ path: join(EVIDENCE, "live-02-tab-answered.png") });

	// Right sidebar chat.
	await page.locator(".sidebar__item", { hasText: "Documents" }).first().click();
	const dock = page.locator(".inspector-chat-dock textarea");
	await dock.waitFor();
	copyImage();
	await dock.click();
	await page.keyboard.press(chord("V"));
	await page.locator(".inspector-chat-composer .inspector-chat-att").first().waitFor();
	await page.keyboard.insertText("첨부한 이미지는 단색이야. 무슨 색인지 한 단어로만 답해줘. 파일을 검색하지 마.");
	await page.screenshot({ path: join(EVIDENCE, "live-03-sidebar-pasted.png") });
	await page.keyboard.press("Enter");
	await page.locator(".inspector-chat").waitFor();
	await page.waitForFunction(
		() => document.querySelector('.inspector-chat button[aria-label="Stop"]') === null && (document.querySelector(".inspector-chat")?.textContent ?? "").length > 40 && document.querySelector(".inspector-chat .inspector-chat-question") !== null,
		null,
		{ timeout: 240_000 },
	);
	await page.waitForTimeout(1500);
	const sideAnswer = await page.locator(".inspector-chat").innerText();
	console.log(`sidebar chat: ${sideAnswer.replace(/\s+/g, " ").slice(0, 400)}`);
	check("the real model saw the pasted picture in the sidebar chat", redIn(sideAnswer.replace(/첨부한 이미지는 단색이야\. 무슨 색인지 한 단어로만 답해줘\./u, "")), sideAnswer.slice(0, 200));
	await page.screenshot({ path: join(EVIDENCE, "live-04-sidebar-answered.png") });
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
