/**
 * Live end-to-end QA: Sidebar customization with a real 2026+ LLM
 * (`deepseek/deepseek-v4.1-flash`, created=2026-09-10) through the Dazzi account.
 *
 * Exercises the real built Electron app (`out/`), the real `app-customizer`
 * pi agent profile, real tool calling (`get_app_settings`, `update_sidebar`),
 * live `.shimmer` intent progress (`i`), real-time sidebar DOM updates, and
 * `settings-state.json` persistence in a throwaway profile.
 *
 * Run in a VM (forwarding token via `--token`) or with `QA_DAZZI_TOKEN`:
 *   bun run qa script --vm --skip-build scripts/manual-qa/run-qa-live-sidebar-customizer.mjs --token "$TOKEN"
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";

const REAL_API = "https://api.dazziapp.com";
const MODEL_ID = process.env.QA_LIVE_MODEL?.trim() || "deepseek/deepseek-v4.1-flash";
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-sidebar-customizer");
mkdirSync(EVIDENCE, { recursive: true });

function resolveToken() {
	const flagIdx = process.argv.indexOf("--token");
	if (flagIdx >= 0 && typeof process.argv[flagIdx + 1] === "string" && process.argv[flagIdx + 1].trim().length > 0) {
		return process.argv[flagIdx + 1].trim();
	}
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

const TOKEN = resolveToken();
if (TOKEN === null) {
	console.error("A Dazzi account key is required: pass --token, set QA_DAZZI_TOKEN, or sign in to Dazzi on this machine.");
	process.exit(2);
}

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-live-sidebar-"));
const HOME_DIR = join(WORK, "home");
const AGENT_DIR = join(WORK, "pi-agent");
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const USER_DATA = join(WORK, "user-data");

for (const folder of ["Desktop", "Documents", "Downloads", "Music", "Movies", "Pictures", ".Trash"]) {
	mkdirSync(join(HOME_DIR, folder), { recursive: true });
}
mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(join(AUTORAG_HOME, "bin"), { recursive: true });
const minsyncStub = join(AUTORAG_HOME, "bin", "minsync");
writeFileSync(minsyncStub, "#!/bin/sh\nexit 0\n");
chmodSync(minsyncStub, 0o755);

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
	upstream.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
	req.pipe(upstream);
});
await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${service.address().port}`;

const baseConfig = {
	searchPaths: [join(HOME_DIR, "Documents")],
	workspacePath: join(WORK, "workspace"),
	memoryPath: join(WORK, "memory.json"),
	minSync: { enabled: true, autoInstall: true, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } },
	jikji: false,
	model: {
		provider: "dazzi",
		id: MODEL_ID,
		name: MODEL_ID,
		baseUrl: `${baseUrl}/v1`,
		api: "openai-responses",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 32000,
	},
};
writeFileSync(CONFIG, `${JSON.stringify(baseConfig, null, 2)}\n`);

const env = {
	HOME: HOME_DIR,
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

const app = await launchFinder({ userDataDir: USER_DATA, env, language: "ko" });
try {
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(90_000);
	await app.evaluate(({ shell }) => {
		shell.openExternal = async (url) => {
			await fetch(url);
		};
	});

	const status = await page.evaluate(() => window.autorag.account.signIn());
	check("Dazzi sign-in completes", status.state === "signedIn", `${status.state} ${status.error ?? ""}`);

	// Re-ensure our 2026+ model is written after sign-in
	const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
	cfg.model = baseConfig.model;
	const configJsonBefore = `${JSON.stringify(cfg, null, 2)}\n`;
	writeFileSync(CONFIG, configJsonBefore);
	console.log(`live model: ${MODEL_ID}`);

	const shot = async (name) => {
		await page.waitForTimeout(400);
		await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
	};
	const sidebarLabels = async () => page.locator(".sidebar .sidebar__item-label").allInnerTexts();

	const seenProgress = [];
	await page.exposeFunction("__recordCustomizerProgress", (text) => seenProgress.push(text)).catch(() => undefined);
	await page.evaluate(() => {
		window.autorag.appCustomizer.onEvent((event) => {
			if (event.type === "progress") window.__recordCustomizerProgress?.(event.text);
		});
	});

	// Open Settings -> 사이드바 -> AI로 커스텀하기
	await page.locator(".sidebar__item--settings").click();
	await page.locator(".settings-nav-item", { hasText: "사이드바" }).click();
	await page.locator("h1.linear-title", { hasText: "사이드바" }).waitFor();
	await page.locator('[data-action="open-app-customizer"]').click();

	const modal = page.locator('[data-testid="app-customizer-modal"]');
	await modal.waitFor();
	await shot("01-live-modal-opened");

	// Turn 1: Ask the real model to hide Music & Movies, move Downloads to top, and try hiding AI Search & Automations
	const input = modal.locator('textarea[data-testid="app-customizer-input"]');
	await input.click();
	await page.keyboard.type("사이드바에서 음악과 동영상 폴더를 숨기고, 다운로드를 즐겨찾기 맨 위로 올려줘. 그리고 AI 검색이랑 자동화도 숨길 수 있으면 숨겨줘.");
	await page.keyboard.press("Enter");

	await page.waitForFunction(
		() => {
			const replies = document.querySelectorAll('[data-testid="app-customizer-modal"] .customizer-turn__reply');
			const sendBtn = document.querySelector('[data-action="send-customizer-message"]');
			return replies.length >= 1 && sendBtn !== null;
		},
		null,
		{ timeout: 120_000 },
	);
	await shot("02-live-turn1-done");

	const reply1 = await modal.locator(".customizer-turn__reply").first().innerText();
	console.log(`live model reply 1:\n${reply1}`);
	console.log(`live progress phrases: ${JSON.stringify(seenProgress)}`);

	const labelsAfterTurn1 = await sidebarLabels();
	const settingsStatePath = join(USER_DATA, "settings", "settings-state.json");
	const persisted1 = JSON.parse(readFileSync(settingsStatePath, "utf8"));

	check(
		"Real LLM streamed live `i` progress phrases during tool calls",
		seenProgress.length >= 1,
		JSON.stringify(seenProgress),
	);
	check(
		"Real LLM hid Music and Movies in the live Finder sidebar and settings-state.json",
		!labelsAfterTurn1.includes("음악") &&
			!labelsAfterTurn1.includes("동영상") &&
			persisted1.settings.sidebar.hiddenItems.includes("place:music") &&
			persisted1.settings.sidebar.hiddenItems.includes("place:movies"),
		JSON.stringify({ labelsAfterTurn1, hiddenItems: persisted1.settings.sidebar.hiddenItems }),
	);
	check(
		"AI 검색 and 자동화 remain visible at the top of Favorites and are NEVER in hiddenItems",
		labelsAfterTurn1[0] === "AI 검색" &&
			labelsAfterTurn1[1] === "자동화" &&
			!persisted1.settings.sidebar.hiddenItems.includes("app:aiSearch") &&
			!persisted1.settings.sidebar.hiddenItems.includes("app:automations"),
		JSON.stringify(labelsAfterTurn1),
	);
	check(
		"AutoRAG config.json on disk was not modified by the app-customizer agent",
		readFileSync(CONFIG, "utf8") === configJsonBefore,
	);

	// Turn 2: Ask the real model in the same conversation to restore default sidebar settings
	await input.click();
	await page.keyboard.type("사이드바 설정을 다시 기본값으로 모두 복원해줘.");
	await page.keyboard.press("Enter");

	await page.waitForFunction(
		() => {
			const turns = document.querySelectorAll('[data-testid="app-customizer-modal"] .customizer-turn');
			const lastReply = turns[1]?.querySelector(".customizer-turn__reply");
			const sendBtn = document.querySelector('[data-action="send-customizer-message"]');
			return lastReply !== null && lastReply !== undefined && sendBtn !== null;
		},
		null,
		{ timeout: 120_000 },
	);
	await shot("03-live-turn2-reset-done");

	const labelsAfterTurn2 = await sidebarLabels();
	const persisted2 = JSON.parse(readFileSync(settingsStatePath, "utf8"));
	check(
		"Real LLM restored Music and Movies in Turn 2 on the same multi-turn session",
		labelsAfterTurn2.includes("음악") &&
			labelsAfterTurn2.includes("동영상") &&
			persisted2.settings.sidebar.hiddenItems.length === 0,
		JSON.stringify(labelsAfterTurn2),
	);
} finally {
	await app.close().catch(() => undefined);
	service.close();
	rmSync(WORK, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
	process.exit(1);
}
console.log("\nAll live sidebar customizer checks passed.");
