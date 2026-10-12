/**
 * Manual QA — AI Search as a tab (no bottom dock).
 *
 * Drives the built app and proves:
 *   1. there is no bottom AI dock: the Finder column shows no AI Search
 *      section while a folder tab is focused;
 *   2. the sidebar's Favorites list starts with "AI Search", above Recents;
 *   4. the AI tab's chat (a composer draft) survives switching tabs, and ⌘T
 *      from an AI Search tab opens a folder tab, not another AI tab;
 *   5. ⌘K from a folder tab adopts the existing AI Search tab instead of
 *      opening another;
 *   6. Inspector "AI 요약" opens a NEW AI Search tab and sends the summary
 *      query with the file attached (user bubble + answer or inline error);
 *   7. a Finder row dragged onto an AI Search strip tab attaches there (the
 *      file stays put) and switches to that tab;
 *   8. a Finder row dragged onto the sidebar AI Search item attaches to the
 *      focused tab, now shown as AI Search;
 *   9. dwelling on an AI Search tab springs it open, and a row dropped on the
 *      panel attaches;
 *  10. an external file drop on the panel attaches its absolute path;
 *  11. the sidebar 내용 search opens a new AI Search tab and sends the query;
 *  12. a filename search from an AI Search tab lists results in that tab;
 *  13. "AI 요약" asks in the Interface language setting, not always Korean.
 * No model key is needed: nothing waits on an answer. Run `bun run build`
 * first. Evidence lands in the ignored `.omo/` tree.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { chord } from "./platform.mjs";

const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-ai-search-tab");
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

const failures = [];
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` :: ${detail}`}`);
	if (!ok) failures.push(label);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WORK = realpathSync(mkdtempSync(join(tmpdir(), "autorag-qa-ai-tab-")));
const QA_ROOT = join(WORK, "qa-root");
const OUTSIDE = join(WORK, "outside");
mkdirSync(QA_ROOT, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });
const BRIEF = join(QA_ROOT, "brief.md");
const NOTES = join(QA_ROOT, "notes.txt");
const BUDGET = join(QA_ROOT, "budget.csv");
const EXTERNAL = join(OUTSIDE, "external.md");
writeFileSync(BRIEF, "# brief\n");
writeFileSync(NOTES, "notes\n");
writeFileSync(BUDGET, "item,total\n");
writeFileSync(EXTERNAL, "# external\n");

const PANEL = 'section[aria-label="AI Search"]:not([aria-hidden="true"])';
const PILL = `${PANEL} .composer-attach-pill`;
const tabs = (page) =>
	page.$$eval(".tabs .tab", (elements) =>
		elements.map((element) => ({
			title: element.querySelector(".tab__title")?.textContent ?? "",
			active: element.classList.contains("tab--active"),
			ai: element.getAttribute("data-ai-search") === "true",
		})),
	);
const pills = (page) => page.$$eval(PILL, (elements) => elements.map((element) => element.getAttribute("title")));
const waitForPill = (page, title) =>
	page.waitForFunction(
		([selector, want]) => [...document.querySelectorAll(selector)].some((element) => element.getAttribute("title") === want),
		[PILL, title],
		{ timeout: 10_000 },
	);
const showFolderTab = async (page) => {
	const index = (await tabs(page)).findIndex((tab) => !tab.ai);
	await page.locator(".tabs .tab").nth(index).click();
	await page.waitForSelector(`[data-path="${BRIEF}"]`);
};

let app;
try {
	app = await launchFinder({
		userDataDir: join(WORK, "user-data"),
		env: { AUTORAG_QA_ROOT: QA_ROOT, ELECTRON_RENDERER_URL: "" },
	});
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(10_000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
	await page.waitForSelector(`[data-path="${BRIEF}"]`, { timeout: 30_000 });
	const cdp = await page.context().newCDPSession(page);

	// 1. No bottom dock.
	check(
		"a folder tab shows no AI Search dock",
		(await page.locator(PANEL).count()) === 0 && (await page.locator(".ai-grip").count()) === 0,
		`visible panels=${await page.locator(PANEL).count()}`,
	);
	await page.screenshot({ path: join(EVIDENCE, "01-no-dock.png") });

	// 2. Sidebar: AI Search heads Favorites, above Recents.
	const favorites = await page.locator(".side-group").first().locator(".sidebar__item-label").allInnerTexts();
	check("Favorites starts with AI Search above Recents", (favorites[0] === "AI Search" || favorites[0] === "AI 검색") && (favorites[1] === "Recents" || favorites[1] === "최근 항목"), JSON.stringify(favorites));

	// 3. Sidebar AI Search converts the focused tab; Back returns to the folder.
	const before = await tabs(page);
	await page.locator('.sidebar__item:has-text("AI Search"), .sidebar__item:has-text("AI 검색")').first().click();
	await page.waitForSelector(PANEL);
	let now = await tabs(page);
	check(
		"the sidebar item turns the focused tab into AI Search",
		now.length === before.length && now.find((tab) => tab.active)?.ai === true && now.find((tab) => tab.active)?.title === "AI Search",
		JSON.stringify(now),
	);
	check(
		"the composer is focused",
		await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Ask Dazzi"),
	);
	check(
		"the sidebar marks AI Search active",
		(await page.locator('.sidebar__item:has-text("AI Search"), .sidebar__item:has-text("AI 검색")').first().getAttribute("aria-current")) === "true",
	);
	await page.screenshot({ path: join(EVIDENCE, "02-ai-tab.png") });
	await page.locator('[aria-label="Back"], [title^="Back"], [aria-label="뒤로"], [title^="뒤로"]').first().click();
	await page.waitForSelector(`[data-path="${BRIEF}"]`);
	check("Back returns the tab to its folder", (await page.locator(PANEL).count()) === 0);
	await page.locator('[aria-label="Forward"], [title^="Forward"], [aria-label="앞으로"], [title^="앞으로"]').first().click();
	await page.waitForSelector(PANEL);

	// 4. Chat state survives tab switches.
	await page.locator(`${PANEL} input[aria-label="Ask Dazzi"]`).fill("draft survives tab switch");
	await page.keyboard.press(chord("t"));
	await page.waitForSelector(`[data-path="${BRIEF}"]`);
	now = await tabs(page);
	check("⌘T from an AI Search tab opens a folder tab", now.length === 2 && now[1]?.active === true && now[1]?.ai === false, JSON.stringify(now));
	await page.locator(".tabs .tab").first().click();
	await page.waitForSelector(PANEL);
	check(
		"the composer draft survives switching tabs",
		(await page.locator(`${PANEL} input[aria-label="Ask Dazzi"]`).inputValue()) === "draft survives tab switch",
	);

	// 5. ⌘K from a folder tab adopts the existing AI tab.
	await page.locator(".tabs .tab").nth(1).click();
	await page.waitForSelector(`[data-path="${BRIEF}"]`);
	await page.locator(`[data-path="${BRIEF}"]`).click();
	await page.keyboard.press(chord("k"));
	await page.waitForSelector(PANEL);
	now = await tabs(page);
	check("⌘K adopts the existing AI Search tab", now.length === 2 && now[0]?.active === true, JSON.stringify(now));
	check(
		"⌘K focuses the composer",
		await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Ask Dazzi"),
	);

	// 6. Inspector AI 요약 opens a NEW AI tab, attaches the file, and sends the summary run.
	const SUMMARY_PROMPT = "첨부한 파일을 요약해줘. 핵심 내용 · 주요 수치 · 주의사항 순으로, 근거가 된 파일 경로를 출처로 인용해줘.";
	await showFolderTab(page);
	await page.locator(`[data-path="${BRIEF}"]`).click();
	await page.locator(".inspector-actions button", { hasText: "AI 요약" }).click();
	await page.locator(`${PANEL} .assistant-msg`).waitFor({ timeout: 10_000 });
	now = await tabs(page);
	check(
		"AI 요약 opens a new AI Search tab",
		now.length === 3 && now[2]?.active === true && now[2]?.ai === true,
		JSON.stringify(now),
	);
	const summaryText = (await page.locator(`${PANEL} .user-msg .bubble`).first().innerText()).trim();
	check(
		"AI 요약 sends the summary query with the file attached, not a bare draft chip",
		summaryText === SUMMARY_PROMPT &&
			(await page.locator(`${PANEL} .ref-file-chip[title="${BRIEF}"]`).count()) === 1 &&
			(await pills(page)).length === 0,
		`query="${summaryText}" pills=${JSON.stringify(await pills(page))}`,
	);
	check(
		"AI 요약 renders an answer block or an inline error instead of a silent no-op",
		(await page.locator(`${PANEL} .assistant-msg`).count()) === 1,
	);
	await page.screenshot({ path: join(EVIDENCE, "03-ai-summary-tab.png") });

	// 7. A row dragged onto an AI Search strip tab attaches there.
	await showFolderTab(page);
	await page.locator(`[data-path="${NOTES}"]`).dragTo(page.locator(".tabs .tab").nth(2));
	await waitForPill(page, NOTES).catch(() => undefined);
	now = await tabs(page);
	check("a row dropped on an AI Search tab switches to it", now[2]?.active === true, JSON.stringify(now));
	check(
		"the dropped row is attached, not moved",
		JSON.stringify(await pills(page)) === JSON.stringify([NOTES]) && existsSync(NOTES),
		JSON.stringify(await pills(page)),
	);

	// 8. A row dragged onto the sidebar AI Search item.
	await showFolderTab(page);
	const folderTabIndex = (await tabs(page)).findIndex((tab) => tab.active);
	await page.locator(`[data-path="${BUDGET}"]`).dragTo(page.locator('.sidebar__item:has-text("AI Search"), .sidebar__item:has-text("AI 검색")').first());
	await waitForPill(page, BUDGET).catch(() => undefined);
	now = await tabs(page);
	check(
		"a row dropped on the sidebar item turns the focused tab into AI Search",
		now[folderTabIndex]?.active === true && now[folderTabIndex]?.ai === true && now.length === 3,
		JSON.stringify(now),
	);
	await page.screenshot({ path: join(EVIDENCE, "04-sidebar-drop.png") });

	// 9. Dwell on the AI tab with a held row (spring-loaded), then drop it on the panel.
	await page.keyboard.press(chord("t"));
	await page.waitForSelector(`[data-path="${BRIEF}"]`);
	const rowBox = await page.locator(`[data-path="${NOTES}"]`).boundingBox();
	const aiTabBox = await page.locator(".tabs .tab").nth(folderTabIndex).boundingBox();
	await page.mouse.move(rowBox.x + 20, rowBox.y + rowBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(rowBox.x + 36, rowBox.y + rowBox.height / 2, { steps: 4 });
	const tabX = aiTabBox.x + aiTabBox.width / 2;
	const tabY = aiTabBox.y + aiTabBox.height / 2;
	await page.mouse.move(tabX, tabY, { steps: 8 });
	// Chromium only fires dragover while the pointer moves: jiggle through the dwell.
	let springed = false;
	for (let tick = 0; tick < 15 && !springed; tick += 1) {
		await page.mouse.move(tabX + (tick % 2 === 0 ? 3 : -3), tabY, { steps: 1 });
		await sleep(150);
		springed = (await tabs(page))[folderTabIndex]?.active === true;
	}
	const body = await page.locator(`${PANEL} .ai-body`).boundingBox().catch(() => null);
	if (body !== null) {
		await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2, { steps: 8 });
		await page.mouse.move(body.x + body.width / 2 + 3, body.y + body.height / 2, { steps: 1 });
	}
	await page.mouse.up();
	await waitForPill(page, NOTES).catch(() => undefined);
	check(
		"dwelling on an AI tab springs it open and a drop on the panel attaches",
		springed && (await pills(page)).includes(NOTES),
		`springed=${springed} ${JSON.stringify(await pills(page))}`,
	);

	// 10. An external file dropped on the panel.
	const panelBox = await page.locator(PANEL).boundingBox();
	const x = panelBox.x + panelBox.width / 2;
	const y = panelBox.y + panelBox.height / 2;
	const payload = { items: [], dragOperationsMask: 1, files: [EXTERNAL] };
	for (const type of ["dragEnter", "dragOver", "drop"]) await cdp.send("Input.dispatchDragEvent", { type, x, y, data: payload });
	await waitForPill(page, EXTERNAL).catch(() => undefined);
	check("an external file drop on the panel attaches its absolute path", (await pills(page)).includes(EXTERNAL), JSON.stringify(await pills(page)));
	check("the drag overlay clears after the drop", (await page.getByText("여기로 끌어서 AI에게 물어보기").count()) === 0);
	await page.screenshot({ path: join(EVIDENCE, "05-panel-drops.png") });

	// 11. Sidebar 내용 opens a new AI tab and sends the query.
	const countBefore = (await tabs(page)).length;
	const search = page.locator(".side-search input");
	await search.click();
	await page.locator(".scope-chip", { hasText: /^내용$/ }).click();
	await search.fill("approval notes");
	await search.press("Enter");
	await page.locator(`${PANEL} .user-msg .bubble`).first().waitFor({ timeout: 10_000 });
	now = await tabs(page);
	check(
		"내용 opens a new AI Search tab and sends the query",
		now.length === countBefore + 1 &&
			now.at(-1)?.active === true &&
			now.at(-1)?.ai === true &&
			(await page.locator(`${PANEL} .user-msg .bubble`).first().innerText()).trim() === "approval notes",
		JSON.stringify(now),
	);
	await page.keyboard.press("Escape");
	await sleep(400);
	await page.screenshot({ path: join(EVIDENCE, "06-content-search.png") });

	// 12. A filename search from an AI tab lists results in the tab's last folder.
	await page.locator(".tabs .tab").first().click();
	await page.waitForSelector(PANEL);
	await search.click();
	// 파일 이름 scopes the search to the tab's folder, so the hit is the fixture, fast.
	await page.locator(".scope-chip", { hasText: /^파일 이름$/ }).click();
	await search.fill("budget");
	await search.press("Enter");
	await page.waitForSelector(`[data-path="${BUDGET}"]`, { timeout: 15_000 }).catch(() => undefined);
	const searchTabs = await tabs(page);
	await page.screenshot({ path: join(EVIDENCE, "07-filename-search-from-ai-tab.png") });
	check(
		"a filename search from an AI Search tab shows the results there",
		(await page.locator(PANEL).count()) === 0 && (await page.locator(`[data-path="${BUDGET}"]`).count()) === 1,
		`panels=${await page.locator(PANEL).count()} rows=${await page.locator(`[data-path="${BUDGET}"]`).count()} tabs=${JSON.stringify(searchTabs)}`,
	);
	await search.fill("");
	await search.press("Enter");
	await page.locator(".tabs .tab").first().click();

	// 13. "AI 요약" follows the Interface language setting.
	await page.locator(".sidebar__item", { hasText: "Settings" }).click();
	await page.waitForSelector(".settings-panel");
	await page.locator('select[aria-label="앱 언어"]').selectOption("en");
	// The set IPC resolves and App adopts it (onSettingsChanged) before the tab closes.
	await page.waitForFunction(() => document.querySelector('select[aria-label="앱 언어"]')?.value === "en");
	await sleep(300);
	await page.keyboard.press(chord("w"));
	await page.locator(".sidebar__item", { hasText: "QA" }).click();
	await page.waitForSelector(`[data-path="${NOTES}"]`);
	await page.locator(`[data-path="${NOTES}"]`).click();
	await page.locator('.inspector-actions button[data-action="askAi"], .inspector-actions button:has-text("AI Summary"), .inspector-actions button:has-text("AI 요약")').first().click();
	await page.locator(`${PANEL} .assistant-msg`).waitFor({ timeout: 10_000 });
	const englishText = (await page.locator(`${PANEL} .user-msg .bubble`).first().innerText()).trim();
	check(
		"AI 요약 asks in the Interface language setting",
		englishText ===
			"Summarize the attached file. Cover the key points, notable figures, and any cautions in that order, and cite the source file paths you relied on.",
		`query="${englishText}"`,
	);
	await page.screenshot({ path: join(EVIDENCE, "08-ai-summary-english.png") });
} catch (error) {
	console.error(`harness error: ${String(error).slice(0, 600)}`);
	failures.push("harness error");
} finally {
	await app?.close();
	rmSync(WORK, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAIL: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
