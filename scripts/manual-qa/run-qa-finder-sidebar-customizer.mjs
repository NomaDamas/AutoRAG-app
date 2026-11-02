/**
 * Manual QA — Sidebar customization & AI App Customizer modal in the real app.
 *
 * Drives the built Electron app end-to-end with real Playwright mouse/keyboard
 * input and a loopback OpenAI-compatible model endpoint:
 *   1. Settings → 사이드바 (Sidebar) renders locked switches for AI Search &
 *      Automations, toggles hideable favorite items, reorders Favorites, pins
 *      a custom folder, and immediately updates the live Finder sidebar and
 *      `<userData>/settings/settings-state.json` (leaving AutoRAG `config.json`
 *      untouched).
 *   2. Opening the AI App Customizer modal (`[data-action="open-app-customizer"]`)
 *      streams live `.shimmer` `i` intent progress while the `app-customizer`
 *      pi agent calls `get_app_settings` and `update_sidebar`, refuses to hide
 *      `AI Search` or `Automations`, updates the live Finder sidebar and
 *      Settings toggles in real time, and supports multi-turn follow-up.
 *   3. Verifies both Korean Light and English Dark visual states.
 *
 * Run in a VM:
 *   bun run qa script --vm --skip-build scripts/manual-qa/run-qa-finder-sidebar-customizer.mjs
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { rmRetry, writeMinsyncStub } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/qa-sidebar-customizer");
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

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-sidebar-"));
const HOME_DIR = join(WORK, "home");
const AUTORAG_HOME = join(WORK, "autorag-home");
const AGENT_DIR = join(WORK, "pi-agent");
const CONFIG = join(WORK, "config.json");
const USER_DATA = join(WORK, "user-data");
const PROJECTS_DIR = join(HOME_DIR, "Projects");

for (const folder of ["Desktop", "Documents", "Downloads", "Music", "Movies", "Pictures", ".Trash", "Projects"]) {
	mkdirSync(join(HOME_DIR, folder), { recursive: true });
}
mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });
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
		const step = queue.shift() ?? { text: "설정을 완료했습니다." };
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
	searchPaths: [join(HOME_DIR, "Documents")],
	workspacePath: join(WORK, "workspace"),
	memoryPath: join(WORK, "memory.json"),
	minSync: { enabled: true, autoInstall: false, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } },
	jikji: false,
	jev: false,
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
const configJsonBefore = `${JSON.stringify(initialConfig, null, 2)}\n`;
writeFileSync(CONFIG, configJsonBefore);

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
		rmSync(WORK, { recursive: true, force: true });
	}
};
process.on("exit", sweep);

const env = {
	HOME: HOME_DIR,
	AUTORAG_HOME,
	AUTORAG_CONFIG: CONFIG,
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

	const sidebarLabels = async () =>
		page.locator(".sidebar .sidebar__item-label").allInnerTexts();

	await page.waitForSelector(".sidebar__item", { timeout: 30_000 });
	const initialLabels = await sidebarLabels();
	check(
		"Sidebar starts with AI 검색 and 자동화 at top of Favorites",
		initialLabels[0] === "AI 검색" && initialLabels[1] === "자동화" && initialLabels.includes("음악") && initialLabels.includes("동영상"),
		JSON.stringify(initialLabels),
	);
	const settledConfigBefore = readFileSync(CONFIG, "utf8");

	// 1. Open Settings and navigate to 사이드바 tab
	await page.locator(".sidebar__item--settings").click();
	await page.locator(".settings-nav-item", { hasText: "사이드바" }).click();
	await page.locator("h1.linear-title", { hasText: "사이드바" }).waitFor();
	await shot("01-settings-sidebar-default");
	await page.locator(".settings-content").evaluate((el) => { el.scrollTop = el.scrollHeight; });
	await shot("01b-settings-sidebar-bottom-sections");
	await page.locator(".settings-content").evaluate((el) => { el.scrollTop = 0; });

	// Verify AI 검색 and 자동화 switches are checked and disabled
	const aiSwitch = page.locator('[data-sidebar-switch="app:aiSearch"]');
	const autoSwitch = page.locator('[data-sidebar-switch="app:automations"]');
	check(
		"AI 검색 and 자동화 switches in Settings are checked and locked (disabled)",
		(await aiSwitch.getAttribute("aria-checked")) === "true" &&
			(await aiSwitch.isDisabled()) &&
			(await autoSwitch.getAttribute("aria-checked")) === "true" &&
			(await autoSwitch.isDisabled()),
	);
	const sectionIds = await page.locator(".sidebar-sections-stack .sidebar-section-card").evaluateAll((els) => els.map((e) => e.getAttribute("data-sidebar-section")));
	check(
		"Favorites, Cloud, Connections, Locations, and Tags render together in one unified .sidebar-sections-stack",
		JSON.stringify(sectionIds) === JSON.stringify(["favorites", "cloud", "connections", "locations", "tags"]),
		JSON.stringify(sectionIds),
	);
	const heroLogoWidth = await page.locator("img.sidebar-ai-hero__logo").evaluate((img) => img.naturalWidth);
	check("AI Customizer hero displays the transparent Dazzi sunflower mark image", heroLogoWidth > 0, `naturalWidth=${heroLogoWidth}`);

	// Toggle Music and Movies off in Settings UI
	await page.locator('[data-sidebar-switch="place:music"]').click();
	await page.locator('[data-sidebar-switch="place:movies"]').click();
	// Move Downloads up above Documents
	await page.locator('[data-action="move-up-place:downloads"]').click();
	await page.waitForTimeout(250);

	const afterUiToggleLabels = await sidebarLabels();
	check(
		"Toggling Music & Movies in Settings immediately hides them in the live Finder sidebar while keeping AI 검색 & 자동화",
		afterUiToggleLabels[0] === "AI 검색" &&
			afterUiToggleLabels[1] === "자동화" &&
			!afterUiToggleLabels.includes("음악") &&
			!afterUiToggleLabels.includes("동영상") &&
			afterUiToggleLabels.indexOf("다운로드") < afterUiToggleLabels.indexOf("문서"),
		JSON.stringify(afterUiToggleLabels),
	);
	await shot("02-settings-sidebar-ui-toggled");

	// Check settings-state.json vs config.json on disk
	const settingsFile = join(USER_DATA, "settings", "settings-state.json");
	const persisted = JSON.parse(readFileSync(settingsFile, "utf8"));
	check(
		"Sidebar customization is persisted in Dazzi's settings-state.json and AutoRAG config.json is untouched",
		existsSync(settingsFile) &&
			JSON.stringify(persisted.settings.sidebar.hiddenItems) === JSON.stringify(["place:music", "place:movies"]) &&
			readFileSync(CONFIG, "utf8") === settledConfigBefore,
		JSON.stringify({ sidebar: persisted.settings.sidebar, configUnchanged: readFileSync(CONFIG, "utf8") === settledConfigBefore }),
	);

	// 2. Open AI App Customizer Modal and converse with the pi agent profile
	await page.locator('[data-action="open-app-customizer"]').click();
	const modal = page.locator('[data-testid="app-customizer-modal"]');
	await modal.waitFor();
	await shot("03-customizer-modal-empty");

	// Queue scripted agent steps: inspect -> update_sidebar (including trying to hide AI Search & Automations, pinning Projects, hiding pictures) -> reply
	queue.push(
		{ tool: "get_app_settings", args: { i: "현재 사이드바 설정을 확인하는 중" }, delayMs: 250 },
		{
			tool: "update_sidebar",
			args: {
				i: "그림 폴더를 숨기고 Projects 폴더를 고정하는 중",
				hideItems: ["app:aiSearch", "app:automations", "place:pictures"],
				addCustomFavorites: [{ path: PROJECTS_DIR, label: "Projects" }],
				favoritesOrder: ["custom:" + PROJECTS_DIR, "place:downloads", "place:documents"],
			},
			delayMs: 350,
		},
		{
			text: "그림 폴더를 추가로 숨기고 Projects 폴더를 즐겨찾기 상단에 고정했습니다. AI 검색과 자동화는 필수 기능이라 항상 표시됩니다.",
		},
	);

	const input = modal.locator('textarea[data-testid="app-customizer-input"]');
	await input.click();
	await page.keyboard.type("그림 폴더도 숨기고 Projects 폴더를 맨 위에 추가해줘. AI 검색도 숨겨봐.");
	await page.keyboard.press("Enter");

	// Capture live shimmer progress
	await modal.locator(".customizer-turn__progress .shimmer").waitFor({ timeout: 10_000 });
	await shot("04-customizer-modal-shimmer-progress");

	// Wait for turn reply
	await modal.locator(".customizer-turn__reply", { hasText: "Projects 폴더를 즐겨찾기 상단에 고정했습니다" }).waitFor({ timeout: 15_000 });
	await shot("05-customizer-modal-turn1-done");

	const afterAgentLabels = await sidebarLabels();
	check(
		"Pi agent tool call updates live Finder sidebar (pins Projects, hides 그림, keeps AI 검색 & 자동화 first)",
		afterAgentLabels[0] === "AI 검색" &&
			afterAgentLabels[1] === "자동화" &&
			afterAgentLabels[2] === "Projects" &&
			!afterAgentLabels.includes("그림"),
		JSON.stringify(afterAgentLabels),
	);
	check(
		"Pi agent was offered only the 3 app-customizer tools (get_app_settings, update_general_settings, update_sidebar)",
		JSON.stringify(seenRequests[0]?.tools) === JSON.stringify(["get_app_settings", "update_general_settings", "update_sidebar"]),
		JSON.stringify(seenRequests[0]?.tools),
	);

	// Turn 2 in the same modal conversation: switch appearance to dark & language to English via agent
	queue.push(
		{
			tool: "update_general_settings",
			args: { i: "Switching to dark mode and English", appearance: "dark", language: "en" },
		},
		{
			text: "Switched Dazzi to Dark mode and English.",
		},
	);
	await input.click();
	await page.keyboard.type("다크 모드와 영어로 바꿔줘");
	await page.keyboard.press("Enter");
	await modal.locator(".customizer-turn__reply", { hasText: "Switched Dazzi to Dark mode and English." }).waitFor({ timeout: 15_000 });
	await shot("06-customizer-modal-turn2-dark-en");

	// Close modal and capture dark-mode English Sidebar settings page
	await modal.locator('[data-action="close-app-customizer"]').click();
	await modal.waitFor({ state: "detached" });
	await shot("07-settings-sidebar-dark-en");

	const enLabels = await sidebarLabels();
	check(
		"English Dark mode still shows AI Search and Automations at the top of the sidebar",
		enLabels[0] === "AI Search" && enLabels[1] === "Automations" && enLabels[2] === "Projects",
		JSON.stringify(enLabels),
	);

	// 3. Verify Japanese (`ja`) and Simplified Chinese (`zh`) localization on the Sidebar settings page
	await page.evaluate(() => window.autorag.settings.set({ language: "ja", appearance: "light" }));
	await page.locator("h1.linear-title", { hasText: "サイドバー" }).waitFor();
	const jaLabels = await sidebarLabels();
	check(
		"Japanese localization renders AI 検索, 自動化, and サイドバー settings cleanly",
		jaLabels[0] === "AI 検索" && jaLabels[1] === "自動化" && (await page.locator('[data-sidebar-section="favorites"]').innerText()).includes("お気に入り"),
		JSON.stringify(jaLabels.slice(0, 5)),
	);
	await shot("08-settings-sidebar-ja");

	await page.evaluate(() => window.autorag.settings.set({ language: "zh", appearance: "light" }));
	await page.locator("h1.linear-title", { hasText: "侧边栏" }).waitFor();
	const zhLabels = await sidebarLabels();
	check(
		"Simplified Chinese localization renders AI 搜索, 自动化, and 侧边栏 settings cleanly",
		zhLabels[0] === "AI 搜索" && zhLabels[1] === "自动化" && (await page.locator('[data-sidebar-section="favorites"]').innerText()).includes("个人收藏"),
		JSON.stringify(zhLabels.slice(0, 5)),
	);
	await shot("09-settings-sidebar-zh");
} finally {
	sweep();
}

if (failures.length > 0) {
	console.error(`FAILED (${failures.length}): ${failures.join(", ")}`);
	process.exit(1);
}
log("ALL CHECKS PASSED");
