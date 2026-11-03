/**
 * Live end-to-end QA: Right-click Context Menu customization & Magic Actions
 * with a real 2026+ LLM (`deepseek/deepseek-v4.1-flash`, created=2026-09-10)
 * through the Dazzi account.
 *
 * Exercises:
 *   1. Real `app-customizer` pi agent profile called from Settings → 우클릭 메뉴:
 *      - Hides `7z로 압축` and `경로 복사`, attempts to hide `태그` (kept locked!),
 *        moves `magic` section to the top, and creates a real `organize`-mode
 *        AI Magic Action for Markdown files (`회의록 액션아이템 추출`) plus a multi-file
 *        shell script Magic Action (`파일 줄 수 합산`).
 *   2. Real Finder right-click on `weekly-meeting.md`:
 *      - Verifies condition matching (single `.md` shows AI Magic Action, hides
 *        multi-only script, hides `7z로 압축` & `경로 복사`, keeps `태그` swatches).
 *      - Clicks the AI Magic Action → runs real `magic-action` pi agent loop with
 *        real 2026+ LLM tool calls (`read`, `write`) → creates `action-items.md`
 *        on disk and streams live `i` progress + Markdown summary in `MagicActionDialog`!
 *   3. Multi-selects `weekly-meeting.md` + `notes.md` and right-clicks → runs the
 *      batch script Magic Action and verifies output in `MagicActionDialog`.
 *
 * Run in a VM (forwarding token via `--token`) or with `QA_DAZZI_TOKEN`:
 *   bun run qa script --vm --skip-build scripts/manual-qa/run-qa-live-context-menu-magic-actions.mjs --token "$TOKEN"
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { isMac, rmRetry } from "./platform.mjs";

const REAL_API = "https://api.dazziapp.com";
const MODEL_ID = process.env.QA_LIVE_MODEL?.trim() || "deepseek/deepseek-v4.1-flash";
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-context-menu-magic-actions");
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

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-live-cmenu-"));
const HOME_DIR = join(WORK, "home");
const DOCS_DIR = join(HOME_DIR, "Documents");
const AGENT_DIR = join(WORK, "pi-agent");
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const USER_DATA = join(WORK, "user-data");

for (const folder of ["Desktop", "Documents", "Downloads", "Music", "Movies", "Pictures", ".Trash"]) {
	mkdirSync(join(HOME_DIR, folder), { recursive: true });
}
writeFileSync(
	join(DOCS_DIR, "weekly-meeting.md"),
	[
		"# 주간 제품 회의 (2026-11-02)",
		"- 김민수: 우클릭 매직 액션 설정 UI 마감 (11월 5일까지)",
		"- 박지영: 윈도우 QA 자동화 점검 (11월 6일까지)",
		"- 이현우: 릴리스 노트 초안 공유 (11월 7일까지)",
	].join("\n"),
	"utf8",
);
writeFileSync(join(DOCS_DIR, "notes.md"), "첫 번째 메모\n두 번째 메모\n", "utf8");

mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(join(AUTORAG_HOME, "bin"), { recursive: true });
mkdirSync(join(AGENT_DIR, "skills", "meeting-checklist"), { recursive: true });
writeFileSync(
	join(AGENT_DIR, "skills", "meeting-checklist", "SKILL.md"),
	"---\nname: meeting-checklist\ndescription: Format action-items markdown files with owner headings and checkboxes.\n---\nAlways use `- [ ]` checkboxes under each owner's `##` heading.\n",
	"utf8",
);
const liveMcpScript = join(WORK, "aside-live-mcp.mjs");
writeFileSync(
	liveMcpScript,
	[
		'import { createInterface } from "node:readline";',
		'const rl = createInterface({ input: process.stdin });',
		'const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");',
		'rl.on("line", (line) => {',
		'  if (!line.trim()) return;',
		'  const req = JSON.parse(line);',
		'  if (req.method === "initialize") {',
		'    send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "aside", version: "1.0.0" } } });',
		'  } else if (req.method === "tools/list") {',
		'    send({ jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "memory_search", description: "Search Aside browser memory notes about team members and QA environments", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }] } });',
		'  } else if (req.method === "tools/call") {',
		'    send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "Aside Note: 박지영 윈도우 QA 대상 환경은 Windows 11 Build 26200 (ARM64/x64) 입니다." }] } });',
		'  } else if (req.id !== undefined) {',
		'    send({ jsonrpc: "2.0", id: req.id, result: {} });',
		'  }',
		'});',
	].join("\n"),
	"utf8",
);
writeFileSync(
	join(AGENT_DIR, "mcp.json"),
	JSON.stringify({
		mcpServers: {
			aside: { command: "node", args: [liveMcpScript], exposure: "direct" },
		},
	}),
	"utf8",
);
const minsyncStub = join(AUTORAG_HOME, "bin", "minsync");
writeFileSync(minsyncStub, "#!/bin/sh\nexit 0\n");
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
await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${service.address().port}`;

const baseConfig = {
	searchPaths: [DOCS_DIR],
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

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rowFor = (page, name) =>
	page
		.locator('[role="row"]')
		.filter({ has: page.locator(".row__label", { hasText: new RegExp(`^${escapeRegExp(name)}$`) }) })
		.first();

const env = {
	HOME: HOME_DIR,
	AUTORAG_HOME,
	AUTORAG_CONFIG: CONFIG,
	AUTORAG_QA_ROOT: DOCS_DIR,
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

	const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
	cfg.model = baseConfig.model;
	const configJsonBefore = `${JSON.stringify(cfg, null, 2)}\n`;
	writeFileSync(CONFIG, configJsonBefore);
	console.log(`live model: ${MODEL_ID}`);

	const shot = async (name) => {
		await page.waitForTimeout(400);
		await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
	};

	const seenCustomizerProgress = [];
	const seenMagicProgress = [];
	await page.exposeFunction("__recordCustProgress", (text) => seenCustomizerProgress.push(text)).catch(() => undefined);
	await page.exposeFunction("__recordMagicProgress", (text) => seenMagicProgress.push(text)).catch(() => undefined);
	await page.evaluate(() => {
		window.autorag.appCustomizer.onEvent((ev) => {
			if (ev.type === "progress") window.__recordCustProgress?.(ev.text);
		});
		window.autorag.magicAction.onEvent((ev) => {
			if (ev.type === "progress") window.__recordMagicProgress?.(ev.text);
		});
	});

	// 1. Open Settings → 우클릭 메뉴 → AI로 커스텀하기
	await page.locator(".sidebar__item--settings").click();
	await page.locator(".settings-nav-item", { hasText: "우클릭 메뉴" }).click();
	await page.locator("h1.linear-title", { hasText: "우클릭 메뉴" }).waitFor();

	const panel = page.locator('[data-testid="app-customizer-panel"][data-surface="contextMenu"]');
	await panel.waitFor();
	await shot("01-live-cmenu-panel-open");

	// Ask real 2026+ LLM to customize the context menu & create two Magic Actions (one organize agent, one multi-file script)
	const input = panel.locator('textarea[data-testid="app-customizer-input"]');
	await input.click();
	await page.keyboard.type(
		[
			"우클릭 메뉴를 다음처럼 커스텀해줘:",
			"1) 기본 항목 중 '7z로 압축'과 '경로 복사'를 숨기고, '태그'도 숨길 수 있으면 숨겨봐. 그리고 magic 섹션을 맨 위로 올려줘.",
			"2) 단일 md 파일(extensions: ['md'], selection: 'single', targetKind: 'file')을 우클릭했을 때 실행되는 AI 매직 액션(label: '액션아이템 추출', executionKind: 'agent', agentMode: 'organize')을 추가해줘. 프롬프트는 '선택한 마크다운 회의록을 읽고, 연결된 aside MCP의 memory_search 도구로 윈도우 QA 환경 메모를 조회한 뒤, 같은 폴더에 action-items.md 파일로 담당자별 할 일과 조회한 빌드 번호를 함께 저장하고 요약해줘'로 설정해.",
			"3) 여러 파일(selection: 'multiple', targetKind: 'file')을 우클릭했을 때 줄 수를 세어주는 스크립트 매직 액션(label: '줄 수 합산', executionKind: 'script', command: 'wc -l \"$@\"')도 추가해줘.",
		].join(" "),
	);
	await page.keyboard.press("Enter");

	await page.waitForFunction(
		() => {
			const panel = document.querySelector('[data-testid="app-customizer-panel"]:not([hidden])');
			const settled = panel?.querySelector(".customizer-turn__reply, .customizer-turn__error");
			const sendBtn = document.querySelector('[data-action="send-customizer-message"]');
			return settled !== null && settled !== undefined && sendBtn !== null;
		},
		null,
		{ timeout: 240_000 },
	);
	await shot("02-live-cmenu-turn1-done");

	const custError = await panel.locator(".customizer-turn__error").count();
	check("Real LLM finished the context-menu turn without an error", custError === 0, custError === 0 ? "" : await panel.locator(".customizer-turn__error").first().innerText());
	const custReply = custError === 0 ? await panel.locator(".customizer-turn__reply").first().innerText() : "";
	console.log(`live customizer reply:\n${custReply}`);
	console.log(`live customizer progress: ${JSON.stringify(seenCustomizerProgress)}`);

	await panel.locator('[data-action="collapse-app-customizer"]').click();
	await panel.waitFor({ state: "hidden" });
	await shot("03-live-settings-after-ai");

	const settingsPath = join(USER_DATA, "settings", "settings-state.json");
	const persisted = JSON.parse(readFileSync(settingsPath, "utf8"));
	const savedMenu = persisted.settings.contextMenu;
	check(
		"Real LLM streamed `i` progress phrases during context menu customization",
		seenCustomizerProgress.length >= 1,
		JSON.stringify(seenCustomizerProgress),
	);
	check(
		"Real LLM hid 7z & copyPath while keeping Tags out of hiddenItems & hiddenSections",
		savedMenu.hiddenItems.includes("builtin:compress7z") &&
			savedMenu.hiddenItems.includes("builtin:copyPath") &&
			!savedMenu.hiddenItems.includes("builtin:tags") &&
			!savedMenu.hiddenSections.includes("tags"),
		JSON.stringify(savedMenu),
	);
	const agentAction = savedMenu.magicActions.find((a) => a.execution.kind === "agent");
	const scriptAction = savedMenu.magicActions.find((a) => a.execution.kind === "script");
	check(
		"Real LLM created both the single-md organize agent Magic Action and the multi-file script Magic Action",
		agentAction !== undefined && scriptAction !== undefined,
		JSON.stringify(savedMenu.magicActions),
	);

	// 2. Navigate to Documents, right-click single `weekly-meeting.md`, and run the real AI Magic Action!
	await page.locator(".sidebar .sidebar__item", { hasText: "문서" }).click();
	await rowFor(page, "weekly-meeting.md").waitFor({ timeout: 20_000 });
	await rowFor(page, "weekly-meeting.md").click({ button: "right" });
	await page.waitForSelector('[role="menuitem"]');
	await shot("04-live-right-click-single-md");

	const singleMenuLabels = await page.locator('.menu [role="menuitem"] .menu__label').allInnerTexts();
	check(
		"Right-click on single weekly-meeting.md shows agent Magic Action, hides multi-only script & hidden built-ins",
		agentAction !== undefined &&
			singleMenuLabels.includes(agentAction.label) &&
			(scriptAction === undefined || !singleMenuLabels.includes(scriptAction.label)) &&
			!singleMenuLabels.includes("7z로 압축") &&
			!singleMenuLabels.includes("경로 복사"),
		JSON.stringify(singleMenuLabels),
	);

	await page.locator(`[data-magic-action-id="${agentAction.id}"]`).click();
	const dialog = page.locator('[data-testid="magic-action-dialog"]');
	await dialog.waitFor({ timeout: 15_000 });

	// Wait for the real 2026+ LLM agent loop to finish reading weekly-meeting.md and writing action-items.md
	await page.waitForFunction(
		() => {
			const closeBtn = document.querySelector('[data-testid="magic-action-dialog"] [data-action="close-magic-action"]');
			const out = document.querySelector('[data-testid="magic-action-output"]');
			return closeBtn !== null && out !== null && (out.textContent ?? "").trim().length > 0;
		},
		null,
		{ timeout: 150_000 },
	);
	await shot("05-live-agent-magic-action-done");

	const agentOut = await dialog.locator('[data-testid="magic-action-output"]').innerText();
	console.log(`live magic-action agent output:\n${agentOut}`);
	console.log(`live magic-action progress: ${JSON.stringify(seenMagicProgress)}`);

	const createdFile = join(DOCS_DIR, "action-items.md");
	check(
		"Real LLM Magic Action agent called connected Aside MCP (`26200`), wrote action-items.md on disk, and streamed `i` progress",
		seenMagicProgress.length >= 1 &&
			existsSync(createdFile) &&
			readFileSync(createdFile, "utf8").includes("김민수") &&
			readFileSync(createdFile, "utf8").includes("26200"),
		existsSync(createdFile) ? readFileSync(createdFile, "utf8") : "action-items.md missing",
	);

	await dialog.locator('[data-action="close-magic-action"]').click();
	await dialog.waitFor({ state: "detached" });

	// 3. Multi-select `weekly-meeting.md` + `notes.md` and run the multi-file script Magic Action
	const meta = isMac ? "Meta" : "Control";
	await rowFor(page, "weekly-meeting.md").click();
	await rowFor(page, "notes.md").click({ modifiers: [meta] });
	await rowFor(page, "weekly-meeting.md").click({ button: "right" });
	await page.waitForSelector('[role="menuitem"]');
	await shot("06-live-right-click-multi-md");

	const multiMenuLabels = await page.locator('.menu [role="menuitem"] .menu__label').allInnerTexts();
	check(
		"Right-click on 2 selected files shows multi-file script Magic Action and hides single-only action",
		scriptAction !== undefined &&
			multiMenuLabels.includes(scriptAction.label) &&
			(agentAction === undefined || !multiMenuLabels.includes(agentAction.label)),
		JSON.stringify(multiMenuLabels),
	);

	await page.locator(`[data-magic-action-id="${scriptAction.id}"]`).click();
	await dialog.waitFor({ timeout: 15_000 });
	await page.waitForFunction(
		() => document.querySelector('[data-testid="magic-action-dialog"] [data-action="close-magic-action"]') !== null,
		null,
		{ timeout: 30_000 },
	);
	await shot("07-live-script-magic-action-done");

	const scriptOut = await dialog.locator('[data-testid="magic-action-output"]').innerText();
	check(
		"Multi-file script Magic Action executed wc -l across both files",
		scriptOut.includes("weekly-meeting.md") && scriptOut.includes("notes.md"),
		scriptOut,
	);
} finally {
	await app.close().catch(() => undefined);
	service.close();
	try {
		rmRetry(WORK);
	} catch {
		rmSync(WORK, { recursive: true, force: true });
	}
}

if (failures.length > 0) {
	console.error(`LIVE QA FAILED (${failures.length}): ${failures.join(", ")}`);
	process.exit(1);
}
console.log("ALL LIVE CONTEXT MENU & MAGIC ACTION CHECKS PASSED");
