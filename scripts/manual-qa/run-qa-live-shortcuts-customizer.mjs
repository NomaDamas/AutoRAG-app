/**
 * Live end-to-end QA: Keyboard shortcut customization with a real 2026+ LLM
 * (`deepseek/deepseek-v4.1-flash`, created=2026-09-10) through the Dazzi account.
 *
 * Exercises the real built Electron app (`out/`), direct key-press recording,
 * the real `shortcut-customizer` pi agent profile, real tool calling
 * (`get_shortcuts`, `update_shortcuts`), live `.shimmer` intent progress (`i`),
 * closed-catalog enforcement (refusing arbitrary new actions), live Finder
 * shortcut dispatch, and `settings-state.json` persistence in a throwaway profile.
 *
 * Run in a VM (forwarding token via `--token`) or with `QA_DAZZI_TOKEN`:
 *   bun run qa script --vm --skip-build scripts/manual-qa/run-qa-live-shortcuts-customizer.mjs --token "$TOKEN"
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { chord, isMac } from "./platform.mjs";

const REAL_API = "https://api.dazziapp.com";
const MODEL_ID = process.env.QA_LIVE_MODEL?.trim() || "deepseek/deepseek-v4.1-flash";
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-shortcuts-customizer");
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

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-live-shortcuts-"));
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
writeFileSync(minsyncStub, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "minsync 0.6.0"; exit 0; fi\nexit 0\n');
chmodSync(minsyncStub, 0o755);

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
{
	const { promise, resolve } = Promise.withResolvers();
	service.listen(0, "127.0.0.1", resolve);
	await promise;
}
const baseUrl = `http://127.0.0.1:${service.address().port}`;

const baseConfig = {
	searchPaths: [join(HOME_DIR, "Documents")],
	workspacePath: join(WORK, "workspace"),
	memoryPath: join(WORK, "memory.json"),
	minSync: { enabled: true, autoInstall: true, embedder: { id: "none" } },
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

	const seenProgress = [];
	await page.exposeFunction("__recordShortcutProgress", (text) => seenProgress.push(text)).catch(() => undefined);
	await page.evaluate(() => {
		window.autorag.appCustomizer.onEvent((event) => {
			if (event.type === "progress") window.__recordShortcutProgress?.(event.text);
		});
	});

	// Open Settings -> 단축키 -> AI로 커스텀하기
	await page.locator(".sidebar__item--settings").click();
	await page.locator(".settings-nav-item", { hasText: "단축키" }).click();
	await page.locator("h1.linear-title", { hasText: "단축키" }).waitFor();
	await page.locator('[data-action="open-shortcut-customizer"]').click();

	const modal = page.locator('[data-testid="app-customizer-modal"]');
	await modal.waitFor();
	await shot("01-live-shortcut-modal-opened");

	// Turn 1: Ask the real 2026+ LLM to change rename to F2, focusSearch to Cmd+P, and attempt an unsupported new action
	const input = modal.locator('textarea[data-testid="app-customizer-input"]');
	await input.click();
	await page.keyboard.type(
		"이름 변경 단축키를 F2로 바꾸고, 검색창 포커스 단축키는 커맨드 P로 바꿔줘. 그리고 '터미널 열기'라는 새 기능도 커맨드 J 단축키로 추가할 수 있으면 추가해줘.",
	);
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
	await shot("02-live-shortcut-turn1-done");

	const reply1 = await modal.locator(".customizer-turn__reply").first().innerText();
	console.log(`live model reply 1:\n${reply1}`);
	console.log(`live progress phrases: ${JSON.stringify(seenProgress)}`);

	const settingsStatePath = join(USER_DATA, "settings", "settings-state.json");
	const persisted1 = JSON.parse(readFileSync(settingsStatePath, "utf8"));
	const expectedSearchKeycap = isMac ? "⌘P" : "Ctrl+P";
	const liveKeycapAfterTurn1 = (await page.locator(".side-search .keycap").innerText()).trim();

	check(
		"Real LLM streamed live `i` progress phrases during shortcut tool calls",
		seenProgress.length >= 1,
		JSON.stringify(seenProgress),
	);
	check(
		"Real LLM updated rename=F2 and focusSearch=Mod+P in settings-state.json and live Finder sidebar keycap",
		persisted1.settings.shortcuts.overrides.rename === "F2" &&
			persisted1.settings.shortcuts.overrides.focusSearch === "Mod+P" &&
			liveKeycapAfterTurn1 === expectedSearchKeycap,
		JSON.stringify({ overrides: persisted1.settings.shortcuts.overrides, liveKeycapAfterTurn1 }),
	);
	check(
		"Closed-catalog invariant held: only rename and focusSearch exist in overrides (no arbitrary terminal action)",
		Object.keys(persisted1.settings.shortcuts.overrides).sort().join(",") === "focusSearch,rename",
		JSON.stringify(persisted1.settings.shortcuts.overrides),
	);
	check(
		"AutoRAG config.json on disk was not modified by the shortcut-customizer agent",
		readFileSync(CONFIG, "utf8") === configJsonBefore,
	);

	// Turn 2: Ask the real model in the same conversation to switch to Windows File Explorer preset
	await input.click();
	await page.keyboard.type("이번에는 Windows 파일 탐색기 단축키 구성으로 바꿔줘.");
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
	await shot("03-live-shortcut-turn2-windows-preset");

	const persistedWin = JSON.parse(readFileSync(settingsStatePath, "utf8"));
	check(
		"Real LLM applied the Windows File Explorer preset in Turn 2",
		persistedWin.settings.shortcuts.overrides.rename === "F2" &&
			persistedWin.settings.shortcuts.overrides.editPath === "Alt+D" &&
			persistedWin.settings.shortcuts.overrides.redo === "Mod+Y",
		JSON.stringify(persistedWin.settings.shortcuts.overrides),
	);

	// Turn 3: Restore all shortcuts to default
	await input.click();
	await page.keyboard.type("모든 단축키를 다시 기본값으로 모두 복원해줘.");
	await page.keyboard.press("Enter");

	await page.waitForFunction(
		() => {
			const turns = document.querySelectorAll('[data-testid="app-customizer-modal"] .customizer-turn');
			const lastReply = turns[2]?.querySelector(".customizer-turn__reply");
			const sendBtn = document.querySelector('[data-action="send-customizer-message"]');
			return lastReply !== null && lastReply !== undefined && sendBtn !== null;
		},
		null,
		{ timeout: 120_000 },
	);
	await shot("03b-live-shortcut-turn3-reset-done");

	const persisted2 = JSON.parse(readFileSync(settingsStatePath, "utf8"));
	const defaultSearchKeycap = isMac ? "⌘F" : "Ctrl+F";
	const liveKeycapAfterTurn2 = (await page.locator(".side-search .keycap").innerText()).trim();
	check(
		"Real LLM restored all shortcuts to default in Turn 3 on the same multi-turn session",
		Object.keys(persisted2.settings.shortcuts.overrides).length === 0 && liveKeycapAfterTurn2 === defaultSearchKeycap,
		JSON.stringify({ overrides: persisted2.settings.shortcuts.overrides, liveKeycapAfterTurn2 }),
	);

	// Close modal and verify direct key-press recording in the live session too!
	await modal.locator('[data-action="close-app-customizer"]').click();
	await modal.waitFor({ state: "detached" });
	await page.locator('[data-shortcut-record="newTab"]').click();
	await page.keyboard.press(chord("Shift", "P"));
	await page.waitForTimeout(300);
	await shot("04-live-after-keypress-record");
	const persisted3 = JSON.parse(readFileSync(settingsStatePath, "utf8"));
	check(
		"Direct key-press recording on the live page persisted newTab=Mod+Shift+P",
		persisted3.settings.shortcuts.overrides.newTab === "Mod+Shift+P",
		JSON.stringify(persisted3.settings.shortcuts.overrides),
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
console.log("\nAll live shortcut customizer checks passed.");
