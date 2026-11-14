/**
 * Manual QA — Keyboard shortcut customization & AI Shortcut Customizer modal in the real app.
 *
 * Drives the built Electron app end-to-end with real Playwright mouse/keyboard
 * input and a loopback OpenAI-compatible model endpoint:
 *   1. Settings → 단축키 (Shortcuts) renders the locked Esc row, all 4 shortcut
 *      groups, presets, and filter input.
 *   2. Direct key-press recording (`[data-shortcut-record="focusSearch"]`) records
 *      `⌘P` / `Ctrl+P`, immediately updates the live Finder sidebar search keycap,
 *      makes `⌘P` focus the search box (while old `⌘F` stops doing so), and writes
 *      `<userData>/settings/settings-state.json` without touching AutoRAG `config.json`.
 *   3. Conflict detection + one-click swap (`rename` ↔ `duplicate`) and pointer-only
 *      UI editing (the keycaps `[data-shortcut-record="rename"]` open the inline recorder → `F2`), followed by pressing
 *      real `F2` on a file row in Finder to trigger inline rename!
 *   4. AI Shortcut Customizer modal (`[data-action="open-shortcut-customizer"]`)
 *      offers strictly `["get_shortcuts", "update_shortcuts"]` from the
 *      `shortcut-customizer` pi agent profile, streams live `.shimmer` `i` progress,
 *      applies `newFolder: "Mod+N"`, and refuses arbitrary unbound actions.
 *   5. Verifies Korean Light, English Dark, Japanese Light, and Simplified Chinese Light.
 *
 * Run in a VM:
 *   bun run qa script --vm --skip-build scripts/manual-qa/run-qa-finder-shortcuts-customizer.mjs
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { chord, isMac, rmRetry, writeMinsyncStub } from "./platform.mjs";
import { pickSelect } from "./settings-select.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/qa-shortcuts-customizer");
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
const sleep = (ms) => {
	const { promise, resolve } = Promise.withResolvers();
	setTimeout(resolve, ms);
	return promise;
};

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-shortcuts-"));
const HOME_DIR = join(WORK, "home");
const AUTORAG_HOME = join(WORK, "autorag-home");
const AGENT_DIR = join(WORK, "pi-agent");
const CONFIG = join(WORK, "config.json");
const USER_DATA = join(WORK, "user-data");
const DOCS_DIR = join(HOME_DIR, "Documents");

for (const folder of ["Desktop", "Documents", "Downloads", "Music", "Movies", "Pictures", ".Trash"]) {
	mkdirSync(join(HOME_DIR, folder), { recursive: true });
}
writeFileSync(join(DOCS_DIR, "report.txt"), "Shortcut QA fixture\n");
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
		const step = queue.shift() ?? { text: "단축키 설정을 완료했습니다." };
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
{
	const { promise, resolve } = Promise.withResolvers();
	server.listen(0, "127.0.0.1", resolve);
	await promise;
}
const MODEL_URL = `http://127.0.0.1:${server.address().port}`;

const initialConfig = {
	searchPaths: [DOCS_DIR],
	workspacePath: join(WORK, "workspace"),
	memoryPath: join(WORK, "memory.json"),
	minSync: { enabled: true, autoInstall: false, embedder: { id: "none" } },
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

	await page.waitForSelector(".sidebar__item", { timeout: 30_000 });
	const settledConfigBefore = readFileSync(CONFIG, "utf8");

	const expectedDefaultSearchLabel = isMac ? "⌘F" : "Ctrl+F";
	const expectedCustomSearchLabel = isMac ? "⌘P" : "Ctrl+P";
	const initialKeycap = await page.locator(".side-search .keycap").innerText();
	check("Sidebar search starts with default shortcut keycap", initialKeycap.trim() === expectedDefaultSearchLabel, initialKeycap);

	// 1. Open Settings and navigate to 단축키 tab
	await page.locator(".sidebar__item--settings").click();
	await page.locator(".settings-nav-item", { hasText: "단축키" }).click();
	await page.locator("h1.linear-title", { hasText: "단축키" }).waitFor();
	await shot("01-settings-shortcuts-default");

	const groupIds = await page
		.locator(".shortcuts-page [data-shortcut-group]")
		.evaluateAll((els) => els.map((e) => e.getAttribute("data-shortcut-group")));
	check(
		"All 4 shortcut groups render in order (window, view, files, aiSearch)",
		JSON.stringify(groupIds) === JSON.stringify(["window", "view", "files", "aiSearch"]),
		JSON.stringify(groupIds),
	);
	check(
		"Locked Esc (dismiss) row is rendered at the top of Window & Navigation",
		(await page.locator('[data-shortcut-row="dismiss"]').count()) === 1,
	);

	// 1b. Verify 빠른 구성: the Mac Finder / Windows 파일 탐색기 segments and 모두 기본값으로 (Figma 445:2249)
	const presetActions = await page
		.locator("[data-shortcut-presets] button")
		.evaluateAll((els) => els.map((e) => e.getAttribute("data-action")));
	check(
		"빠른 구성 shows the Mac Finder and Windows 파일 탐색기 segments, plus 모두 기본값으로",
		JSON.stringify(presetActions) === JSON.stringify(["shortcuts-preset-mac-finder", "shortcuts-preset-windows-explorer"]) &&
			(await page.locator('[data-action="shortcuts-preset-default"]').count()) === 1,
		JSON.stringify(presetActions),
	);

	await page.locator('[data-action="shortcuts-preset-mac-finder"]').click();
	await page.waitForTimeout(200);
	await shot("01b-preset-mac-finder");
	const macPresetState = JSON.parse(readFileSync(join(USER_DATA, "settings", "settings-state.json"), "utf8"));
	check(
		"Mac Finder preset maps ⇧⌘G editPath, ⌘↑ parentFolder, ⌘O openItem, ↩ rename, ⌘⌫ trash",
		macPresetState.settings.shortcuts.overrides.rename === "Enter" &&
			macPresetState.settings.shortcuts.overrides.trash === "Mod+Backspace" &&
			macPresetState.settings.shortcuts.overrides.editPath === "Mod+Shift+G",
		JSON.stringify(macPresetState.settings.shortcuts.overrides),
	);

	await page.locator('[data-action="shortcuts-preset-windows-explorer"]').click();
	await page.waitForTimeout(200);
	await shot("01c-preset-windows-explorer");
	const winPresetState = JSON.parse(readFileSync(join(USER_DATA, "settings", "settings-state.json"), "utf8"));
	check(
		"Windows File Explorer preset maps Alt+D editPath, F2 rename, Delete trash, Ctrl+Y redo, Alt+P quickLook",
		winPresetState.settings.shortcuts.overrides.rename === "F2" &&
			winPresetState.settings.shortcuts.overrides.editPath === "Alt+D" &&
			winPresetState.settings.shortcuts.overrides.redo === "Mod+Y" &&
			winPresetState.settings.shortcuts.overrides.quickLook === "Alt+P",
		JSON.stringify(winPresetState.settings.shortcuts.overrides),
	);

	await page.locator('[data-action="shortcuts-preset-default"]').click();
	await page.waitForTimeout(200);

	// 2. Direct Key-Press Recording on focusSearch -> press Mod+P
	const focusSearchBtn = page.locator('[data-shortcut-record="focusSearch"]');
	await focusSearchBtn.click();
	await shot("02-shortcut-recording-active");
	check(
		"Clicking shortcut pill enters active recording state",
		(await focusSearchBtn.getAttribute("aria-pressed")) === "true",
	);

	await page.keyboard.press(chord("p"));
	await page.waitForTimeout(250);
	await shot("03-shortcut-recorded-mod-p");

	const updatedKeycap = await page.locator(".side-search .keycap").innerText();
	check(
		"Key-press recording saves Mod+P and updates the live Finder sidebar search keycap immediately",
		updatedKeycap.trim() === expectedCustomSearchLabel,
		updatedKeycap,
	);

	// Verify live shortcut dispatch: with Settings open (the Finder's search box is hidden), Mod+P focuses Settings' own search input.
	await page.keyboard.press(chord("p"));
	await page.waitForTimeout(150);
	const searchInputFocused = await page.locator(".settings-search input").evaluate((el) => document.activeElement === el);
	check("Pressing newly recorded Mod+P focuses Settings' search input while Settings is open", searchInputFocused);
	// Blur search input so we continue cleanly
	await page.locator("h1.linear-title", { hasText: "단축키" }).click();

	// 3. Conflict detection + Swap (`rename` -> `Mod+D`, currently `duplicate`), then UI editor (`rename` -> `F2`)
	await page.locator('[data-shortcut-record="rename"]').scrollIntoViewIfNeeded();
	await page.locator('[data-shortcut-record="rename"]').click();
	await page.keyboard.press(chord("d"));
	await page.locator('[data-action="swap-shortcut-conflict"]').waitFor();
	await shot("04-shortcut-conflict-banner");
	await page.locator('[data-action="swap-shortcut-conflict"]').click();
	await page.waitForTimeout(250);

	// Now use the inline recorder's pointer controls to set `rename` to `F2`
	await page.locator('[data-shortcut-record="rename"]').click();
	await page.locator('[data-testid="shortcut-key-select"]').waitFor();
	await shot("05-shortcut-ui-editor-open");
	// Turn off Mod modifier and choose F2
	await page.locator('[data-shortcut-mod="mod"]').click();
	await pickSelect(page.locator('[data-testid="shortcut-key-select"]'), "F2");
	await page.locator('[data-action="save-ui-shortcut"]').click();
	await page.waitForTimeout(250);

	const settingsFile = join(USER_DATA, "settings", "settings-state.json");
	const persistedAfterUi = JSON.parse(readFileSync(settingsFile, "utf8"));
	check(
		"UI editor saves rename=F2 in settings-state.json while leaving AutoRAG config.json untouched",
		existsSync(settingsFile) &&
			persistedAfterUi.settings.shortcuts.overrides.rename === "F2" &&
			persistedAfterUi.settings.shortcuts.overrides.focusSearch === "Mod+P" &&
			readFileSync(CONFIG, "utf8") === settledConfigBefore,
		JSON.stringify(persistedAfterUi.settings.shortcuts),
	);

	// Navigate to Documents in Finder, select report.txt, and press real F2 to prove live rename dispatch!
	// Settings takes over the window; its Back button returns to the Finder and its sidebar.
	await page.locator(".settings-sidebar-back").click();
	await page.locator(".sidebar .sidebar__item", { hasText: "문서" }).click();
	const reportRow = page.locator('[data-path$="report.txt"]').first();
	await reportRow.waitFor();
	await reportRow.click();
	await page.keyboard.press("F2");
	await page.waitForTimeout(250);
	const renameInputCount = await page.locator('input.row__rename, input[value="report.txt"]').count();
	check("Pressing customized F2 in Finder opens inline rename on the selected file", renameInputCount >= 1, `inputs=${renameInputCount}`);
	await page.keyboard.press("Escape");

	// Return to Settings -> 단축키, where the AI Shortcut Customizer fills the window's right sidebar
	await page.locator(".sidebar__item--settings").click();
	await page.locator(".settings-nav-item", { hasText: "단축키" }).click();
	const panel = page.locator('[data-testid="app-customizer-panel"][data-surface="shortcuts"]');
	await panel.waitFor();
	await shot("06-shortcut-customizer-panel-empty");

	queue.push(
		{ tool: "get_shortcuts", args: { i: "현재 단축키 목록을 확인하는 중" }, delayMs: 250 },
		{
			tool: "update_shortcuts",
			args: {
				i: "새 폴더 단축키를 커맨드 N으로 변경하는 중",
				bindings: [
					{ action: "새 폴더", shortcut: "⌘N" },
					{ action: "터미널 열기", shortcut: "⌘J" },
				],
			},
			delayMs: 350,
		},
		{
			text: "새 폴더 단축키를 ⌘N으로 변경했습니다. '터미널 열기'는 기본 제공 단축키 목록에 없는 기능이라 추가할 수 없습니다.",
		},
	);

	const panelInput = panel.locator('textarea[data-testid="app-customizer-input"]');
	await panelInput.click();
	await page.keyboard.type("새 폴더를 커맨드 N으로 바꾸고 터미널 열기도 커맨드 J로 추가해줘");
	await page.keyboard.press("Enter");

	await panel.locator(".customizer-turn__progress .shimmer").waitFor({ timeout: 10_000 });
	await shot("07-shortcut-customizer-shimmer");

	await panel.locator(".customizer-turn__reply", { hasText: "새 폴더 단축키를" }).waitFor({ timeout: 15_000 });
	await shot("08-shortcut-customizer-turn-done");
	const newFolderKeycap = await page.locator('[data-shortcut-record="newFolder"]').evaluate((el) => (el.textContent ?? "").replace(/\s+/g, ""));
	check("The newFolder keycap beside the assistant updates live from ⌘⇧N to ⌘N", newFolderKeycap === "⌘N", newFolderKeycap);

	check(
		"Pi shortcut-customizer profile offered strictly get_shortcuts and update_shortcuts tools",
		JSON.stringify(seenRequests[0]?.tools) === JSON.stringify(["get_shortcuts", "update_shortcuts"]),
		JSON.stringify(seenRequests[0]?.tools),
	);

	const persistedAfterAgent = JSON.parse(readFileSync(settingsFile, "utf8"));
	check(
		"Pi agent updated newFolder=Mod+N and rejected arbitrary unbound action",
		persistedAfterAgent.settings.shortcuts.overrides.newFolder === "Mod+N" &&
			!("터미널 열기" in persistedAfterAgent.settings.shortcuts.overrides),
		JSON.stringify(persistedAfterAgent.settings.shortcuts),
	);

	await page.locator("button[aria-label=\"정보 가리기\"], button[aria-label=\"Hide inspector\"], button[aria-label=\"情報パネルを非表示\"], button[aria-label=\"隐藏检查器\"]").first().click();
	await panel.waitFor({ state: "hidden" });

	// 4. Verify English Dark, Japanese Light, and Simplified Chinese Light localizations
	await page.evaluate(() => window.autorag.settings.set({ language: "en", appearance: "dark" }));
	await page.locator("h1.linear-title", { hasText: "Shortcuts" }).waitFor();
	await shot("09-settings-shortcuts-dark-en");

	await page.evaluate(() => window.autorag.settings.set({ language: "ja", appearance: "light" }));
	await page.locator("h1.linear-title", { hasText: "ショートカット" }).waitFor();
	await shot("10-settings-shortcuts-ja");

	await page.evaluate(() => window.autorag.settings.set({ language: "zh", appearance: "light" }));
	await page.locator("h1.linear-title", { hasText: "快捷键" }).waitFor();
	await shot("11-settings-shortcuts-zh");
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
