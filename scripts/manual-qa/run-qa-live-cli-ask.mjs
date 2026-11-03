// Live end-to-end for `dazzi --ask` (build/cli/dazzi): a question typed in a terminal (or sent by the Raycast
// extension, which runs this same launcher) opens a new AI Search tab in the running app, is sent at once with
// the given files attached, and a real model answers it from them. Proves:
//   1. `dazzi --ask "..." docs/plans.txt` against the RUNNING app: a new AI tab, the question in the sent
//      bubble, plans.txt as its attachment chip, and an answer that uses the file (Pro = 20,000원);
//   2. a second `--ask` while a tab exists opens another tab rather than reusing the answered one;
//   3. `--ask` without a question exits 2 and changes nothing;
//   4. a cold start (`--ask` with no app running) starts the app and asks on first load.
//
// The launcher is the shipped script, copied into a stand-in `Dazzi.app` whose executable starts this checkout's
// Electron. Sign-in is the live-composer harness: a loopback stand-in for the Dazzi web sign-in, every `/v1/*`
// call forwarded unchanged to the live Dazzi API. The key comes from QA_DAZZI_TOKEN, else the `dazzi` entry of
// `~/.pi/agent/auth.json`; it only reaches the throwaway profile. macOS only. Run `bun run build` first, then:
//
//   bun scripts/manual-qa/run-qa-live-cli-ask.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { homeEnv, isMac } from "./platform.mjs";

if (!isMac) {
	console.log("SKIP live-cli-ask: the shell launcher is macOS-only");
	process.exit(0);
}

const REAL_API = "https://api.dazziapp.com";
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-cli-ask");
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (probe, timeoutMs = 20_000) => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe().catch(() => false);
		if (value) return value;
		if (Date.now() >= deadline) return false;
		await sleep(200);
	}
};

const WORK = realpathSync(mkdtempSync(join(tmpdir(), "autorag-qa-live-cli-ask-")));
const HOME = join(WORK, "home");
const USER_DATA = join(WORK, "user-data");
const AGENT_DIR = join(WORK, "pi-agent");
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const DOCS = join(WORK, "docs");
for (const directory of [HOME, USER_DATA, DOCS, join(WORK, "workspace"), join(AUTORAG_HOME, "bin")]) mkdirSync(directory, { recursive: true });
writeFileSync(join(AUTORAG_HOME, "bin", "minsync"), "#!/bin/sh\nexit 0\n");
chmodSync(join(AUTORAG_HOME, "bin", "minsync"), 0o755);
const PLANS = join(DOCS, "plans.txt");
writeFileSync(PLANS, ["요금제 안내", "Free 플랜: 월 0원, 사용자 1명.", "Pro 플랜: 월 20,000원, 사용자 5명.", "Team 플랜: 월 80,000원, 사용자 30명.", ""].join("\n"));
writeFileSync(
	CONFIG,
	`${JSON.stringify({ searchPaths: [DOCS], workspacePath: join(WORK, "workspace"), memoryPath: join(WORK, "memory.json"), minSync: { enabled: true, autoInstall: true, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } }, jikji: false }, null, 2)}\n`,
);

// A bundle shaped like the real one: Contents/Resources/bin/dazzi next to Contents/MacOS/Dazzi.
const APP = join(WORK, "Dazzi.app");
const SHIM = join(APP, "Contents", "Resources", "bin", "dazzi");
mkdirSync(join(APP, "Contents", "Resources", "bin"), { recursive: true });
mkdirSync(join(APP, "Contents", "MacOS"), { recursive: true });
copyFileSync(join(ROOT, "build", "cli", "dazzi"), SHIM);
chmodSync(SHIM, 0o755);
const electron = join(ROOT, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
writeFileSync(join(APP, "Contents", "MacOS", "Dazzi"), `#!/bin/sh\nexec "${electron}" "${ROOT}" \${QA_ELECTRON_FLAGS:+"\$QA_ELECTRON_FLAGS"} "$@"\n`);
chmodSync(join(APP, "Contents", "MacOS", "Dazzi"), 0o755);

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
	...homeEnv(HOME),
	AUTORAG_HOME,
	AUTORAG_CONFIG: CONFIG,
	AUTORAG_BASE_URL: baseUrl,
	PI_CODING_AGENT_DIR: AGENT_DIR,
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	AUTORAG_SKIP_ONBOARDING: "1",
	ELECTRON_RENDERER_URL: "",
	PATH: `${join(AUTORAG_HOME, "bin")}${delimiter}${process.env.PATH ?? ""}`,
	OPENROUTER_API_KEY: "",
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
};

/** `dazzi` exactly as a terminal (or Raycast) runs it, aimed at the lane's profile. */
const dazzi = (args, extraEnv = {}) =>
	spawnSync(SHIM, args, { cwd: WORK, encoding: "utf8", env: { ...process.env, ...env, DAZZI_USER_DATA_DIR: USER_DATA, ...extraEnv } });
const laneProcesses = () => {
	try {
		return execFileSync("/usr/bin/pgrep", ["-f", `user-data-dir=${USER_DATA}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
};
const tabs = (page) => page.locator(".tabs .tab");
const lastTurn = (page) => page.locator(`section[aria-label="AI Search"]:not([aria-hidden="true"]) .user-msg`).last();

/** Waits for the visible AI Search tab to finish answering; returns the rendered answer text, or an error. */
async function answerOf(page, timeoutMs = 240_000) {
	const panel = page.locator('section[aria-label="AI Search"]:not([aria-hidden="true"])');
	await page.waitForFunction(
		() => {
			const visible = document.querySelector('section[aria-label="AI Search"]:not([aria-hidden="true"])');
			if (visible === null) return false;
			const done = visible.querySelector(".user-msg") !== null && visible.querySelector('button[aria-label="Stop"]') === null && visible.querySelector(".assistant-prose") !== null;
			return done || (visible.textContent ?? "").includes("Something went wrong");
		},
		null,
		{ timeout: timeoutMs },
	);
	if ((await panel.locator(".ai", { hasText: "Something went wrong" }).count()) > 0) {
		await panel.locator(".ai button", { hasText: "Show details" }).first().click().catch(() => undefined);
		return { error: (await panel.locator(".ai pre").first().innerText().catch(() => "error")).slice(0, 600), text: "" };
	}
	return { error: "", text: (await panel.locator(".assistant-prose").allInnerTexts()).join(" ").replace(/\s+/gu, " ") };
}

let app;
try {
	app = await launchFinder({ userDataDir: USER_DATA, env });
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(30_000);
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
	const processesBefore = laneProcesses().length;
	const tabsBefore = await tabs(page).count();

	// 1. A question with an attachment, handed to the running app.
	const question = "첨부한 plans.txt 기준으로 Pro 플랜의 월 요금이 얼마인지 한 문장으로 답해줘.";
	const asked = dazzi(["--ask", question, "docs/plans.txt"]);
	check("ask: the command exits 0", asked.status === 0, asked.stderr.trim());
	const bubble = await until(async () => (await lastTurn(page).locator(".bubble").innerText()).includes("Pro 플랜의 월 요금"), 30_000);
	check("ask: the question is sent in the running app", bubble !== false);
	check("ask: it opened a new tab", (await tabs(page).count()) === tabsBefore + 1, `${tabsBefore} → ${await tabs(page).count()}`);
	const chips = await lastTurn(page).locator(".ref-attachments").innerText().catch(() => "");
	check("ask: plans.txt rides along as the question's attachment", chips.includes("plans.txt"), JSON.stringify(chips));
	await page.screenshot({ path: join(EVIDENCE, "live-cli-ask-01-sent.png") });
	const first = await answerOf(page);
	check("ask: AI Search shows no error", first.error === "", first.error);
	console.log(`model answer: ${first.text.slice(0, 300)}`);
	check("ask: a real model answered from the attached file (20,000)", /20,?000/u.test(first.text), first.text.slice(0, 200));
	check("ask: no second app process is left behind", laneProcesses().length === processesBefore, `${processesBefore} → ${laneProcesses().length}`);
	await page.screenshot({ path: join(EVIDENCE, "live-cli-ask-02-answered.png") });

	// 2. Another question: a fresh tab, not the answered one.
	const tabsAfterFirst = await tabs(page).count();
	const second = dazzi(["--ask=Team 플랜은 사용자 몇 명까지야? 숫자만.", PLANS]);
	check("second ask: exits 0", second.status === 0, second.stderr.trim());
	const secondBubble = await until(async () => (await lastTurn(page).locator(".bubble").innerText()).includes("Team 플랜"), 30_000);
	check("second ask: sent in another new tab", secondBubble !== false && (await tabs(page).count()) === tabsAfterFirst + 1, `${tabsAfterFirst} → ${await tabs(page).count()}`);
	const secondAnswer = await answerOf(page);
	console.log(`second answer: ${secondAnswer.text.slice(0, 200)}`);
	check("second ask: answered with 30", secondAnswer.error === "" && /30/u.test(secondAnswer.text), secondAnswer.error || secondAnswer.text.slice(0, 200));
	await page.screenshot({ path: join(EVIDENCE, "live-cli-ask-03-second.png") });

	// 3. No question: refused, nothing changes.
	const tabsBeforeEmpty = await tabs(page).count();
	const empty = dazzi(["--ask", "  "]);
	check("empty question: exit 2 with a message", empty.status === 2 && empty.stderr.includes("--ask needs a question"), empty.stderr.trim());
	await sleep(1000);
	check("empty question: no tab opens", (await tabs(page).count()) === tabsBeforeEmpty);

	await app.close();
	app = undefined;
	await until(async () => laneProcesses().length === 0, 15_000);

	// 4. Cold start: the launcher starts the app, the request rides in argv, and the question is asked on first load.
	const PORT = 9400 + (process.pid % 400);
	const cold = dazzi(["--ask", "plans.txt에서 Free 플랜 사용자 수는? 숫자만.", PLANS], { QA_ELECTRON_FLAGS: `--remote-debugging-port=${PORT}` });
	check("cold start: the command returns at once", cold.status === 0, cold.stderr.trim());
	check("cold start: the launcher started the app", (await until(async () => laneProcesses().length > 0, 30_000)) !== false);
	const { chromium } = await import("playwright");
	const browser = await until(async () => chromium.connectOverCDP(`http://127.0.0.1:${PORT}`), 40_000);
	if (browser === false) {
		check("cold start: the app window is reachable", false);
	} else {
		const coldPage = await until(async () => browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().includes("index.html")), 30_000);
		if (coldPage === false) {
			check("cold start: the Finder window loads", false);
		} else {
			const sent = await until(async () => (await lastTurn(coldPage).locator(".bubble").innerText()).includes("Free 플랜"), 60_000);
			check("cold start: the question is asked on first load", sent !== false);
			const coldAnswer = sent === false ? { error: "not sent", text: "" } : await answerOf(coldPage);
			console.log(`cold answer: ${coldAnswer.text.slice(0, 200)}`);
			check("cold start: answered with 1", coldAnswer.error === "" && /\b1\b|1명/u.test(coldAnswer.text), coldAnswer.error || coldAnswer.text.slice(0, 200));
			await coldPage.screenshot({ path: join(EVIDENCE, "live-cli-ask-04-cold.png") });
		}
		await browser.close().catch(() => undefined);
	}
} catch (error) {
	check("run completed", false, String(error?.stack ?? error).slice(0, 800));
} finally {
	if (app !== undefined) await app.close().catch(() => undefined);
	for (const pid of laneProcesses()) {
		try {
			process.kill(Number(pid), "SIGTERM");
		} catch {
			// already gone
		}
	}
	service.close();
	rmSync(WORK, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.log(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
