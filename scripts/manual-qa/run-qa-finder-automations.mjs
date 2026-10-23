/**
 * Manual QA — the 자동화 (Automations) tab.
 *
 * Drives the built app against the real librarian CLI (`autorag automate status`)
 * with an isolated AUTORAG_HOME and proves, with real mouse and keyboard input:
 *   1. Favorites reads AI Search, Automations, then the OS folders;
 *   2. the sidebar item turns the focused tab into the rules list, one row per
 *      rule, with the plain-language title, watched folder, last run, status dot,
 *      and a service line that says rules are not running (the daemon is off);
 *   3. selecting a rule fills the inspector (a failed rule names its problem),
 *      ↑/↓ move the selection, Space opens Quick Look and Esc closes it;
 *   4. the right-click menu offers the rule actions;
 *   5. Enter (edit) and "add" open a NEW AI Search tab whose composer holds a
 *      draft in the interface language and nothing is sent (no user bubble, no
 *      running search);
 *   6. delete asks first (Esc cancels), then removes only that rule from the
 *      rules file, shows an Undo toast, and Undo restores it at the same place
 *      with every other entry untouched;
 *   7. a folder's inspector lists the rules that watch it and edits from there;
 *   8. a change made behind the app's back (what the librarian agent does) shows
 *      up without a click, and an unreadable rules file shows its reason;
 *   9. the same flow reads right in Korean, and renders in Japanese and Chinese.
 * No model key is needed. Run `bun run build` first; `bun run qa script …` runs
 * this in a throwaway macOS VM. Evidence lands in the ignored `.omo/` tree.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { cssAttr } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ? join(process.env.QA_OUT, "automations") : join(ROOT, ".omo/evidence/ai-finder-app/qa-automations");
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

const failures = [];
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` :: ${detail}`}`);
	if (!ok) failures.push(label);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WORK = realpathSync(mkdtempSync(join(tmpdir(), "autorag-qa-automations-")));
const QA_ROOT = join(WORK, "qa-root");
const HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const RULES = join(HOME, "automations.json");
const DOWNLOADS = join(QA_ROOT, "Downloads");
const NOTES = join(QA_ROOT, "Notes");
const PROJECTS = join(QA_ROOT, "Projects");
for (const dir of [QA_ROOT, HOME, join(HOME, "bin"), join(HOME, "automations", "logs"), DOWNLOADS, NOTES, PROJECTS]) mkdirSync(dir, { recursive: true });
writeFileSync(join(DOWNLOADS, "report.pdf"), "%PDF-1.4\n");
writeFileSync(join(NOTES, "todo.md"), "# todo\n");
const minsync = join(HOME, "bin", "minsync");
writeFileSync(minsync, "#!/bin/sh\nexit 0\n");
chmodSync(minsync, 0o755);
writeFileSync(CONFIG, `${JSON.stringify({ searchPaths: [QA_ROOT], workspacePath: join(WORK, "workspace"), memoryPath: join(WORK, "memory.json"), minSync: { enabled: false }, jikji: false }, null, 2)}\n`);

const SUMMARY = "Summarize this document in three lines and save it next to the original";
const ruleA = {
	id: "downloads-pdf-summary",
	paths: [DOWNLOADS],
	events: ["create"],
	include: ["**/*.pdf"],
	run: ["autorag", "search", SUMMARY],
	appendFiles: true,
};
const ruleB = {
	id: "notes-index-refresh",
	paths: [NOTES, PROJECTS],
	events: ["create", "update", "delete"],
	include: ["**/*.md"],
	exclude: ["**/archive/**"],
	run: ["autorag", "refresh"],
	debounceMs: 5000,
};
const ruleC = {
	id: "hwp-to-pdf",
	paths: [DOWNLOADS],
	events: ["create"],
	include: ["**/*.hwp", "**/*.hwpx"],
	run: ["hwp5-qa-missing", "--to", "pdf"],
	appendFiles: true,
};
const writeRules = (rules) => writeFileSync(RULES, `${JSON.stringify({ automations: rules }, null, 2)}\n`);
const readRules = () => JSON.parse(readFileSync(RULES, "utf8")).automations;
const runLog = (id, record) =>
	writeFileSync(
		join(HOME, "automations", "logs", `${id}.jsonl`),
		`${JSON.stringify({ id, durationMs: 800, eventCount: 1, filesOverflow: false, signal: null, timedOut: false, stdout: "", stderr: "", ...record })}\n`,
	);
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
writeRules([ruleA, ruleB, ruleC]);
runLog(ruleA.id, { startedAt: ago(3), exitCode: 0 });
runLog(ruleB.id, { startedAt: ago(41), exitCode: 0, eventCount: 3 });
runLog(ruleC.id, { startedAt: ago(19 * 60), exitCode: null, error: "spawn hwp5-qa-missing ENOENT" });

const ROW = (id) => `[role="row"][data-rule-id="${id}"]`;
const INSPECTOR = 'aside[aria-label="Inspector"]';
// The AI Search panel is labelled in the interface language; the host `data-ai-tab` and `aria-hidden` are not.
const AI_PANEL = '[data-ai-tab] section.ai:not([aria-hidden="true"])';
// The composer is the one text input of the visible AI Search panel, whatever language its label is in.
const COMPOSER = `${AI_PANEL} .compose-box input`;
const tabs = (page) =>
	page.$$eval(".tabs .tab", (elements) =>
		elements.map((element) => ({
			title: element.querySelector(".tab__title")?.textContent?.trim() ?? "",
			active: element.classList.contains("tab--active"),
			ai: element.getAttribute("data-ai-search") === "true",
		})),
	);
const rowIds = (page) => page.$$eval('[role="row"][data-rule-id]', (rows) => rows.map((row) => row.getAttribute("data-rule-id")));
const text = async (page, selector) => ((await page.locator(selector).first().innerText({ timeout: 5000 }).catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
const sidebarItem = (page, label) => page.locator(".sidebar__item", { hasText: label }).first();

async function launch(language, name) {
	const app = await launchFinder({
		userDataDir: join(WORK, `user-data-${name}`),
		language,
		env: {
			AUTORAG_HOME: HOME,
			AUTORAG_CONFIG: CONFIG,
			AUTORAG_QA_ROOT: QA_ROOT,
			AUTORAG_SKIP_DUPEY_CHECK: "1",
			ELECTRON_RENDERER_URL: "",
			PATH: `${join(HOME, "bin")}:${process.env.PATH ?? ""}`,
		},
	});
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(12_000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
	await page.waitForSelector(`[data-path="${cssAttr(DOWNLOADS)}"]`, { timeout: 30_000 });
	return { app, page };
}

async function openAutomations(page) {
	await sidebarItem(page, /Automations|자동화|自動化|自动化/).click();
	await page.waitForSelector('[role="row"][data-rule-id]', { timeout: 30_000 });
}

/** The whole English flow. */
async function english() {
	const { app, page } = await launch("en", "en");
	try {
		// 1. Favorites order.
		const favorites = await page.locator(".side-group").first().locator(".sidebar__item-label").allInnerTexts();
		check("Favorites reads AI Search, Automations, then the OS folders", favorites[0] === "AI Search" && favorites[1] === "Automations" && favorites.length > 2, JSON.stringify(favorites));

		// 2. The list.
		const before = await tabs(page);
		await openAutomations(page);
		const now = await tabs(page);
		check("the sidebar item turns the focused tab into Automations", now.length === before.length && now.find((tab) => tab.active)?.title === "Automations", JSON.stringify(now));
		check("the sidebar marks Automations active", (await sidebarItem(page, "Automations").getAttribute("aria-current")) === "true");
		check("the toolbar names the view", (await text(page, ".toolbar-title")) === "Automations", await text(page, ".toolbar-title"));
		check("one row per rule, in file order", JSON.stringify(await rowIds(page)) === JSON.stringify([ruleA.id, ruleB.id, ruleC.id]), JSON.stringify(await rowIds(page)));
		const rowA = await text(page, ROW(ruleA.id));
		check("a row reads trigger → action, folder, last run", rowA.includes("New PDF → Hand to Dazzi") && rowA.includes("Downloads") && /3 minutes ago/.test(rowA), rowA);
		const rowB = await text(page, ROW(ruleB.id));
		check("several folders collapse to the first and a count", rowB.includes("Notes and 1 more") && rowB.includes("Refresh search index"), rowB);
		const tones = await page.$$eval('[role="row"][data-rule-id] [data-run-tone]', (dots) => dots.map((dot) => dot.getAttribute("data-run-tone")));
		check("status dots: ok, ok, fail", JSON.stringify(tones) === '["ok","ok","fail"]', JSON.stringify(tones));
		const service = await text(page, "[data-daemon]");
		check("the service line says rules are not running and counts them", service.includes("Off · rules are not running") && service.includes("Rules: 3") && service.includes("Turn on"), service);
		await page.screenshot({ path: join(EVIDENCE, "01-list-en.png") });

		// 3. Selection, inspector, keys, Quick Look.
		await page.locator(ROW(ruleC.id)).click();
		let inspector = await text(page, INSPECTOR);
		check("a failed rule's inspector names the problem", inspector.includes("Problem") && inspector.includes("Program ‘hwp5-qa-missing’ was not found"), inspector);
		check("the inspector shows when and what", inspector.includes("When") && inspector.includes("Downloads") && inspector.includes("Does"), inspector);
		await page.screenshot({ path: join(EVIDENCE, "02-failed-rule-en.png") });
		await page.keyboard.press("ArrowUp");
		check("↑ selects the previous rule", (await page.locator(`${ROW(ruleB.id)}[aria-selected="true"]`).count()) === 1);
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("ArrowUp");
		check("↑ stops at the first rule", (await page.locator(`${ROW(ruleA.id)}[aria-selected="true"]`).count()) === 1);
		await page.keyboard.press(" ");
		await page.waitForSelector('[role="dialog"]');
		let ql = await text(page, '[role="dialog"]');
		check("Space opens Quick Look on the selected rule with its three facts", ql.includes("New PDF → Hand to Dazzi") && ql.includes("When") && ql.includes("Does") && ql.includes(SUMMARY), ql);
		await page.screenshot({ path: join(EVIDENCE, "03-quick-look-en.png") });
		await page.keyboard.press("ArrowDown");
		await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent?.includes("Markdown changes") === true);
		check("Quick Look follows the arrow keys", true);
		await page.keyboard.press("Escape");
		check("Esc closes Quick Look", (await page.locator('[role="dialog"]').count()) === 0);
		await page.keyboard.press(" ");
		await page.waitForSelector('[role="dialog"]');
		await page.keyboard.press(" ");
		check("Space again closes Quick Look", (await page.locator('[role="dialog"]').count()) === 0);

		// 4. Context menu.
		await page.locator(ROW(ruleA.id)).click({ button: "right" });
		await page.waitForSelector('[role="menu"]');
		const items = (await page.locator('[role="menu"] [role="menuitem"]').allInnerTexts()).map((label) => label.replace(/\s+/g, " ").trim());
		check("the rule menu offers Quick Look, edit, open folder, add, delete", items.length === 5 && /^Quick Look/.test(items[0]) && /^Edit in AI Search/.test(items[1]) && items[2] === "Open watched folder" && items[3].startsWith("Add a rule in AI Search") && items[4] === "Delete", JSON.stringify(items));
		await sleep(350);
		await page.screenshot({ path: join(EVIDENCE, "04-menu-en.png") });
		await page.keyboard.press("Escape");
		check("Esc closes the menu", (await page.locator('[role="menu"]').count()) === 0);

		// 5. Edit and add open an AI draft, sent to nobody.
		await page.locator(ROW(ruleA.id)).click();
		const tabsBeforeEdit = (await tabs(page)).length;
		await page.keyboard.press("Enter");
		await page.waitForSelector(COMPOSER);
		const draft = await page.locator(COMPOSER).inputValue();
		check("Enter opens a NEW AI Search tab", (await tabs(page)).length === tabsBeforeEdit + 1 && (await tabs(page)).find((tab) => tab.active)?.ai === true, JSON.stringify(await tabs(page)));
		check(
			"the composer holds the edit draft, in English, naming the rule and ending where the person types",
			draft === "Edit this automation rule — downloads-pdf-summary (PDF files are created in Downloads). What to change: ",
			JSON.stringify(draft),
		);
		check("the composer is focused", await page.evaluate(() => document.activeElement?.closest(".compose-box") !== null && document.activeElement?.tagName === "INPUT"));
		await sleep(800);
		check("nothing was sent: no user bubble, no running search", (await page.locator(`${AI_PANEL} .user-msg`).count()) === 0 && (await page.locator('button[aria-label="Stop"]').count()) === 0);
		await page.screenshot({ path: join(EVIDENCE, "05-edit-draft-en.png") });
		await page.locator(".tabs .tab").filter({ hasText: "Automations" }).first().click();
		await page.waitForSelector(ROW(ruleA.id));
		await page.locator("[data-rules-body]").click({ button: "right", position: { x: 40, y: 400 } });
		await page.waitForSelector('[role="menu"]');
		check("the empty space offers only adding a rule", (await page.locator('[role="menu"] [role="menuitem"]').count()) === 1);
		await page.locator('[role="menu"] [role="menuitem"]').click();
		await page.waitForSelector(COMPOSER);
		check("add opens another AI tab with the creation draft", (await page.locator(COMPOSER).inputValue()) === "Create a new automation rule. When, on which files, and what to do: ", JSON.stringify(await page.locator(COMPOSER).inputValue()));
		await page.locator(".tabs .tab").filter({ hasText: "Automations" }).first().click();
		await page.waitForSelector(ROW(ruleA.id));

		// 6. Delete and undo.
		const original = readRules();
		await page.locator(ROW(ruleB.id)).click();
		await page.keyboard.press("Delete");
		await page.waitForSelector('[role="alertdialog"]');
		const confirm = await text(page, '[role="alertdialog"]');
		check("delete asks first and says the folder and files stay", confirm.includes("Delete the rule") && confirm.includes("the folder and its files stay"), confirm);
		await sleep(350);
		await page.screenshot({ path: join(EVIDENCE, "06-confirm-en.png") });
		await page.keyboard.press("Escape");
		check("Esc cancels and the rule stays", (await page.locator('[role="alertdialog"]').count()) === 0 && (await rowIds(page)).includes(ruleB.id) && readRules().length === 3);
		await page.keyboard.press("Delete");
		await page.waitForSelector('[role="alertdialog"]');
		await page.locator('[role="alertdialog"] button', { hasText: /^Delete$/ }).click();
		await page.waitForFunction((id) => document.querySelector(`[role="row"][data-rule-id="${id}"]`) === null, ruleB.id);
		check("confirming removes the row", JSON.stringify(await rowIds(page)) === JSON.stringify([ruleA.id, ruleC.id]));
		check("the rules file lost only that rule, the others byte-for-byte", JSON.stringify(readRules()) === JSON.stringify([original[0], original[2]]));
		check("the next rule is selected", (await page.locator(`${ROW(ruleC.id)}[aria-selected="true"]`).count()) === 1);
		const toast = await text(page, "output.toast");
		check("a toast offers Undo", toast.includes("Deleted the rule") && toast.includes("Undo"), toast);
		await sleep(250);
		await page.screenshot({ path: join(EVIDENCE, "07-deleted-toast-en.png") });
		await page.locator("output.toast button", { hasText: "Undo" }).click();
		await page.waitForSelector(ROW(ruleB.id));
		check("Undo puts the rule back in its place", JSON.stringify(await rowIds(page)) === JSON.stringify([ruleA.id, ruleB.id, ruleC.id]), JSON.stringify(await rowIds(page)));
		check("the rules file is as it was", JSON.stringify(readRules()) === JSON.stringify(original));
		check("the restored rule is selected", (await page.locator(`${ROW(ruleB.id)}[aria-selected="true"]`).count()) === 1);

		// 7. The folder inspector: the QA root in the sidebar turns the focused tab (Automations) into the folder the lane watches.
		await sidebarItem(page, "QA").click();
		await page.waitForSelector(`[data-path="${cssAttr(DOWNLOADS)}"]`);
		await page.locator(`[data-path="${cssAttr(DOWNLOADS)}"]`).click();
		await page.waitForSelector(`${INSPECTOR} >> text=Automations on this folder`);
		inspector = await text(page, INSPECTOR);
		check("a watched folder's inspector lists the two rules that watch it", inspector.includes("Automations on this folder") && inspector.includes("New PDF → Hand to Dazzi") && inspector.includes("New HWP → Run hwp5-qa-missing") && !inspector.includes("Markdown changes"), inspector);
		await page.locator(`[data-path="${cssAttr(NOTES)}"]`).click();
		inspector = await text(page, INSPECTOR);
		check("a folder watched in a group lists that rule, and others stay clean", inspector.includes("Markdown changes → Refresh search index"));
		await page.locator(`[data-path="${cssAttr(DOWNLOADS)}"]`).click();
		await page.screenshot({ path: join(EVIDENCE, "08-folder-inspector-en.png") });
		await page.locator(`${INSPECTOR} [role="button"]`, { hasText: "New HWP" }).click({ button: "right" });
		await page.waitForSelector('[role="menu"]');
		const folderMenu = (await page.locator('[role="menu"] [role="menuitem"]').allInnerTexts()).map((label) => label.replace(/\s+/g, " ").trim());
		check("a folder's rule row menu adds Show in Automations", folderMenu.some((label) => label === "Show in Automations"), JSON.stringify(folderMenu));
		await page.locator('[role="menu"] [role="menuitem"]', { hasText: "Show in Automations" }).click();
		await page.waitForSelector(`${ROW(ruleC.id)}[aria-selected="true"]`);
		check("Show in Automations selects that rule in the list", true);
		await sidebarItem(page, "QA").click();
		await page.waitForSelector(`[data-path="${cssAttr(DOWNLOADS)}"]`);
		await page.locator(`[data-path="${cssAttr(DOWNLOADS)}"]`).click();
		const aiTabs = (await tabs(page)).filter((tab) => tab.ai).length;
		await page.locator(`${INSPECTOR} [role="button"]`, { hasText: "New PDF" }).click();
		await page.waitForSelector(COMPOSER);
		check("a folder rule row edits through a new AI draft", (await tabs(page)).filter((tab) => tab.ai).length === aiTabs + 1 && (await page.locator(COMPOSER).inputValue()).includes("downloads-pdf-summary"));

		// 8. A change behind the app's back, then a file the librarian refuses.
		await openAutomations(page);
		const ruleD = { id: "agent-made", paths: [PROJECTS], events: ["create"], include: ["**/*.docx"], run: ["autorag", "refresh"] };
		writeRules([ruleA, ruleB, ruleC, ruleD]);
		await page.waitForSelector(ROW(ruleD.id), { timeout: 20_000 });
		check("a rule added outside the app appears without a click", (await text(page, ROW(ruleD.id))).includes("New Word → Refresh search index"), await text(page, ROW(ruleD.id)));
		check("the count follows", (await text(page, "[data-daemon]")).includes("Rules: 4"));
		writeFileSync(RULES, `${JSON.stringify({ automations: [{ ...ruleA, note: "not a librarian field" }] }, null, 2)}\n`);
		await page.waitForSelector("text=The rules file cannot be read", { timeout: 20_000 });
		const broken = await text(page, "[data-rules-body]");
		check("an unreadable rules file shows why, not an empty list", broken.includes("Unknown field") && !broken.includes("No automations yet"), broken);
		await page.screenshot({ path: join(EVIDENCE, "09-config-error-en.png") });
		writeRules([ruleA, ruleB, ruleC]);
		await page.waitForSelector(ROW(ruleB.id), { timeout: 20_000 });
		check("fixing the file brings the list back", JSON.stringify(await rowIds(page)) === JSON.stringify([ruleA.id, ruleB.id, ruleC.id]));
		writeFileSync(RULES, `${JSON.stringify({ automations: [] }, null, 2)}\n`);
		await page.waitForSelector("text=No automations yet", { timeout: 20_000 });
		check("an empty rules file invites adding the first rule", (await text(page, "[data-rules-body]")).includes("Add a rule in AI Search"));
		await page.screenshot({ path: join(EVIDENCE, "10-empty-en.png") });
		writeRules([ruleA, ruleB, ruleC]);
		await page.waitForSelector(ROW(ruleA.id), { timeout: 20_000 });

		// Dark appearance keeps the same structure.
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = "dark";
		});
		await sleep(600);
		await page.locator(ROW(ruleC.id)).click();
		await page.screenshot({ path: join(EVIDENCE, "11-dark-en.png") });
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = "light";
		});
	} finally {
		await app.close().catch(() => undefined);
	}
}

/** Korean carries the real checks; Japanese and Chinese prove the layout and that no key shows through. */
async function otherLanguage(language, name, expectations) {
	const { app, page } = await launch(language, name);
	try {
		await openAutomations(page);
		const body = await text(page, "body");
		check(`${language}: no untranslated key shows`, !/automations\.[a-z]+\./.test(body), body.slice(0, 200));
		check(`${language}: the toolbar and rows read in ${language}`, expectations.every((word) => body.includes(word)), expectations.filter((word) => !body.includes(word)).join(", "));
		await page.locator(ROW(ruleC.id)).click();
		await page.screenshot({ path: join(EVIDENCE, `12-list-${language}.png`) });
		await page.locator(ROW(ruleA.id)).click();
		await page.keyboard.press("Enter");
		await page.waitForSelector(COMPOSER);
		const draft = await page.locator(COMPOSER).inputValue();
		check(`${language}: the draft is written in ${language}, names the rule, and is not sent`, draft.includes("downloads-pdf-summary") && draft.endsWith(": ") && (await page.locator(`${AI_PANEL} .user-msg`).count()) === 0, JSON.stringify(draft));
		await page.screenshot({ path: join(EVIDENCE, `13-draft-${language}.png`) });
	} finally {
		await app.close().catch(() => undefined);
	}
}

try {
	await english();
	writeRules([ruleA, ruleB, ruleC]);
	runLog(ruleA.id, { startedAt: ago(3), exitCode: 0 });
	await otherLanguage("ko", "ko", ["자동화", "새 PDF → Dazzi에게 맡기기", "꺼짐 · 규칙이 실행되지 않습니다", "규칙 3개"]);
	await otherLanguage("ja", "ja", ["自動化", "新しいPDF", "オフ"]);
	await otherLanguage("zh", "zh", ["自动化", "新PDF", "已关闭"]);
} catch (error) {
	check("run completed", false, String(error).slice(0, 600));
} finally {
	rmSync(WORK, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.log(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
