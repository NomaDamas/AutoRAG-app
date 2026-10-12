// Live QA for AI Search drag-and-drop attachments: drives the built Finder app
// and proves that
//   1. Finder rows dragged onto the AI Search strip tab attach with their
//      absolute paths (one row, and a multi-row selection by the sidebar item);
//   2. files, folders, and links dropped from outside the app attach — sent
//      through Chromium's native drop path (CDP Input.dispatchDragEvent, the
//      same browser-side route an OS drag takes), so paths resolve through
//      Electron's webUtils.getPathForFile;
//   3. a bare text drag attaches nothing;
//   4. optionally (QA_REAL_FINDER_DRAG=1), a real drag from a macOS Finder.app
//      window lands too — this moves the real mouse and needs Accessibility
//      permission for the terminal;
//   5. a real agent run receives the context: its answer quotes facts that
//      exist only inside the attached files, which sit outside the search
//      corpus, and names the attached link's domain.
//
// Prerequisites: `bun run build`, OPENROUTER_API_KEY in the environment.
// Run: bun scripts/manual-qa/run-qa-finder-drop-attachments.mjs
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_PANEL, finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";
import { chord, isMac } from "./platform.mjs";

const EVIDENCE = join(ROOT, ".omo", "evidence", "ai-finder-app", "qa-drop-attachments");
const RUN_TIMEOUT_MS = 240_000;
const REAL_FINDER = process.env.QA_REAL_FINDER_DRAG === "1";
const LINK = "https://example.com/";

if (!process.env.OPENROUTER_API_KEY) {
	console.error("OPENROUTER_API_KEY is required for the live attachment QA.");
	process.exit(2);
}

rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });
const LOG = join(EVIDENCE, "run.log");
const log = (line) => {
	console.log(line);
	appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
};

// The facts live only in the attached files: QA_ROOT and OUTSIDE are not
// search paths, so retrieval can never surface them. The work dir is the
// canonical path (/private/var, not /var) because that is what a real Finder
// drag reports.
const WORK = realpathSync(mkdtempSync(join(tmpdir(), "autorag-qa-drop-attachments-")));
const QA_ROOT = join(WORK, "qa-root");
const OUTSIDE = join(WORK, "outside");
const CORPUS = join(WORK, "corpus");
const REFERENCE = join(OUTSIDE, "reference");
for (const directory of [QA_ROOT, OUTSIDE, CORPUS, REFERENCE]) mkdirSync(directory, { recursive: true });
const SECRET = join(QA_ROOT, "secret-brief.md");
const NOTES = join(QA_ROOT, "meeting-notes.txt");
const EXTERNAL = join(OUTSIDE, "external-brief.md");
const FINDER_FILE = join(OUTSIDE, "finder-drop.md");
writeFileSync(SECRET, "# 프로젝트 브리프\n프로젝트 코드명: BLUEHERON-4827\n");
writeFileSync(NOTES, "주간 회의록\n- 다음 회의는 목요일 오후 3시\n");
writeFileSync(EXTERNAL, "# 예산 메모\n예산 승인자: 한지우 CFO\n");
writeFileSync(FINDER_FILE, "Finder 드롭 확인 문구: ORCHID-5513\n");
writeFileSync(join(REFERENCE, "glossary.md"), "용어집\n");
writeFileSync(join(CORPUS, "lunch-menu.txt"), "금요일 점심 메뉴: 비빔밥\n");

const CONFIG = join(WORK, "config.json");
writeFileSync(
	CONFIG,
	JSON.stringify(
		{
			searchPaths: [CORPUS],
			workspacePath: WORK,
			memoryPath: join(WORK, "memory.json"),
			minSync: { enabled: true },
			jikji: false,
			model: {
				provider: "openrouter",
				id: "deepseek/deepseek-v4.1-flash",
				baseUrl: "https://openrouter.ai/api/v1",
				api: "openai-completions",
				apiKeyEnv: "OPENROUTER_API_KEY",
			},
		},
		null,
		2,
	),
);

const results = [];
const check = (name, pass, detail) => {
	results.push({ name, pass, detail });
	log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
};

const DOCK = AI_PANEL;
const PILL = `${AI_PANEL} .composer-attach-pill`;
const AI_TAB = '.tabs .tab[data-ai-search="true"]';
const FOLDER_TAB = '.tabs .tab:not([data-ai-search="true"])';

async function pills(page) {
	return page.$$eval(PILL, (elements) =>
		elements.map((element) => ({
			title: element.getAttribute("title"),
			name: element.textContent ?? "",
			folder: element.querySelector(".tile--folder") !== null,
		})),
	);
}

/** Show the folder tab, so the Finder rows are on screen to drag. */
async function showRows(page) {
	await page.locator(FOLDER_TAB).first().click();
	await page.waitForSelector(`[data-path="${SECRET}"]`);
}

async function clearPills(page) {
	while ((await page.$$(PILL)).length > 0) await page.click(`${PILL} button[aria-label="첨부 제거"]`);
}

/** An external drag through the browser process: what an OS drag delivers. */
async function nativeDrop(page, cdp, data) {
	const box = await page.locator(DOCK).boundingBox();
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	const payload = { items: [], dragOperationsMask: 1, ...data };
	for (const type of ["dragEnter", "dragOver", "drop"]) {
		await cdp.send("Input.dispatchDragEvent", { type, x, y, data: payload });
	}
}

async function waitForPill(page, title) {
	await page.waitForFunction(
		([selector, want]) => [...document.querySelectorAll(selector)].some((element) => element.getAttribute("title") === want),
		[PILL, title],
		{ timeout: 10_000 },
	);
}

const osascript = (script) => execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim();

let app = null;
try {
	log(`work dir: ${WORK}`);
	app = await launchFinder({
		userDataDir: join(WORK, "user-data"),
		env: { AUTORAG_CONFIG: CONFIG, AUTORAG_QA_ROOT: QA_ROOT, ELECTRON_RENDERER_URL: "" },
	});
	const page = await finderWindow(app, 30_000);
	page.on("pageerror", (error) => log(`[pageerror] ${String(error).slice(0, 300)}`));
	await page.waitForSelector(`[data-path="${SECRET}"]`, { timeout: 30_000 });
	const cdp = await page.context().newCDPSession(page);
	// One AI Search tab beside the folder tab: AI Search, then ⌘T back to rows.
	await openAiSearch(page);
	await page.keyboard.press(chord("t"));
	await page.waitForSelector(`[data-path="${SECRET}"]`);

	// 1. One Finder row dragged onto the AI Search strip tab.
	await page.locator(`[data-path="${SECRET}"]`).dragTo(page.locator(AI_TAB));
	await waitForPill(page, SECRET).catch(() => undefined);
	let current = await pills(page);
	check("finder row drag onto the AI Search tab attaches its path", current.some((pill) => pill.title === SECRET), JSON.stringify(current));
	await page.screenshot({ path: join(EVIDENCE, "1-finder-row.png") });

	// 2. A two-row selection dragged by one of its rows onto the sidebar item carries both.
	await clearPills(page);
	await showRows(page);
	await page.click(`[data-path="${SECRET}"]`);
	await page.click(`[data-path="${NOTES}"]`, { modifiers: ["Meta"] });
	await page.locator(`[data-path="${NOTES}"]`).dragTo(page.locator(".sidebar__item", { hasText: "AI Search" }));
	await waitForPill(page, NOTES).catch(() => undefined);
	current = await pills(page);
	check(
		"multi-row drag onto the sidebar AI Search item attaches the whole selection",
		[SECRET, NOTES].every((path) => current.some((pill) => pill.title === path)) && current.length === 2,
		JSON.stringify(current),
	);
	await page.screenshot({ path: join(EVIDENCE, "2-finder-selection.png") });

	// 3. A file from another app, dropped on the AI Search panel.
	await nativeDrop(page, cdp, { files: [EXTERNAL] });
	await waitForPill(page, EXTERNAL).catch(() => undefined);
	current = await pills(page);
	check(
		"external file drop resolves the absolute path",
		current.some((pill) => pill.title === EXTERNAL && pill.name.includes("external-brief.md")),
		JSON.stringify(current),
	);

	// 4. A folder from another app.
	await nativeDrop(page, cdp, { files: [REFERENCE] });
	await waitForPill(page, REFERENCE).catch(() => undefined);
	current = await pills(page);
	check("external folder drop attaches as a folder", current.some((pill) => pill.title === REFERENCE && pill.folder), JSON.stringify(current));

	// 5. A link dragged from a browser.
	await nativeDrop(page, cdp, {
		items: [
			{ mimeType: "text/uri-list", data: LINK },
			{ mimeType: "text/plain", data: LINK },
		],
	});
	await waitForPill(page, LINK).catch(() => undefined);
	current = await pills(page);
	check("link drop attaches the URL", current.some((pill) => pill.title === LINK && pill.name.includes("example.com")), JSON.stringify(current));

	// 6. Bare text is not an attachment.
	const before = current.length;
	await nativeDrop(page, cdp, { items: [{ mimeType: "text/plain", data: "그냥 텍스트" }] });
	current = await pills(page);
	check("bare text drag attaches nothing", current.length === before, `${before} → ${current.length}`);
	await page.screenshot({ path: join(EVIDENCE, "3-external-drops.png") });

	// 7. Optional: a real drag out of a macOS Finder.app window.
	if (REAL_FINDER && isMac) {
		const bounds = await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()
				.filter((window) => window.webContents.getURL().endsWith("/index.html"))
				.map((window) => window.getContentBounds())[0],
		);
		const finderBounds = [bounds.x + 260, bounds.y + 120, bounds.x + 760, bounds.y + 420];
		osascript(
			`tell application "Finder"
				activate
				set w to make new Finder window to (POSIX file "${OUTSIDE}" as alias)
				set current view of w to icon view
				set bounds of w to {${finderBounds.join(", ")}}
			end tell`,
		);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		try {
			const helper = join(ROOT, "scripts", "manual-qa", "os-drag.swift");
			const icon = JSON.parse(execFileSync("swift", [helper, "locate", "outside", "finder-drop.md"], { encoding: "utf8" }));
			const dock = await page.locator(`${DOCK} .ai-body`).boundingBox();
			const target = { x: bounds.x + dock.x + dock.width / 2, y: bounds.y + dock.y + dock.height / 2 };
			log(`real Finder drag ${JSON.stringify(icon)} → ${JSON.stringify(target)}`);
			execFileSync("swift", [helper, "drag", String(icon.x), String(icon.y), String(target.x), String(target.y)], { encoding: "utf8" });
			await waitForPill(page, FINDER_FILE).catch(() => undefined);
			current = await pills(page);
			check("real Finder.app drag attaches the file", current.some((pill) => pill.title === FINDER_FILE), JSON.stringify(current));
			await page.screenshot({ path: join(EVIDENCE, "4-real-finder-drag.png") });
		} finally {
			try {
				osascript(`tell application "Finder" to close window "outside"`);
			} catch (error) {
				log(`INFO could not close the Finder window: ${String(error).slice(0, 200)}`);
			}
		}
	} else if (!isMac) {
		log("SKIP real Finder.app drag: macOS-only (osascript + os-drag.swift)");
	} else {
		log("INFO real Finder.app drag skipped (set QA_REAL_FINDER_DRAG=1)");
	}

	// 8. A real agent run answers from the attached content.
	const sent = await pills(page);
	const question =
		"첨부한 파일들에 적힌 프로젝트 코드명, 예산 승인자, Finder 드롭 확인 문구를 각각 그대로 알려주고, 첨부한 링크의 도메인도 알려줘.";
	await page.fill(`${DOCK} input[aria-label="Ask AutoRAG"]`, question);
	await page.keyboard.press("Enter");
	log(`submitted with ${sent.length} attachments: ${question}`);
	await page.waitForFunction(
		(panel) => {
			const input = document.querySelector(`${panel} input[aria-label="Ask AutoRAG"]`);
			return input !== null && !input.disabled && document.querySelector(`${panel} .user-msg`) !== null;
		},
		DOCK,
		{ timeout: RUN_TIMEOUT_MS },
	);
	await page.screenshot({ path: join(EVIDENCE, "5-answer.png") });
	const chips = await page.$$eval(`${DOCK} .ref-file-chip`, (elements) => elements.map((element) => element.getAttribute("title")));
	check(
		"sent message shows every attachment",
		sent.every((pill) => chips.includes(pill.title)) && chips.length === sent.length,
		JSON.stringify(chips),
	);
	const prose = await page.$$eval(`${DOCK} .assistant-msg .assistant-prose`, (elements) => elements.map((element) => element.textContent ?? ""));
	const error = await page.$eval(DOCK, (element) => element.querySelector(".text-danger-text")?.textContent ?? "");
	const answer = prose.join("\n");
	writeFileSync(join(EVIDENCE, "answer.txt"), `${answer}\n\nerror: ${error}\n`);
	log(`answer (${prose.length} phases, ${answer.length} chars): ${answer.replace(/\s+/gu, " ").slice(0, 600)}`);
	check("no run error", error === "", error);
	check("agent read the Finder-row attachment (outside the corpus)", answer.includes("BLUEHERON-4827"), "expects BLUEHERON-4827");
	check("agent read the externally dropped file", answer.includes("한지우"), "expects 한지우");
	check("agent received the dropped link", answer.toLowerCase().includes("example.com"), "expects example.com");
	if (REAL_FINDER) check("agent read the real Finder.app drop", answer.includes("ORCHID-5513"), "expects ORCHID-5513");
} catch (error) {
	check("run completed", false, String(error).slice(0, 500));
	if (app !== null) {
		const page = await finderWindow(app).catch(() => null);
		await page?.screenshot({ path: join(EVIDENCE, "failure.png") }).catch(() => undefined);
	}
} finally {
	if (app !== null) await app.close().catch(() => undefined);
	rmSync(WORK, { recursive: true, force: true });
}

writeFileSync(join(EVIDENCE, "summary.json"), JSON.stringify(results, null, 2));
const failed = results.filter((result) => !result.pass);
log(failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`);
process.exit(failed.length === 0 ? 0 : 1);
