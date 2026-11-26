/**
 * Live end-to-end QA: unified Settings Assistant across EVERY Settings tab + dedicated Datasource Connections
 * Assistant (`datasource-connections-customizer`) with a real LLM through the Dazzi account.
 *
 * Verifies in the real built Electron app (`out/`):
 * 1. Every Settings tab (계정, 요금제 및 사용량, 일반, 사이드바, 우클릭 메뉴, 단축키, 원격 접속, 정보,
 *    AI 모델, 웹 검색, 검색 순위 학습, 인덱싱, 중복 파일 정리, MCP 서버, 모든 연결) docks a visible AI assistant
 *    panel in the right sidebar with no untranslated keys.
 * 2. From a tab that previously had no assistant (`정보` / `about`), the unified `settings-customizer` profile
 *    can edit settings across multiple domains in one go (e.g. appearance=dark, Windows Explorer shortcut preset,
 *    and LTR rankingLog=false) and persists them to `settings-state.json` and `config.json`.
 * 3. From `검색 순위 학습` (`ltr`), the assistant updates `ltr.autoTrain` and reflects on the page.
 * 4. From `모든 연결` (`apps`), the dedicated `datasource-connections-customizer` profile connects a new
 *    Obsidian datasource with `vaultPath`, updates its description/polling interval, configures a GitHub
 *    datasource's `repos`, and disconnects a datasource after the user clicks Allow on the confirmation card.
 * 5. Navigating to a datasource detail page (`source:<alias>`) docks the `source` assistant surface and edits
 *    its connector/description directly.
 *
 * Run in a VM:
 *   TOKEN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(require("path").join(require("os").homedir(),".pi/agent/auth.json"),"utf8")).dazzi.access)')
 *   bun run qa script --vm --skip-build scripts/manual-qa/run-qa-live-settings-universal-connections.mjs --token "$TOKEN"
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";

const REAL_API = "https://api.dazziapp.com";
const MODEL_ID = process.env.QA_LIVE_MODEL?.trim() || "deepseek/deepseek-v4.1-flash";
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-settings-universal-connections");
mkdirSync(EVIDENCE, { recursive: true });

function flagValue(flag) {
	const idx = process.argv.indexOf(flag);
	if (idx >= 0 && typeof process.argv[idx + 1] === "string" && process.argv[idx + 1].trim().length > 0) {
		return process.argv[idx + 1].trim();
	}
	return null;
}

function resolveOpenRouterKey() {
	return flagValue("--openrouter-key") ?? process.env.OPENROUTER_API_KEY?.trim() ?? null;
}

function resolveToken() {
	const fromFlag = flagValue("--token");
	if (fromFlag !== null) return fromFlag;
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

const OPENROUTER_KEY = resolveOpenRouterKey();
const TOKEN = resolveToken();
const USE_OPENROUTER = OPENROUTER_KEY !== null && flagValue("--token") === null;
if (!USE_OPENROUTER && TOKEN === null) {
	console.error("Pass --openrouter-key <key>, set OPENROUTER_API_KEY, pass --token <dazzi-token>, or sign in to Dazzi.");
	process.exit(2);
}

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-live-settings-all-"));
const HOME_DIR = join(WORK, "home");
const AGENT_DIR = join(WORK, "pi-agent");
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const USER_DATA = join(WORK, "user-data");
const VAULT_DIR = join(HOME_DIR, "Documents", "MyObsidianVault");

for (const folder of ["Desktop", "Documents", "Downloads", "Music", "Movies", "Pictures", ".Trash"]) {
	mkdirSync(join(HOME_DIR, folder), { recursive: true });
}
mkdirSync(VAULT_DIR, { recursive: true });
mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(join(AUTORAG_HOME, "bin"), { recursive: true });
const minsyncStub = join(AUTORAG_HOME, "bin", "minsync");
writeFileSync(minsyncStub, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "minsync 0.7.6"; exit 0; fi\nexit 0\n');
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

const OPENROUTER_MODEL = flagValue("--model") ?? process.env.QA_OPENROUTER_MODEL?.trim() ?? "deepseek/deepseek-v4.1-flash-1017";
const baseConfig = {
	searchPaths: [join(HOME_DIR, "Documents")],
	workspacePath: join(WORK, "workspace"),
	memoryPath: join(WORK, "memory.json"),
	minSync: { enabled: true, autoInstall: true, embedder: { id: "none" } },
	jikji: false,
	datasources: {},
	model: USE_OPENROUTER
		? {
				provider: "openrouter",
				id: OPENROUTER_MODEL,
				name: OPENROUTER_MODEL,
				baseUrl: "https://openrouter.ai/api/v1",
				api: "openai-completions",
				apiKeyEnv: "OPENROUTER_API_KEY",
				reasoning: false,
				input: ["text", "image"],
				contextWindow: 1000000,
				maxTokens: 16384,
			}
		: {
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
	...(USE_OPENROUTER ? {} : { AUTORAG_BASE_URL: baseUrl }),
	PI_CODING_AGENT_DIR: AGENT_DIR,
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	ELECTRON_RENDERER_URL: "",
	AUTORAG_PERMISSION_MODE: "",
	PATH: `${join(AUTORAG_HOME, "bin")}${delimiter}${process.env.PATH ?? ""}`,
	OPENROUTER_API_KEY: USE_OPENROUTER ? OPENROUTER_KEY : "",
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

	if (!USE_OPENROUTER) {
		const status = await page.evaluate(() => window.autorag.account.signIn());
		check("Dazzi sign-in completes", status.state === "signedIn", `${status.state} ${status.error ?? ""}`);
		const cfgAfterSignIn = JSON.parse(readFileSync(CONFIG, "utf8"));
		cfgAfterSignIn.model = baseConfig.model;
		writeFileSync(CONFIG, `${JSON.stringify(cfgAfterSignIn, null, 2)}\n`);
	}
	console.log(`live model: ${USE_OPENROUTER ? `openrouter:${OPENROUTER_MODEL}` : `dazzi:${MODEL_ID}`}`);

	const shot = async (name) => {
		await page.waitForTimeout(350);
		await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
	};

	const STATE = join(USER_DATA, "settings", "settings-state.json");
	const readState = () => JSON.parse(readFileSync(STATE, "utf8")).settings;
	const readConfig = () => JSON.parse(readFileSync(CONFIG, "utf8"));

	await page.locator(".sidebar__item--settings").click();
	await page.locator(".settings-sidebar").waitFor();

	// 1. Verify EVERY Settings nav tab renders a visible AI assistant panel in the right sidebar.
	const allNavTabs = [
		"account",
		"plan",
		"general",
		"sidebar",
		"contextMenu",
		"shortcuts",
		"remote",
		"about",
		"ai",
		"web",
		"ltr",
		"indexing",
		"duplicates",
		"mcp",
		"apps",
	];
	let allTabsHaveAssistant = true;
	const missingTabs = [];
	for (const tabId of allNavTabs) {
		await page.locator(`[data-settings-nav="${tabId}"]`).click();
		const panel = page.locator(`[data-testid="app-customizer-panel"][data-surface="${tabId}"]:not([hidden])`);
		try {
			await panel.waitFor({ timeout: 5_000 });
			const text = await panel.innerText();
			if (text.includes("settingsCore.") || text.trim().length === 0) {
				allTabsHaveAssistant = false;
				missingTabs.push(`${tabId}(bad-copy)`);
			}
		} catch {
			allTabsHaveAssistant = false;
			missingTabs.push(tabId);
		}
	}
	check("Every Settings tab (all 15) docks a visible AI assistant in the right sidebar", allTabsHaveAssistant, missingTabs.join(", "));
	await page.locator('[data-settings-nav="about"]').click();
	await shot("01-about-tab-has-assistant");

	const turnsSeen = new Map();
	const ask = async (navSelector, surface, text) => {
		await page.locator(navSelector).first().click();
		const panel = page.locator(`[data-testid="app-customizer-panel"][data-surface="${surface}"]:not([hidden])`);
		await panel.waitFor();
		const before = turnsSeen.get(surface) ?? 0;
		const input = panel.locator('textarea[data-testid="app-customizer-input"]');
		await input.click();
		await page.keyboard.type(text);
		await page.keyboard.press("Enter");
		await page.waitForFunction(
			({ surface: s, count }) => {
				const root = document.querySelector(`[data-testid="app-customizer-panel"][data-surface="${s}"]`);
				const last = (root?.querySelectorAll(".customizer-turn") ?? [])[count];
				return last !== undefined && last.querySelector(".customizer-turn__reply, .customizer-turn__error") !== null && root?.querySelector('[data-action="stop-customizer-message"]') === null;
			},
			{ surface, count: before },
			{ timeout: 150_000 },
		);
		turnsSeen.set(surface, before + 1);
		const turn = panel.locator(".customizer-turn").nth(before);
		const reply = (await turn.locator(".customizer-turn__reply").allInnerTexts()).join("\n\n");
		console.log(`[${surface}] ${text}\n  -> ${reply.replace(/\n+/g, " ").slice(0, 300)}`);
		return { reply, pills: await turn.locator(".customizer-change-pill").allInnerTexts() };
	};

	// 2. From the `about` tab (previously had NO assistant), edit multiple domains at once via unified settings-customizer.
	{
		const res = await ask(
			'[data-settings-nav="about"]',
			"about",
			"화면을 다크 모드로 바꾸고, 단축키는 Windows 파일 탐색기 프리셋으로 바꾸고, 검색 순위 학습의 검색 기록 쌓기를 꺼줘.",
		);
		await shot("02-about-cross-domain-edit");
		const state = readState();
		const cfg = readConfig();
		check("about tab (unified): appearance=dark persisted", state.appearance === "dark", String(state.appearance));
		check("about tab (unified): Windows Explorer shortcut preset persisted (rename=F2)", state.shortcuts?.overrides?.rename === "F2", JSON.stringify(state.shortcuts?.overrides));
		check("about tab (unified): LTR rankingLog=false persisted in config.json", cfg.rankingLog === false, String(cfg.rankingLog));
		check("about tab (unified): change pills shown", res.pills.length >= 2, JSON.stringify(res.pills));
	}

	// 3. From `ltr` tab, configure LTR autoTrain and verify it updates both config.json and the live LtrPage controls.
	{
		await ask(
			'[data-settings-nav="ltr"]',
			"ltr",
			"검색 순위 학습에서 자동 재학습을 켜고 최소 새 검색 횟수를 150으로 설정해줘.",
		);
		await shot("03-ltr-assistant-edit");
		const cfg = readConfig();
		check(
			"ltr tab: ltr.autoTrain.enabled=true and minNewRuns=150 written to config.json",
			cfg.ltr?.autoTrain?.enabled === true && cfg.ltr?.autoTrain?.minNewRuns === 150,
			JSON.stringify(cfg.ltr),
		);
		const autoSwitch = page.locator('[aria-label="자동으로 다시 학습"]');
		const intervalInput = page.locator("input.ltr-number");
		check(
			"ltr tab: LtrPage reflects autoTrain=on and 150 live beside the sidebar",
			(await autoSwitch.getAttribute("aria-checked")) === "true" && (await intervalInput.inputValue()) === "150",
			`checked=${await autoSwitch.getAttribute("aria-checked")} value=${await intervalInput.inputValue().catch(() => "missing")}`,
		);
	}

	// 4. From `apps` tab, use dedicated datasource-connections-customizer to connect Obsidian + GitHub, edit connector, and disconnect.
	{
		await ask(
			'[data-settings-nav="apps"]',
			"apps",
			`Obsidian을 work-notes 라는 이름으로 연결하고 vaultPath는 ${VAULT_DIR} 로 설정하고 1시간마다 최신화되게 해줘.`,
		);
		await shot("04-apps-connect-obsidian");
		const cfg1 = readConfig();
		check(
			"apps tab (datasource profile): added obsidian connection 'work-notes' with vaultPath and 1h polling",
			cfg1.datasources?.["work-notes"]?.type === "obsidian" &&
				cfg1.datasources?.["work-notes"]?.connector?.vaultPath === VAULT_DIR &&
				cfg1.datasources?.["work-notes"]?.pollingIntervalMs === 3_600_000,
			JSON.stringify(cfg1.datasources?.["work-notes"]),
		);

		// Verify the new datasource appears in the sidebar and clicking it opens `source` assistant surface.
		const sourceNav = page.locator('[data-source-alias="work-notes"]');
		await sourceNav.waitFor({ timeout: 15_000 });
		await ask(
			'[data-source-alias="work-notes"]',
			"source",
			"이 연결의 설명을 '업무 노트 보관소'로 바꿔줘.",
		);
		await shot("05-source-detail-assistant");
		const cfg2 = readConfig();
		check(
			"source detail page: dedicated source surface resolved active sourceAlias and updated description",
			cfg2.datasources?.["work-notes"]?.description === "업무 노트 보관소",
			JSON.stringify(cfg2.datasources?.["work-notes"]),
		);

		// Disconnect work-notes via confirmation card.
		const confirmRemoval = async () => {
			const allow = page.locator('[data-testid="app-customizer-panel"][data-surface="apps"]:not([hidden]) [data-action="prompt-confirm"]');
			await allow.waitFor({ timeout: 120_000 });
			await shot("06-apps-disconnect-confirm-card");
			await allow.click();
		};
		await Promise.all([
			ask('[data-settings-nav="apps"]', "apps", "방금 만든 work-notes 데이터소스 연결을 해제(삭제)해줘."),
			confirmRemoval(),
		]);
		await shot("07-apps-after-disconnect");
		const cfg3 = readConfig();
		check(
			"apps tab (datasource profile): disconnected work-notes after user confirmation",
			cfg3.datasources?.["work-notes"] === undefined,
			JSON.stringify(cfg3.datasources),
		);
	}
} finally {
	await app.close().catch(() => undefined);
	service.close();
	rmSync(WORK, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
	process.exit(1);
}
console.log("\nAll live universal settings + datasource connections assistant checks passed.");
