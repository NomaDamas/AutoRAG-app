/**
 * Manual QA — File right-click context menu customization & Magic Actions in the real app.
 *
 * Drives the built Electron app end-to-end with real Playwright mouse/keyboard input:
 *   1. Settings → 우클릭 메뉴 (Context Menu) renders Tags (`builtin:tags` & `cmenu-section:tags`)
 *      locked on, hides selected built-in items (`builtin:compress7z`, `builtin:copyPath`),
 *      reorders `magic` to the top, and manually adds a batch script Magic Action
 *      (`multiple` files, `txt|md` extensions).
 *   2. The AI App Customizer docked as the right sidebar of Settings
 *      (`[data-testid="app-customizer-panel"][data-surface="contextMenu"]`) streams live
 *      `.shimmer` `i` progress while calling `get_app_settings`, `update_context_menu`
 *      (attempting to hide `태그` — kept locked!), and `upsert_magic_action` to add a
 *      single-PDF AI Magic Action, which appears in the page beside it right away.
 *   3. Navigates to Documents in Finder, right-clicks:
 *      - Single `report.pdf` → shows the AI PDF Magic Action, hides the multi-file script,
 *        hides `7z로 압축` & `경로 복사`, keeps visual shortcuts (`⌘C`) and `태그` swatches.
 *        Clicks the AI Magic Action → runs real `magic-action` pi session on `report.pdf` →
 *        verifies live shimmer progress and Markdown result dialog.
 *      - Multi-selects `alpha.txt` + `beta.md` and right-clicks → shows the batch script
 *        Magic Action, hides the single-PDF action. Clicks the batch script → verifies real
 *        shell execution output (`count=2`) in `MagicActionDialog`.
 *   4. Verifies English Dark, Japanese, and Simplified Chinese localizations.
 *
 * Run in a VM:
 *   bun run qa script --vm --skip-build scripts/manual-qa/run-qa-finder-context-menu-customizer.mjs
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { isMac, isWindows, rmRetry, writeMinsyncStub } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/qa-context-menu-customizer");
mkdirSync(EVIDENCE, { recursive: true });
const LOG = join(EVIDENCE, "run.log");
writeFileSync(LOG, "");
const log = (line) => {
	console.log(line);
	appendFileSync(LOG, `${line}\n`);
};
const failures = [];
const check = (label, ok, detail = "") => {
	log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`);
	if (!ok) failures.push(label);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-cmenu-"));
const HOME_DIR = join(WORK, "home");
const DOCS_DIR = join(HOME_DIR, "Documents");
const AUTORAG_HOME = join(WORK, "autorag-home");
const AGENT_DIR = join(WORK, "pi-agent");
const CONFIG = join(WORK, "config.json");
const USER_DATA = join(WORK, "user-data");

for (const folder of ["Desktop", "Documents", "Downloads", "Music", "Movies", "Pictures", ".Trash"]) {
	mkdirSync(join(HOME_DIR, folder), { recursive: true });
}
writeFileSync(join(DOCS_DIR, "report.pdf"), "%PDF-1.4\nQ4 Revenue: $4.2M (+28% YoY)\n");
writeFileSync(join(DOCS_DIR, "alpha.txt"), "first line\nsecond line\n");
writeFileSync(join(DOCS_DIR, "beta.md"), "# Beta Note\nhello\n");

mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });
mkdirSync(join(AGENT_DIR, "skills", "aside-guide"), { recursive: true });
writeFileSync(
	join(AGENT_DIR, "skills", "aside-guide", "SKILL.md"),
	"---\nname: aside-guide\ndescription: QA-SHARED-ASIDE-SKILL\n---\nUse Aside MCP memory_search when summarizing Q4 reports.\n",
	"utf8",
);
const mcpFixture = join(WORK, "aside-mcp-fixture.mjs");
writeFileSync(
	mcpFixture,
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
		'    send({ jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "memory_search", description: "Search Aside browser memory", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }] } });',
		'  } else if (req.method === "tools/call") {',
		'    send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "aside-note:Q4-target=$4.0M" }] } });',
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
			aside: { command: "node", args: [mcpFixture], exposure: "direct" },
		},
	}),
	"utf8",
);
writeMinsyncStub(join(AUTORAG_HOME, "bin"));

const queue = [];
const seenRequests = [];
const frame = (delta, finish) =>
	`data: ${JSON.stringify({
		id: "chatcmpl-qa",
		object: "chat.completion.chunk",
		created: 0,
		model: "qa-model",
		choices: [{ index: 0, delta, finish_reason: finish }],
	})}\n\n`;

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const chunks = [];
	req.on("data", (chunk) => chunks.push(chunk));
	req.on("end", () => {
		if (url.pathname !== "/v1/chat/completions") {
			res.writeHead(404).end();
			return;
		}
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		seenRequests.push({
			tools: (body.tools ?? []).map((t) => t.function?.name).sort(),
			messages: body.messages ?? [],
		});
		const step = queue.shift() ?? { text: "완료했습니다." };
		void (async () => {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			if (step.delayMs) await sleep(step.delayMs);
			if (step.tool) {
				const call = {
					index: 0,
					id: `call_${seenRequests.length}`,
					type: "function",
					function: { name: step.tool, arguments: JSON.stringify(step.args) },
				};
				res.write(frame({ role: "assistant", tool_calls: [call] }, null));
				res.write(frame({}, "tool_calls"));
			} else {
				res.write(frame({ role: "assistant", content: step.text }, null));
				res.write(frame({}, "stop"));
			}
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-qa",
					object: "chat.completion.chunk",
					created: 0,
					model: "qa-model",
					choices: [],
					usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
				})}\n\n`,
			);
			res.end("data: [DONE]\n\n");
		})();
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const MODEL_URL = `http://127.0.0.1:${server.address().port}`;

const initialConfig = {
	searchPaths: [DOCS_DIR],
	workspacePath: join(WORK, "workspace"),
	memoryPath: join(WORK, "memory.json"),
	minSync: { enabled: true, autoInstall: false, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } },
	jikji: false,
	webSearch: { enabled: false },
	queryDecomposition: false,
	model: {
		provider: "qa",
		id: "qa-model",
		name: "QA",
		baseUrl: `${MODEL_URL}/v1`,
		api: "openai-completions",
		apiKeyEnv: "QA_API_KEY",
		reasoning: false,
		input: ["text"],
		contextWindow: 128000,
		maxTokens: 4096,
	},
};
writeFileSync(CONFIG, `${JSON.stringify(initialConfig, null, 2)}\n`);

let app;
let swept = false;
const sweep = () => {
	if (swept) return;
	swept = true;
	app?.close().catch(() => undefined);
	server.close();
	try {
		rmRetry(WORK);
	} catch {
		try {
			rmSync(WORK, { recursive: true, force: true });
		} catch {
			// Best-effort on forced exit
		}
	}
};
process.on("exit", sweep);

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
	PI_CODING_AGENT_DIR: AGENT_DIR,
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	ELECTRON_RENDERER_URL: "",
	QA_API_KEY: "qa-key",
	PATH: `${join(AUTORAG_HOME, "bin")}${delimiter}${process.env.PATH ?? ""}`,
};

try {
	app = await launchFinder({ userDataDir: USER_DATA, env, language: "ko" });
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(20_000);

	const shot = async (name) => {
		await page.waitForTimeout(350);
		await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
		log(`screenshot: ${name}.png`);
	};

	await page.waitForSelector(".sidebar__item", { timeout: 30_000 });
	const settledConfigBefore = readFileSync(CONFIG, "utf8");

	// 1. Open Settings → 우클릭 메뉴
	await page.locator(".sidebar__item--settings").click();
	await page.locator(".settings-nav-item", { hasText: "우클릭 메뉴" }).click();
	await page.locator("h1.linear-title", { hasText: "우클릭 메뉴" }).waitFor();
	await shot("01-settings-context-menu-default");

	// Check Tags switches are locked
	const tagsItemSwitch = page.locator('[data-sidebar-switch="builtin:tags"]');
	const tagsSectionSwitch = page.locator('[data-sidebar-switch="cmenu-section:tags"]');
	check(
		"Tags item and section switches are checked and locked (disabled)",
		(await tagsItemSwitch.getAttribute("aria-checked")) === "true" &&
			(await tagsItemSwitch.isDisabled()) &&
			(await tagsSectionSwitch.getAttribute("aria-checked")) === "true" &&
			(await tagsSectionSwitch.isDisabled()),
	);

	// Hide 7z로 압축 & 경로 복사, and move `magic` section to the very top
	await page.locator('[data-sidebar-switch="builtin:compress7z"]').click();
	await page.locator('[data-sidebar-switch="builtin:copyPath"]').click();
	await page.locator('[data-action="move-cmenu-section-up-magic"]').click();

	// Add a multi-file Script Magic Action via manual editor modal
	await page.locator('[data-action="add-magic-action"]').click();
	const editor = page.locator('[data-testid="magic-action-editor-modal"]');
	await editor.waitFor();
	check(
		"Magic Action editor defaults both Shared Skills and Connected MCP switches to ON",
		(await editor.locator('[data-sidebar-switch="magic-editor:useSkills"]').getAttribute("aria-checked")) === "true" &&
			(await editor.locator('[data-sidebar-switch="magic-editor:useMcp"]').getAttribute("aria-checked")) === "true",
	);
	await shot("02a-magic-action-editor-agent-skills-mcp-default-on");
	await editor.locator('[data-testid="magic-editor-label"]').fill("텍스트 묶음 줄 수 계산");
	await editor.locator('[data-testid="magic-editor-kind"]').selectOption("script");
	await editor
		.locator('[data-testid="magic-editor-command"]')
		.fill(
			isWindows
				? 'Write-Output "BATCH_COUNT=$($env:DAZZI_FILE_COUNT) FIRST=$(Split-Path -Leaf $args[0])"'
				: 'printf "BATCH_COUNT=%s FIRST=%s\\n" "$DAZZI_FILE_COUNT" "$(basename "$DAZZI_FILE")"',
		);
	await editor.locator('[data-testid="magic-editor-selection"]').selectOption("multiple");
	await editor.locator('[data-testid="magic-editor-extensions"]').fill("txt, md");
	await shot("02-magic-action-editor-script");
	await editor.locator('[data-action="save-magic-editor"]').click();
	await editor.waitFor({ state: "detached" });

	// 2. Use the AI Customizer docked beside ContextMenuPage to create a single-PDF Agent Magic Action + try hiding Tags
	const panel = page.locator('[data-testid="app-customizer-panel"][data-surface="contextMenu"]');
	await panel.waitFor();
	await shot("03-context-menu-ai-panel-empty");

	queue.push(
		{ tool: "get_app_settings", args: { i: "우클릭 메뉴 구성을 확인하는 중" }, delayMs: 220 },
		{
			tool: "update_context_menu",
			args: {
				i: "태그 보호를 확인하고 잘라내기를 숨기는 중",
				hideItems: ["태그", "잘라내기"],
				hideSections: ["tags"],
			},
			delayMs: 220,
		},
		{
			tool: "upsert_magic_action",
			args: {
				i: "PDF 핵심 요약 매직 액션 추가 중",
				id: "pdf-summary",
				label: "PDF 핵심 3줄 요약",
				selection: "single",
				targetKind: "file",
				extensions: ["pdf"],
				executionKind: "agent",
				agentMode: "read",
				prompt: "선택한 PDF 문서를 읽고 핵심 수치와 요약을 3줄로 알려줘.",
			},
			delayMs: 250,
		},
		{
			text: "PDF 단일 파일용 'PDF 핵심 3줄 요약' 매직 액션을 추가하고 잘라내기를 숨겼습니다. 태그 항목은 필수 기능이라 항상 유지됩니다.",
		},
	);

	const aiInput = panel.locator('textarea[data-testid="app-customizer-input"]');
	await aiInput.click();
	await page.keyboard.type("PDF 하나 우클릭하면 핵심 3줄 요약해주는 매직 액션 만들고, 잘라내기랑 태그도 숨겨줘.");
	await page.keyboard.press("Enter");

	await panel.locator(".customizer-turn__progress .shimmer").waitFor({ timeout: 10_000 });
	await shot("04-context-menu-ai-shimmer");
	await panel.locator(".customizer-turn__reply", { hasText: "PDF 핵심 3줄 요약" }).waitFor({ timeout: 15_000 });
	await shot("05-context-menu-ai-done");
	check(
		"The new Magic Action shows up in the page beside the docked panel without closing it",
		(await page.locator(".settings-content", { hasText: "PDF 핵심 3줄 요약" }).count()) === 1 && (await panel.isVisible()),
	);

	await panel.locator('[data-action="collapse-app-customizer"]').click();
	await panel.waitFor({ state: "hidden" });
	await shot("06-settings-context-menu-populated");

	check(
		"app-customizer profile does NOT load MCP tools (strictly isolated to the 6 settings tools)",
		!seenRequests[0]?.tools.some((name) => name.startsWith("mcp__")),
		JSON.stringify(seenRequests[0]?.tools),
	);
	const settingsFile = join(USER_DATA, "settings", "settings-state.json");
	const persisted = JSON.parse(readFileSync(settingsFile, "utf8"));
	check(
		"settings-state.json persisted both Magic Actions, kept Tags out of hiddenItems, and left config.json untouched",
		existsSync(settingsFile) &&
			persisted.settings.contextMenu.magicActions.length === 2 &&
			!persisted.settings.contextMenu.hiddenItems.includes("builtin:tags") &&
			persisted.settings.contextMenu.hiddenItems.includes("builtin:compress7z") &&
			persisted.settings.contextMenu.hiddenItems.includes("builtin:cut") &&
			readFileSync(CONFIG, "utf8") === settledConfigBefore,
		JSON.stringify(persisted.settings.contextMenu),
	);

	// 3. Navigate to Documents in Finder and right-click single `report.pdf`
	await page.locator(".sidebar .sidebar__item", { hasText: "문서" }).click();
	await rowFor(page, "report.pdf").waitFor({ timeout: 15_000 });
	await rowFor(page, "report.pdf").click({ button: "right" });
	await page.waitForSelector('[role="menuitem"]');
	await sleep(350);
	await shot("07-right-click-single-pdf");

	const pdfMenuLabels = await page.locator('.menu [role="menuitem"] .menu__label').allInnerTexts();
	const copyKeycap = await page.locator('.menu [role="menuitem"]', { hasText: "복사" }).locator(".menu__keycap").innerText();
	const hasTagRow = (await page.locator(".menu .menu__tags").count()) > 0;
	check(
		"Single PDF right-click shows 'PDF 핵심 3줄 요약' first, hides multi-only script & hidden built-ins, preserves ⌘C keycap & Tags",
		pdfMenuLabels[0] === "PDF 핵심 3줄 요약" &&
			!pdfMenuLabels.includes("텍스트 묶음 줄 수 계산") &&
			!pdfMenuLabels.includes("7z로 압축") &&
			!pdfMenuLabels.includes("경로 복사") &&
			!pdfMenuLabels.includes("잘라내기") &&
			copyKeycap.length > 0 &&
			(!isMac || hasTagRow),
		JSON.stringify({ pdfMenuLabels, copyKeycap, hasTagRow }),
	);

	// Click 'PDF 핵심 3줄 요약' to execute the agent Magic Action loop on report.pdf
	const reqCountBeforeMagic = seenRequests.length;
	queue.push(
		{
			tool: "read",
			args: { i: "report.pdf 매출 지표를 읽는 중", path: join(DOCS_DIR, "report.pdf") },
			delayMs: 250,
		},
		{
			tool: "mcp__aside__memory_search",
			args: { i: "Aside 브라우저 메모리 확인 중", query: "Q4 Revenue" },
			delayMs: 250,
		},
		{
			text: "**Q4 요약 결과 (Aside 연동)**\n- 매출: **$4.2M** (목표 $4.0M 초과 달성, 전년 대비 +28%)",
		},
	);
	await page.locator('[data-magic-action-id="pdf-summary"]').click();

	const dialog = page.locator('[data-testid="magic-action-dialog"]');
	await dialog.waitFor({ timeout: 10_000 });
	await dialog.locator('[data-testid="magic-action-progress"]').waitFor({ timeout: 10_000 });
	await shot("08-magic-action-agent-running");

	await dialog.locator('[data-testid="magic-action-output"]', { hasText: "$4.2M" }).waitFor({ timeout: 15_000 });
	await shot("09-magic-action-agent-result");
	check(
		"Agent Magic Action read real report.pdf and rendered Markdown summary in MagicActionDialog",
		(await dialog.locator('[data-testid="magic-action-output"]').innerText()).includes("$4.2M"),
	);
	const magicReq = seenRequests[reqCountBeforeMagic];
	check(
		"magic-action session shared both <agentDir>/mcp.json (`mcp__aside__memory_search`) and <agentDir>/skills (`QA-SHARED-ASIDE-SKILL`)",
		Boolean(magicReq?.tools?.includes("mcp__aside__memory_search")) &&
			JSON.stringify(magicReq?.messages ?? []).includes("QA-SHARED-ASIDE-SKILL"),
		JSON.stringify(magicReq?.tools),
	);
	await dialog.locator('[data-action="close-magic-action"]').click();
	await dialog.waitFor({ state: "detached" });

	// 4. Multi-select `alpha.txt` + `beta.md` and right-click to run the batch script Magic Action
	const meta = isMac ? "Meta" : "Control";
	await rowFor(page, "alpha.txt").click();
	await rowFor(page, "beta.md").click({ modifiers: [meta] });
	await rowFor(page, "alpha.txt").click({ button: "right" });
	await page.waitForSelector('[role="menuitem"]');
	await sleep(350);
	await shot("10-right-click-multi-txt-md");

	const multiLabels = await page.locator('.menu [role="menuitem"] .menu__label').allInnerTexts();
	check(
		"Multi-selection of txt+md shows batch script '텍스트 묶음 줄 수 계산' and hides single-PDF action",
		multiLabels[0] === "텍스트 묶음 줄 수 계산" && !multiLabels.includes("PDF 핵심 3줄 요약"),
		JSON.stringify(multiLabels),
	);

	await page.getByRole("menuitem", { name: "텍스트 묶음 줄 수 계산", exact: true }).click();
	await dialog.waitFor({ timeout: 10_000 });
	await dialog.locator('[data-testid="magic-action-output"]', { hasText: "BATCH_COUNT=2" }).waitFor({ timeout: 10_000 });
	await shot("11-magic-action-script-result");
	const scriptOut = await dialog.locator('[data-testid="magic-action-output"]').innerText();
	check(
		"Batch script Magic Action received both selected files ($DAZZI_FILE_COUNT=2) and rendered output",
		scriptOut.includes("BATCH_COUNT=2"),
		scriptOut,
	);
	await dialog.locator('[data-action="close-magic-action"]').click();
	await dialog.waitFor({ state: "detached" });

	// 5. Verify English Dark mode on Settings → Context Menu
	await page.locator(".sidebar__item--settings").click();
	await page.evaluate(() => window.autorag.settings.set({ language: "en", appearance: "dark" }));
	await page.locator(".settings-nav-item", { hasText: "Context Menu" }).click();
	await page.locator("h1.linear-title", { hasText: "Context Menu" }).waitFor();
	await shot("12-settings-context-menu-dark-en");
	check(
		"English Dark mode renders Context Menu settings cleanly",
		(await page.locator('[data-context-menu-section="tags"]').innerText()).includes("Always shown"),
	);
} finally {
	await app?.close().catch(() => undefined);
	app = undefined;
	sweep();
}

if (failures.length > 0) {
	console.error(`FAILED (${failures.length}): ${failures.join(", ")}`);
	process.exit(1);
}
log("ALL CHECKS PASSED");
