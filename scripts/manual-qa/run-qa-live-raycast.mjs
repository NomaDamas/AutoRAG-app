// Live end-to-end for the Raycast extension (integrations/raycast), driven through the real Raycast app with
// real keystrokes. Proves, on this Mac:
//   1. Search Dazzi returns ranked hits from the developer's real Dazzi index (the installed app's bundled
//      librarian CLI, model-free), and Enter-free typing updates the list;
//   2. Ask Dazzi sends a typed question to a running Dazzi: a new AI Search tab, the question in the bubble, and a
//      real model's answer (live Dazzi API);
//   3. Ask Dazzi About Selected Files attaches the Finder selection to the question;
//   4. Open in Dazzi opens the Finder-selected folder in a tab;
//   5. with no Dazzi at the configured location, a command says Dazzi is not installed.
//
// Raycast takes the keyboard and the screen, so this runs on the host only (Raycast is not in the QA VM image).
// Prerequisites: Raycast with Accessibility granted to the terminal, `bun run build`, `npx ray develop` running in
// integrations/raycast, a Dazzi account key (QA_DAZZI_TOKEN or `~/.pi/agent/auth.json`), and an installed
// /Applications/Dazzi.app whose index the search reads. The extension's "Dazzi Application" preference must point
// at the stand-in this script prints (it is set once, through Raycast's settings, by the person running it).
//
//   bun scripts/manual-qa/run-qa-live-raycast.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { chromium } from "playwright";
import { ROOT } from "./launch-finder.mjs";
import { isMac } from "./platform.mjs";

if (!isMac) {
	console.log("SKIP live-raycast: Raycast is macOS-only");
	process.exit(0);
}

const INSTALLED = "/Applications/Dazzi.app";
const STANDIN_ROOT = join(homedir(), ".autorag-qa", "raycast");
const STANDIN = join(STANDIN_ROOT, "Dazzi.app");
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-raycast");
mkdirSync(EVIDENCE, { recursive: true });
const REAL_API = "https://api.dazziapp.com";
const PORT = 9460 + (process.pid % 300);

function realToken() {
	const fromEnv = process.env.QA_DAZZI_TOKEN?.trim();
	if (fromEnv) return fromEnv;
	try {
		const entry = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8")).dazzi;
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
if (!existsSync(join(INSTALLED, "Contents", "Resources", "tools", "bin", "autorag"))) {
	console.error(`${INSTALLED} with bundled tools is required: Search Dazzi reads its index through them.`);
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
		await sleep(250);
	}
};
const osa = (...lines) => execFileSync("/usr/bin/osascript", lines.flatMap((line) => ["-e", line]), { encoding: "utf8" }).trim();
const key = (code, modifiers = []) => osa(`tell application "System Events" to key code ${code}${modifiers.length > 0 ? ` using {${modifiers.map((m) => `${m} down`).join(", ")}}` : ""}`);
const ESC = 53;
const RETURN = 36;
/**
 * Type text into the focused Raycast field: paste through the clipboard and ⌘V (key codes, not `keystroke`,
 * which drops and reorders characters in Raycast's fields and cannot type Hangul at all).
 */
const type = async (text) => {
	execFileSync("/usr/bin/pbcopy", { input: text });
	await sleep(150);
	key(9, ["command"]);
	await sleep(400);
};
const shot = (name) => execFileSync("/usr/sbin/screencapture", ["-x", join(EVIDENCE, `${name}.png`)]);

/** Open a Raycast command of the dev extension the way a person does: Raycast's root search, the title, Enter. */
async function openCommand(title) {
	execFileSync("/usr/bin/open", ["raycast://"]);
	await sleep(800);
	// Raycast reopens its last view: back out to the root search and clear it.
	key(ESC);
	await sleep(300);
	execFileSync("/usr/bin/open", ["raycast://"]);
	await sleep(700);
	key(0, ["command"]);
	key(51);
	await type(title);
	await sleep(900);
	key(RETURN);
	await sleep(1200);
}

// The stand-in bundle: the shipped launcher from this checkout, an executable that starts this checkout's
// Electron on the lane's profile, and the installed app's real tools (so Search reads the real index).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), "autorag-qa-live-raycast-")));
const USER_DATA = join(WORK, "user-data");
const AGENT_DIR = join(WORK, "pi-agent");
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const DOCS = join(WORK, "docs");
const PROJECT = join(WORK, "raycast-project");
for (const directory of [USER_DATA, DOCS, PROJECT, join(WORK, "workspace"), join(AUTORAG_HOME, "bin")]) mkdirSync(directory, { recursive: true });
writeFileSync(join(AUTORAG_HOME, "bin", "minsync"), "#!/bin/sh\nexit 0\n");
chmodSync(join(AUTORAG_HOME, "bin", "minsync"), 0o755);
const PLANS = join(DOCS, "plans.txt");
writeFileSync(PLANS, ["요금제 안내", "Free 플랜: 월 0원, 사용자 1명.", "Pro 플랜: 월 20,000원, 사용자 5명.", "Team 플랜: 월 80,000원, 사용자 30명.", ""].join("\n"));
writeFileSync(join(PROJECT, "inside-raycast.txt"), "inside\n");
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
	upstream.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
	req.pipe(upstream);
});
await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${service.address().port}`;

rmSync(STANDIN, { recursive: true, force: true });
mkdirSync(join(STANDIN, "Contents", "Resources", "bin"), { recursive: true });
mkdirSync(join(STANDIN, "Contents", "MacOS"), { recursive: true });
copyFileSync(join(ROOT, "build", "cli", "dazzi"), join(STANDIN, "Contents", "Resources", "bin", "dazzi"));
chmodSync(join(STANDIN, "Contents", "Resources", "bin", "dazzi"), 0o755);
// The bundled `autorag` is a shim that runs `../app/node_modules/@autorag/librarian`: both directories come along.
symlinkSync(join(INSTALLED, "Contents", "Resources", "tools"), join(STANDIN, "Contents", "Resources", "tools"));
symlinkSync(join(INSTALLED, "Contents", "Resources", "app"), join(STANDIN, "Contents", "Resources", "app"));
const electron = join(ROOT, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
// Raycast starts the launcher with its own environment: the lane's profile, config and sign-in ride in here.
const appEnv = {
	AUTORAG_HOME,
	AUTORAG_CONFIG: CONFIG,
	AUTORAG_BASE_URL: baseUrl,
	PI_CODING_AGENT_DIR: AGENT_DIR,
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	AUTORAG_SKIP_ONBOARDING: "1",
	ELECTRON_RENDERER_URL: "",
	OPENROUTER_API_KEY: "",
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
};
const exports = Object.entries(appEnv)
	.map(([name, value]) => `export ${name}=${JSON.stringify(value)}`)
	.join("\n");
// The sign-in opens the browser through `shell.openExternal`; in the lane it fetches the stand-in authorize URL
// instead (the other live lanes do the same through Playwright's `app.evaluate`), so no real browser tab opens.
const SIGN_IN_STUB = join(WORK, "sign-in-stub.cjs");
writeFileSync(
	SIGN_IN_STUB,
	'setImmediate(() => { const { shell } = require("electron"); shell.openExternal = async (url) => { await fetch(url); }; });\n',
);
writeFileSync(
	join(STANDIN, "Contents", "MacOS", "Dazzi"),
	`#!/bin/sh\n${exports}\nexport NODE_OPTIONS="--require=${SIGN_IN_STUB}"\nexport PATH="${join(AUTORAG_HOME, "bin")}${delimiter}$PATH"\nexec "${electron}" "${ROOT}" --remote-debugging-port=${PORT} "--user-data-dir=${USER_DATA}" "$@"\n`,
);
chmodSync(join(STANDIN, "Contents", "MacOS", "Dazzi"), 0o755);

const laneProcesses = () => {
	try {
		return execFileSync("/usr/bin/pgrep", ["-f", `user-data-dir=${USER_DATA}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
};

console.log(`stand-in Dazzi: ${STANDIN}`);
console.log("Set Raycast → Extensions → Dazzi → Dazzi Application to that path before running (once).");

let browser;
let page;
try {
	// Start the stand-in Dazzi the way a person does (`open`), then sign it in.
	execFileSync("/usr/bin/open", ["-n", STANDIN]);
	check("stand-in Dazzi starts", (await until(async () => laneProcesses().length > 0, 30_000)) !== false);
	browser = await until(async () => chromium.connectOverCDP(`http://127.0.0.1:${PORT}`), 40_000);
	page = await until(async () => browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().includes("index.html")), 30_000);
	await page.waitForFunction(() => window.autorag?.account !== undefined, null, { timeout: 30_000 });
	const signed = await page.evaluate(() => window.autorag.account.signIn());
	check("stand-in Dazzi is signed in", signed.state === "signedIn", `${signed.state} ${signed.error ?? ""}`);
	const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
	cfg.model = { provider: "dazzi", id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", baseUrl: `${baseUrl}/v1`, api: "openai-responses", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 32000 };
	writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`);
	const tabs = () => page.locator(".tabs .tab").count();
	const lastBubble = () => page.locator('section[aria-label="AI Search"]:not([aria-hidden="true"]) .user-msg .bubble').last().innerText();

	// 1. Search Dazzi over the real index. Raycast's list is read off the screen (it exposes no text to Accessibility),
	// from Raycast's own window: it opens on whichever display has the pointer, not necessarily the main one.
	await openCommand("Search Dazzi");
	await type("루킹 유지등록");
	const raycastWindowShot = (path) => {
		const [x, y, w, h] = osa('tell application "System Events" to tell process "Raycast" to get {position, size} of window "Main Window"').split(",").map((part) => Number(part.trim()));
		execFileSync("/usr/sbin/screencapture", ["-x", "-R", `${x},${y},${w},${h}`, path]);
	};
	const raycastText = () => {
		const png = join(WORK, "raycast.png");
		raycastWindowShot(png);
		return execFileSync("swift", [join(ROOT, "scripts", "manual-qa", "screen-ocr.swift"), png], { encoding: "utf8" });
	};
	// A file hit's subtitle is its folder under the home directory; the query and command names are on screen too.
	const listed = await until(async () => {
		const text = raycastText();
		return text.includes("루킹 유지등록") && /~\/(Documents|Downloads|Desktop)/u.test(text) ? text : false;
	}, 120_000);
	raycastWindowShot(join(EVIDENCE, "raycast-01-search.png"));
	const seen = typeof listed === "string" ? listed : raycastText();
	check("search: hits from the real index are listed in Raycast", listed !== false, seen.split("\n").slice(0, 10).join(" | "));
	key(ESC);
	key(ESC);
	await sleep(500);

	// 2. Ask Dazzi: typed in Raycast, answered in a new AI Search tab of the running Dazzi.
	const tabsBefore = await tabs();
	await openCommand("Ask Dazzi");
	await type("Raycast에서 보낸 질문이야. 한 단어로 인사해줘.");
	key(RETURN);
	const asked = await until(async () => (await lastBubble()).includes("Raycast에서 보낸 질문"), 30_000);
	check("ask: the question arrives in Dazzi", asked !== false);
	check("ask: in a new tab", (await tabs()) === tabsBefore + 1, `${tabsBefore} → ${await tabs()}`);
	shot("raycast-02-ask-hud");
	const answered = await until(async () => (await page.locator('section[aria-label="AI Search"]:not([aria-hidden="true"]) .assistant-prose').allInnerTexts()).join("").trim(), 240_000);
	check("ask: a real model answered", answered !== false, typeof answered === "string" ? answered.slice(0, 120) : "");
	await page.screenshot({ path: join(EVIDENCE, "raycast-03-ask-answer.png") });

	// 3. Ask about the Finder selection.
	// `open -R` reveals and selects in Finder; AppleScript's `reveal` times out on a hidden temp folder.
	execFileSync("/usr/bin/open", ["-R", PLANS]);
	await sleep(1200);
	const tabsBeforeSelection = await tabs();
	await openCommand("Ask Dazzi About Selected Files");
	await type("이 파일에서 Pro 플랜 월 요금은? 숫자만.");
	key(RETURN);
	const selected = await until(async () => (await lastBubble()).includes("Pro 플랜 월 요금"), 30_000);
	check("selection: the question arrives in a new tab", selected !== false && (await tabs()) === tabsBeforeSelection + 1);
	const chips = await page.locator('section[aria-label="AI Search"]:not([aria-hidden="true"]) .user-msg .ref-attachments').last().innerText().catch(() => "");
	check("selection: the Finder selection is attached", chips.includes("plans.txt"), JSON.stringify(chips));
	const selectionAnswer = await until(async () => {
		const text = (await page.locator('section[aria-label="AI Search"]:not([aria-hidden="true"]) .assistant-prose').allInnerTexts()).join(" ");
		return /20,?000/u.test(text) ? text : false;
	}, 240_000);
	check("selection: answered from the file (20,000)", selectionAnswer !== false, typeof selectionAnswer === "string" ? selectionAnswer.slice(0, 120) : "");
	await page.screenshot({ path: join(EVIDENCE, "raycast-04-selection-answer.png") });

	// 4. Open in Dazzi: the Finder-selected folder opens in a tab.
	execFileSync("/usr/bin/open", ["-R", PROJECT]);
	await sleep(1200);
	await openCommand("Open in Dazzi");
	const opened = await until(async () => (await page.locator(`[data-path="${join(PROJECT, "inside-raycast.txt")}"]`).count()) > 0, 30_000);
	check("open: the selected folder is listed in Dazzi", opened !== false);
	await page.screenshot({ path: join(EVIDENCE, "raycast-05-open.png") });
} catch (error) {
	check("run completed", false, String(error?.stack ?? error).slice(0, 800));
} finally {
	await browser?.close().catch(() => undefined);
	for (const signal of ["SIGTERM", "SIGKILL"]) {
		for (const pid of laneProcesses()) {
			try {
				process.kill(Number(pid), signal);
			} catch {
				// already gone
			}
		}
		if ((await until(async () => laneProcesses().length === 0, 10_000)) !== false) break;
	}
	service.close();
	// `open -R` left Finder windows on the lane's temp folders (`docs/`, and WORK for `raycast-project`); close those
	// windows only, by the folder name they are titled with.
	for (const name of ["docs", basename(WORK)]) {
		for (let i = 0; i < 4; i += 1) {
			const script = `tell application "System Events" to tell process "Finder" to click (first button whose subrole is "AXCloseButton") of (first window whose name is ${JSON.stringify(name)})`;
			if (spawnSync("/usr/bin/osascript", ["-e", script], { timeout: 8000 }).status !== 0) break;
		}
	}
	rmSync(WORK, { recursive: true, force: true });
	spawnSync("/usr/bin/osascript", ["-e", 'tell application "System Events" to key code 53']);
}

if (failures.length > 0) {
	console.log(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
