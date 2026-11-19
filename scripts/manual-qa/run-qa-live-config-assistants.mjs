/**
 * Live end-to-end QA: the AI assistants of the config Settings pages (일반 (문서 언어 포함), AI 모델, 웹 검색, 인덱싱,
 * 중복 파일 정리, MCP 서버, 모든 연결) with a real 2026+ LLM (`deepseek/deepseek-v4.1-flash`, created=2026-09-10)
 * through the Dazzi account.
 *
 * Exercises the real built Electron app (`out/`): each page docks its own assistant in the right sidebar, the model
 * calls the real pi agent profile tools, and what lands in `settings-state.json`, the shared `config.json` and the
 * agent's `mcp.json` is read back from disk. Also checks the refusals (remote access, unconnected model, MCP removal
 * without an explicit ask) and that the page beside the sidebar shows the change.
 *
 * Run in a VM (forwarding token via `--token`) or with `QA_DAZZI_TOKEN`:
 *   bun run qa script --vm --skip-build scripts/manual-qa/run-qa-live-config-assistants.mjs --token "$TOKEN"
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
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-config-assistants");
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

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-live-config-assistants-"));
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
	await page.exposeFunction("__recordProgress", (text) => seenProgress.push(text)).catch(() => undefined);
	await page.evaluate(() => {
		window.autorag.appCustomizer.onEvent((event) => {
			if (event.type === "progress") window.__recordProgress?.(event.text);
		});
	});

	const STATE = join(USER_DATA, "settings", "settings-state.json");
	const readState = () => JSON.parse(readFileSync(STATE, "utf8")).settings;
	const readConfig = () => JSON.parse(readFileSync(CONFIG, "utf8"));
	const MCP = join(AGENT_DIR, "mcp.json");
	const readMcp = () => (existsSync(MCP) ? JSON.parse(readFileSync(MCP, "utf8")) : { mcpServers: {} });

	await page.locator(".sidebar__item--settings").click();
	const turnsSeen = new Map();
	/** Open a Settings page, ask its assistant, and wait for the turn to finish; returns the assistant's reply text. */
	const ask = async (nav, surface, text) => {
		await page.locator(".settings-nav-item", { hasText: nav }).first().click();
		const panel = page.locator(`[data-testid="app-customizer-panel"][data-surface="${surface}"]:not([hidden])`);
		await panel.waitFor();
		const before = turnsSeen.get(surface) ?? 0;
		const input = panel.locator('textarea[data-testid="app-customizer-input"]');
		await input.click();
		await page.keyboard.type(text);
		await page.keyboard.press("Enter");
		try {
			await page.waitForFunction(
				({ surface: s, count }) => {
					const root = document.querySelector(`[data-testid="app-customizer-panel"][data-surface="${s}"]`);
					const last = (root?.querySelectorAll(".customizer-turn") ?? [])[count];
					// The send button turns into a mic when the box is empty, so a finished turn is one with no stop button.
					return last !== undefined && last.querySelector(".customizer-turn__reply, .customizer-turn__error") !== null && root?.querySelector('[data-action="stop-customizer-message"]') === null;
				},
				{ surface, count: before },
				{ timeout: 150_000 },
			);
		} catch (cause) {
			await page.screenshot({ path: join(EVIDENCE, `timeout-${surface}.png`) }).catch(() => undefined);
			console.log(`[${surface}] TIMEOUT. panel text: ${(await panel.innerText().catch(() => "?")).replace(/\s+/g, " ").slice(0, 600)}`);
			throw cause;
		}
		turnsSeen.set(surface, before + 1);
		const turn = panel.locator(".customizer-turn").nth(before);
		const reply = (await turn.locator(".customizer-turn__reply").allInnerTexts()).join("\n\n");
		console.log(`[${surface}] ${text}\n  -> ${reply.replace(/\n+/g, " ").slice(0, 300)}`);
		return { reply, pills: await turn.locator(".customizer-change-pill").allInnerTexts() };
	};

	// 1. 일반: two real preferences, then a setting the assistant must not touch.
	{
		const run = await ask("일반", "general", "화면을 어두운 모드로 바꾸고 숨김 파일도 보이게 해줘.");
		await shot("01-general-dark-hidden");
		const state = readState();
		check("일반: appearance=dark and showHiddenFiles=true persisted in settings-state.json", state.appearance === "dark" && state.showHiddenFiles === true, JSON.stringify({ a: state.appearance, h: state.showHiddenFiles }));
		check("일반: a change pill is shown for the turn", run.pills.length >= 1, JSON.stringify(run.pills));
		const appearanceShown = await page.locator(".settings-plain-row", { hasText: "다크" }).first().innerText().catch(() => "");
		check("일반: the page beside the sidebar already shows the dark choice", /다크|어두/.test(appearanceShown), appearanceShown.replace(/\s+/g, " "));
		await ask("일반", "general", "그리고 원격 접속도 켜 주고, AI 파일 변경 승인은 전부 자동으로 해줘.");
		const after = readState();
		check("일반: remote access and approval mode were NOT changed by the assistant", after.remoteAccess === false && after.approvalMode === state.approvalMode, JSON.stringify({ r: after.remoteAccess, m: after.approvalMode }));
	}

	// 2. 웹 검색
	{
		await ask("웹 검색", "web", "웹 검색 서비스는 DuckDuckGo로 바꿔줘.");
		await shot("02-web-duckduckgo");
		check("웹 검색: webSearch.provider=duckduckgo written to config.json", readConfig().webSearch?.provider === "duckduckgo", JSON.stringify(readConfig().webSearch));
		await ask("웹 검색", "web", "웹 검색을 꺼줘.");
		const web = readConfig().webSearch;
		check("웹 검색: switching it off keeps the provider and sets enabled=false", web === false || web?.enabled === false, JSON.stringify(web));
		await page.waitForTimeout(500);
		const useSwitch = page.locator('.settings-plain-row [role="switch"]').first();
		check("웹 검색: the page beside the sidebar shows web search switched off without reopening it", (await useSwitch.getAttribute("aria-checked")) === "false");
	}

	// 3. AI 모델: thinking depth, and a model the person has not connected.
	{
		const before = readConfig();
		await ask("AI 모델", "ai", "답변할 때 생각을 가장 깊게 하도록 바꿔줘.");
		await shot("03-ai-thinking");
		const level = readConfig().thinking?.final;
		check("AI 모델: thinking.final is the deepest level (high or max)", level === "max" || level === "high", String(level));
		await ask("AI 모델", "ai", "답변 모델을 연결하지 않은 서비스의 모델 gpt-5-ultra-nonexistent로 바꿔줘.");
		check("AI 모델: an unknown/unconnected model was refused, the answer model is unchanged", JSON.stringify(readConfig().model) === JSON.stringify(before.model), JSON.stringify(readConfig().model));
	}

	// 4. 인덱싱: a real folder, its refresh cadence, and one that does not exist.
	{
		const folder = join(HOME_DIR, "Documents", "Projects");
		mkdirSync(folder, { recursive: true });
		await ask("인덱싱", "indexing", `${folder} 폴더를 검색할 폴더에 추가하고, 1시간마다 자동으로 최신화되게 해줘. ${join(HOME_DIR, "no-such-folder")} 도 추가해줘.`);
		await shot("04-indexing-folder");
		const cfg = readConfig();
		check("인덱싱: the existing folder is a search folder (or already covered by its parent)", cfg.searchPaths.includes(folder) || cfg.searchPaths.includes(join(HOME_DIR, "Documents")), JSON.stringify(cfg.searchPaths));
		check("인덱싱: the folder that does not exist was refused", !cfg.searchPaths.includes(join(HOME_DIR, "no-such-folder")), JSON.stringify(cfg.searchPaths));
		check("인덱싱: appIndexing.refreshIntervalMs is one hour", cfg.appIndexing?.refreshIntervalMs === 3_600_000, JSON.stringify(cfg.appIndexing));
	}

	// 5. 문서 읽기
	{
		await ask("일반", "general", "한국어와 일본어 문서를 읽게 해줘.");
		await shot("05-reading-languages");
		const languages = readConfig().languages;
		check("문서 읽기: languages = [ko, ja]", Array.isArray(languages) && languages.length === 2 && languages.includes("ko") && languages.includes("ja"), JSON.stringify(languages));
	}

	// 6. 중복 파일 정리
	{
		await ask("중복 파일 정리", "duplicates", "버전이 다른 파일 찾기를 꺼주고, 점검은 하루에 한 번만 하게 해줘.");
		await shot("06-duplicates");
		const dupey = readConfig().dupey;
		check("중복 파일 정리: version scan is off in config.json", dupey === false || dupey?.enabled === false, JSON.stringify(dupey));
		check("중복 파일 정리: scan interval 1440 min lands in settings-state.json", readState().dupeyScanIntervalMinutes === 1440, String(readState().dupeyScanIntervalMinutes));
	}

	// 7. MCP 서버: add, then remove only because the person asked for it by name.
	{
		await ask("MCP 서버", "mcp", "https://example.com/mcp 주소의 MCP 서버를 docs 라는 이름으로 추가해줘.");
		await shot("07-mcp-added");
		check("MCP 서버: docs server is in the agent's mcp.json", readMcp().mcpServers?.docs?.url === "https://example.com/mcp", JSON.stringify(readMcp()));
		check("MCP 서버: the page lists the new server at once", (await page.locator('[data-mcp-server="docs"]').count()) === 1);
		await ask("MCP 서버", "mcp", "방금 추가한 docs 서버를 지워줘.");
		check("MCP 서버: docs server is removed after the explicit request", readMcp().mcpServers?.docs === undefined, JSON.stringify(readMcp()));
	}

	// 8. 모든 연결: read-only question, nothing may change.
	{
		const before = JSON.stringify(readConfig().datasources ?? {});
		const run = await ask("모든 연결", "apps", "지금 연결된 앱이 어떤 상태인지 알려줘.");
		await shot("08-apps-status");
		check("모든 연결: answers in words and changes nothing", run.reply.trim().length > 0 && run.pills.length === 0 && JSON.stringify(readConfig().datasources ?? {}) === before, JSON.stringify(run.pills));
	}

	check("Real LLM streamed live `i` progress phrases while it called tools", seenProgress.length >= 6, JSON.stringify(seenProgress.slice(0, 8)));

	// Hiding the right sidebar shows the page's own invitation to the assistant.
	await page.locator('button[aria-label="정보 가리기"], button[aria-label="Hide inspector"]').first().click();
	await page.locator(".settings-nav-item", { hasText: "웹 검색" }).first().click();
	await page.locator('[data-assistant-hero="web"]').waitFor();
	await shot("09-web-hero-sidebar-hidden");
	check("웹 검색: the page head offers the assistant while the right sidebar is hidden", (await page.locator('[data-assistant-hero="web"]').count()) === 1);
} finally {
	await app.close().catch(() => undefined);
	service.close();
	rmSync(WORK, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
	process.exit(1);
}
console.log("\nAll live config assistant checks passed.");
