/**
 * Manual QA — Finder file operations on the real build.
 *
 * Drives the production Electron app (out/) with Playwright against a fixture
 * folder in a throwaway HOME and proves the basic Finder operations end to end
 * (through the real IPC + filesystem, asserted on disk, not just in the UI):
 *
 *   1. ⌘C then ⌘V in another folder copies the row;
 *   2. ⌘V in the row's own folder is a no-op (no " copy" sibling);
 *   3. ⌘X then ⌘V in another folder moves the row;
 *   4. dragging a row onto a folder row moves it there, with a visible drop
 *      highlight while the drag hovers the folder;
 *   5. holding ⌥ while dragging onto a folder row copies instead;
 *   6. dropping a row on another tab switches to that tab and moves the row
 *      into that tab's folder, with the tab highlighted while hovered, and the
 *      AI Search drag overlay clears once the drop is done;
 *   7. dwelling on a tab for ~1.5s adopts that tab with the drag still held, so
 *      the rows can then be dropped into a folder inside it;
 *   8. dwelling on a tab and dropping on its listing background moves the row
 *      into that tab's folder;
 *  9. ⌘Z undoes the most recent ⌘C/⌘V copy and the most recent ⌘X/⌘V move,
 *      and a second ⌘Z steps further back through the history;
 *  10. ⌘C/⌘V while the search field has focus never touches the filesystem.
 *
 * Drags go through Chromium's native drag path (`Input.dispatchDragEvent`, the
 * same route an OS drag takes); the ⌥ variant dispatches the identical
 * `DragEvent` from the page because Chromium aborts a synthesized drop while
 * Alt is held.
 *
 * Run from the repo root after `bun run build`:
 * `bun scripts/manual-qa/run-qa-finder-file-ops.mjs`
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { finderWindow, launchFinder, openAiSearch } from "./launch-finder.mjs";
import { chord, cssAttr } from ".\/platform.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = join(ROOT, ".omo", "evidence", "ai-finder-app", "qa-file-ops");
mkdirSync(EVIDENCE, { recursive: true });

const FINDER_DRAG_TYPE = "application/x-autorag-finder-entries";
/**
 * Copy shown by the AI Search panel's drag overlay. The lane runs in English
 * (`launchFinder` seeds `en`), so read the real string from the locale file —
 * a hard-coded Korean literal never matches and makes "no overlay lingers"
 * checks pass vacuously.
 */
const DOCK_OVERLAY = JSON.parse(readFileSync(join(ROOT, "src", "shared", "i18n", "locales", "en.json"), "utf8")).aiSearch.dropPrompt;

const home = mkdtempSync(join(tmpdir(), "ulw-fileops-home-"));
const top = join(home, "Documents", "qa-file-ops");
const dirA = join(top, "A");
const dirB = join(top, "B");
const sub = join(dirB, "sub");
for (const directory of [top, dirA, dirB, sub]) mkdirSync(directory, { recursive: true });

const COPIES = join(top, "copy-me.txt");
const MOVES = join(top, "move-me.txt");
const DRAGS = join(top, "drag-me.txt");
const ALTS = join(top, "alt-me.txt");
const TABS = join(top, "tab-me.txt");
const SPRINGS = join(top, "spring-me.txt");
const BACKGROUNDS = join(top, "background-me.txt");
const UNDO_COPIES = join(top, "alpha-restore.txt");
const UNDO_MOVES = join(top, "bravo-restore.txt");
for (const [path, body] of [
	[COPIES, "copy fixture\n"],
	[MOVES, "move fixture\n"],
	[DRAGS, "drag fixture\n"],
	[ALTS, "alt fixture\n"],
	[TABS, "tab fixture\n"],
	[SPRINGS, "spring fixture\n"],
	[BACKGROUNDS, "background fixture\n"],
	[UNDO_COPIES, "zulu\n"],
	[UNDO_MOVES, "yankee\n"],
]) {
	await Bun.write(path, body);
}

const results = [];
const check = (name, pass, detail) => {
	results.push({ name, pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
};

/** Rows are addressed by their absolute path, so a fixture name can never alias another row. */
const row = (page, path) => page.locator(`[data-path="${cssAttr(path)}"]`);
const waitForRow = (page, path, present = true) =>
	row(page, path).first().waitFor({ state: present ? "visible" : "detached", timeout: 15_000 });
const listNames = (dir) => readdirSync(dir).sort();
const dragPayload = (paths) =>
	paths.map((path) => ({ path, name: basename(path), kind: "file" }));
const atTitle = (page, name) =>
	page.waitForFunction((want) => document.querySelector(".toolbar-title")?.textContent === want, name, { timeout: 15_000 });

/** Chromium's native drag-and-drop, dropped at the target's center. */
async function cdpDrag(page, cdp, paths, target, midCheck) {
	const box = await target.boundingBox();
	if (box === null) throw new Error("drop target is not visible");
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	const data = { items: [{ mimeType: FINDER_DRAG_TYPE, data: JSON.stringify(dragPayload(paths)) }], dragOperationsMask: 16 };
	for (const type of ["dragEnter", "dragOver"]) {
		await cdp.send("Input.dispatchDragEvent", { type, x, y, data, modifiers: 0 });
		await page.waitForTimeout(150);
	}
	if (midCheck !== undefined) await midCheck();
	await cdp.send("Input.dispatchDragEvent", { type: "drop", x, y, data, modifiers: 0 });
	await page.waitForTimeout(400);
}

/** The same DragEvent the browser delivers, with ⌥ — returns whether the target showed the highlight. */
function domDrag(page, paths, targetPath, alt) {
	return page.evaluate(
		([payload, target, altKey]) =>
			new Promise((resolve) => {
				const data = new DataTransfer();
				data.setData("application/x-autorag-finder-entries", JSON.stringify(payload));
				const over = document.querySelector(`[data-path="${CSS.escape(target)}"]`);
				over?.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data, altKey }));
				window.setTimeout(() => {
					const highlighted =
						document.querySelector(`[data-path="${CSS.escape(target)}"]`)?.className.includes("accent-drop-hover") ?? false;
					document
						.querySelector(`[data-path="${CSS.escape(target)}"]`)
						?.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data, altKey }));
					resolve(highlighted);
				}, 250);
			}),
		[dragPayload(paths), targetPath, alt],
	);
}

let app = null;
try {
	console.log(`fixture: ${top}`);
	app = await launchFinder({
		userDataDir: mkdtempSync(join(tmpdir(), "ulw-fileops-data-")),
		env: { HOME: home, AUTORAG_QA_ROOT: top },
	});
	const page = await finderWindow(app, 30_000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
	await page.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
	await page.waitForSelector(".toolbar-title", { timeout: 30_000 });
	await atTitle(page, "qa-file-ops");
	await waitForRow(page, COPIES);
	const cdp = await page.context().newCDPSession(page);

	/* ------------------------------------------------------ 1. ⌘C / ⌘V copy */
	await row(page, COPIES).click();
	await page.keyboard.press(chord("c"));
	await row(page, dirB).dblclick();
	await atTitle(page, "B");
	await page.keyboard.press(chord("v"));
	await waitForRow(page, join(dirB, "copy-me.txt"));
	check(
		"⌘C then ⌘V copies into another folder",
		existsSync(join(dirB, "copy-me.txt")) && existsSync(COPIES),
		`root=${listNames(top)} B=${listNames(dirB)}`,
	);
	await page.screenshot({ path: join(EVIDENCE, "1-keyboard-copy.png") });

	/* ------------------------------------------- 2. paste in the same folder */
	await page.locator("nav.pathbar .path-seg", { hasText: "qa-file-ops" }).first().click();
	await atTitle(page, "qa-file-ops");
	await page.keyboard.press(chord("v"));
	await page.waitForTimeout(800);
	check(
		"⌘V in the row's own folder writes nothing",
		!listNames(top).some((name) => name.startsWith("copy-me copy")),
		`root=${listNames(top)}`,
	);

	/* ------------------------------------------------------ 3. ⌘X / ⌘V move */
	await row(page, MOVES).click();
	await page.keyboard.press(chord("x"));
	await row(page, dirB).dblclick();
	await atTitle(page, "B");
	await page.keyboard.press(chord("v"));
	await waitForRow(page, join(dirB, "move-me.txt"));
	check(
		"⌘X then ⌘V moves into another folder",
		existsSync(join(dirB, "move-me.txt")) && !existsSync(MOVES),
		`root=${listNames(top)} B=${listNames(dirB)}`,
	);
	await page.screenshot({ path: join(EVIDENCE, "2-keyboard-move.png") });

	/* ------------------------------------------------ 4. drag onto a folder */
	await page.locator("nav.pathbar .path-seg", { hasText: "qa-file-ops" }).first().click();
	await atTitle(page, "qa-file-ops");
	await waitForRow(page, DRAGS);
	let highlighted = false;
	await cdpDrag(page, cdp, [DRAGS], row(page, dirA), async () => {
		highlighted = await row(page, dirA).evaluate((node) => node.className.includes("accent-drop-hover"));
		await page.screenshot({ path: join(EVIDENCE, "3-drag-highlight.png") });
	});
	await waitForRow(page, DRAGS, false);
	check(
		"dragging a row onto a folder row moves it, with a visible drop highlight",
		highlighted && existsSync(join(dirA, "drag-me.txt")) && !existsSync(DRAGS),
		`highlight=${highlighted} A=${listNames(dirA)}`,
	);
	await page.screenshot({ path: join(EVIDENCE, "4-drag-move.png") });

	/* --------------------------------------------------- 5. ⌥-drag to copy */
	const highlightedAlt = await domDrag(page, [ALTS], dirA, true);
	await page.waitForTimeout(600);
	check(
		"⌥-dragging a row onto a folder copies it",
		highlightedAlt && existsSync(join(dirA, "alt-me.txt")) && existsSync(ALTS),
		`highlight=${highlightedAlt} A=${listNames(dirA)} root=${listNames(top)}`,
	);

	/* ------------------------------------------------- 6. drag onto a tab */
	await page.keyboard.press(chord("t"));
	await page.waitForFunction(() => document.querySelectorAll(".tab").length === 2);
	await row(page, dirB).dblclick();
	await atTitle(page, "B");
	await page.locator(".tab").first().click();
	await atTitle(page, "qa-file-ops");
	await waitForRow(page, TABS);
	let tabHighlighted = false;
	await cdpDrag(page, cdp, [TABS], page.locator(".tab").nth(1), async () => {
		tabHighlighted = await page.locator(".tab").nth(1).evaluate((node) => node.className.includes("inset_0_0_0_1.5px"));
		await page.screenshot({ path: join(EVIDENCE, "5-tab-highlight.png") });
	});
	await atTitle(page, "B");
	await waitForRow(page, join(dirB, "tab-me.txt"));
	check(
		"dropping on another tab switches to that tab and moves the row into its folder",
		tabHighlighted && existsSync(join(dirB, "tab-me.txt")) && !existsSync(TABS),
		`highlight=${tabHighlighted} B=${listNames(dirB)}`,
	);
	await page.screenshot({ path: join(EVIDENCE, "6-tab-drop.png") });
	check(
		"no AI Search drag overlay lingers once a tab drop has moved the rows",
		(await page.getByText(DOCK_OVERLAY).count()) === 0,
		`overlay nodes=${await page.getByText(DOCK_OVERLAY).count()}`,
	);

	/* --------------------------------------- 7. spring-loaded tab dwell */
	await page.locator(".tab").first().click();
	await atTitle(page, "qa-file-ops");
	await waitForRow(page, SPRINGS);
	const from = await row(page, SPRINGS).boundingBox();
	const tabBox = await page.locator(".tab").nth(1).boundingBox();
	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(from.x + from.width / 2 + 16, from.y + from.height / 2, { steps: 4 });
	await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2, { steps: 8 });
	const tabX = tabBox.x + tabBox.width / 2;
	const tabY = tabBox.y + tabBox.height / 2;
	let springSwitched = false;
	let overlayDuringDwell = 0;
	for (let tick = 0; tick < 15 && !springSwitched; tick += 1) {
		await page.mouse.move(tabX + (tick % 2 === 0 ? 3 : -3), tabY, { steps: 1 });
		await page.waitForTimeout(150);
		overlayDuringDwell = await page.getByText(DOCK_OVERLAY).count();
		springSwitched = (await page.locator(".toolbar-title").textContent()) === "B";
	}
	// The rows are still held: drop them into a folder inside the tab we adopted.
	await page.waitForSelector(`[data-path="${cssAttr(sub)}"]`, { timeout: 15_000 });
	const subBox = await row(page, sub).boundingBox();
	await page.mouse.move(subBox.x + subBox.width / 2, subBox.y + subBox.height / 2, { steps: 8 });
	await page.mouse.move(subBox.x + subBox.width / 2 + 3, subBox.y + subBox.height / 2, { steps: 1 });
	await page.mouse.up();
	// The file lands inside `sub`, so it is not a row in B's listing — wait on disk.
	const deadline = Date.now() + 10_000;
	while (!existsSync(join(sub, "spring-me.txt")) && Date.now() < deadline) await page.waitForTimeout(150);
	await page.waitForTimeout(400);
	await page.screenshot({ path: join(EVIDENCE, "7-spring-load.png") });
	check(
		"dwelling on a tab adopts it, so the held rows can drop into a folder inside it",
		springSwitched && existsSync(join(sub, "spring-me.txt")) && !existsSync(SPRINGS),
		`switched=${springSwitched} B/sub=${listNames(sub)} root=${listNames(top)}`,
	);
	check(
		"no AI Search drag overlay lingers after the spring-loaded drop",
		(await page.getByText(DOCK_OVERLAY).count()) === 0,
		`overlay nodes during dwell=${overlayDuringDwell}, after drop=${await page.getByText(DOCK_OVERLAY).count()}`,
	);

	/* ---------------------------- 8. spring-loaded tab background drop */
	await page.locator(".tab").first().click();
	await atTitle(page, "qa-file-ops");
	await waitForRow(page, BACKGROUNDS);
	const backgroundSource = await row(page, BACKGROUNDS).boundingBox();
	const backgroundTab = await page.locator(".tab").nth(1).boundingBox();
	await page.mouse.move(backgroundSource.x + backgroundSource.width / 2, backgroundSource.y + backgroundSource.height / 2);
	await page.mouse.down();
	await page.mouse.move(backgroundSource.x + backgroundSource.width / 2 + 16, backgroundSource.y + backgroundSource.height / 2, { steps: 4 });
	await page.mouse.move(backgroundTab.x + backgroundTab.width / 2, backgroundTab.y + backgroundTab.height / 2, { steps: 8 });
	const backgroundTabX = backgroundTab.x + backgroundTab.width / 2;
	const backgroundTabY = backgroundTab.y + backgroundTab.height / 2;
	let backgroundSwitched = false;
	for (let tick = 0; tick < 15 && !backgroundSwitched; tick += 1) {
		await page.mouse.move(backgroundTabX + (tick % 2 === 0 ? 3 : -3), backgroundTabY, { steps: 1 });
		await page.waitForTimeout(150);
		backgroundSwitched = (await page.locator(".toolbar-title").textContent()) === "B";
	}
	const listBox = await page.locator(".list").boundingBox();
	const lastRowBox = await page.locator('[role="row"]').last().boundingBox();
	if (listBox === null || lastRowBox === null || listBox.y + listBox.height - 24 <= lastRowBox.y + lastRowBox.height) {
		throw new Error("fixture has no empty listing background below its rows");
	}
	const backgroundX = listBox.x + listBox.width / 2;
	const backgroundY = listBox.y + listBox.height - 24;
	await page.mouse.move(backgroundX, backgroundY, { steps: 8 });
	await page.mouse.move(backgroundX + 3, backgroundY, { steps: 1 });
	// Release only once the listing background accepted the drag (its drop
	// highlight is on); releasing on the same tick races the new tab's listing.
	await page.waitForFunction(() => document.querySelector(".list")?.className.includes("accent-drop-hover") ?? false, undefined, { timeout: 5_000 });
	await page.mouse.up();
	const backgroundDeadline = Date.now() + 10_000;
	while (!existsSync(join(dirB, "background-me.txt")) && Date.now() < backgroundDeadline) await page.waitForTimeout(150);
	await page.waitForTimeout(400);
	await page.screenshot({ path: join(EVIDENCE, "8-background-drop.png") });
	check(
		"dwelling on a tab then dropping on its listing background moves the row into that tab",
		backgroundSwitched && existsSync(join(dirB, "background-me.txt")) && !existsSync(BACKGROUNDS),
		`switched=${backgroundSwitched} B=${listNames(dirB)} root=${listNames(top)}`,
	);
	check(
		"no AI Search drag overlay lingers after a spring-loaded background drop",
		(await page.getByText(DOCK_OVERLAY).count()) === 0,
		`overlay nodes=${await page.getByText(DOCK_OVERLAY).count()}`,
	);

	/* --------------------------------------- 10. orphaned drag overlay watchdog */
	// The overlay belongs to the visible AI Search panel: show one in a new tab.
	await page.keyboard.press(chord("t"));
	await openAiSearch(page);
	await page.evaluate((mime) => {
		const data = new DataTransfer();
		data.setData(mime, JSON.stringify([]));
		window.dispatchEvent(
			new DragEvent("dragover", {
				bubbles: true,
				cancelable: true,
				clientX: 20,
				clientY: 20,
				dataTransfer: data,
			}),
		);
	}, FINDER_DRAG_TYPE);
	await page.waitForTimeout(100);
	const watchdogShown = (await page.getByText(DOCK_OVERLAY).count()) > 0;
	await page.waitForTimeout(1_300);
	check(
		"the AI Search watchdog clears an orphaned drag overlay without drop or dragend",
		watchdogShown && (await page.getByText(DOCK_OVERLAY).count()) === 0,
		`shown=${watchdogShown} overlay nodes=${await page.getByText(DOCK_OVERLAY).count()}`,
	);

	/* ------------------------------------ 11. ⌘Z undoes the last transfer */
	await page.keyboard.press(chord("w"));
	await page.locator(".tab").first().click();
	await atTitle(page, "qa-file-ops");
	await waitForRow(page, UNDO_COPIES);
	await row(page, UNDO_COPIES).click();
	await page.keyboard.press(chord("c"));
	await page.locator(".tab").nth(1).click();
	await atTitle(page, "B");
	await page.keyboard.press(chord("v"));
	await waitForRow(page, join(dirB, "alpha-restore.txt"));
	await page.keyboard.press(chord("z"));
	await page.screenshot({ path: join(EVIDENCE, "10-undo-copy.png") });
	await waitForRow(page, join(dirB, "alpha-restore.txt"), false);
	check(
		"⌘Z removes the copy the last ⌘C/⌘V created",
		!existsSync(join(dirB, "alpha-restore.txt")) && existsSync(UNDO_COPIES),
		`B=${listNames(dirB)} root=${listNames(top)}`,
	);

	await page.locator(".tab").first().click();
	await atTitle(page, "qa-file-ops");
	await waitForRow(page, UNDO_MOVES);
	await row(page, UNDO_MOVES).click();
	await page.keyboard.press(chord("x"));
	await page.locator(".tab").nth(1).click();
	await atTitle(page, "B");
	await page.keyboard.press(chord("v"));
	await waitForRow(page, join(dirB, "bravo-restore.txt"));
	await waitForRow(page, UNDO_MOVES, false);
	await page.keyboard.press(chord("z"));
	const undoMoveDeadline = Date.now() + 10_000;
	while (!existsSync(UNDO_MOVES) && Date.now() < undoMoveDeadline) await page.waitForTimeout(150);
	await page.screenshot({ path: join(EVIDENCE, "11-undo-move.png") });
	check(
		"⌘Z moves the rows of the last ⌘X/⌘V back to their original folder",
		existsSync(UNDO_MOVES) && !existsSync(join(dirB, "bravo-restore.txt")),
		`root=${listNames(top)} B=${listNames(dirB)}`,
	);

	// The history is multi-step (issue #89): a second ⌘Z undoes the operation
	// before the one just undone, so the folders change again.
	const snapshot = () => JSON.stringify([top, dirA, dirB, sub].map((dir) => listNames(dir)));
	const afterUndo = snapshot();
	await page.waitForTimeout(800);
	await page.keyboard.press(chord("z"));
	const secondDeadline = Date.now() + 10_000;
	while (snapshot() === afterUndo && Date.now() < secondDeadline) await page.waitForTimeout(150);
	check(
		"a second ⌘Z undoes the operation before the last one",
		snapshot() !== afterUndo,
		`before=${afterUndo} after=${snapshot()}`,
	);
	/* --------------------------------------- 12. ⌘V/⌘Z while typing stay text */
	const count = () => listNames(top).length + listNames(dirA).length + listNames(dirB).length + listNames(sub).length;
	const before = count();
	const sideSearch = page.locator(".side-search input");
	await sideSearch.click();
	await page.keyboard.type("copy");
	await page.keyboard.press(chord("a"));
	await page.keyboard.press(chord("c"));
	await page.keyboard.press(chord("v"));
	await page.keyboard.press(chord("z"));
	await page.waitForTimeout(600);
	await page.keyboard.press("Escape");
	check(
		"⌘C/⌘V/⌘Z in the sidebar search field never touch the filesystem",
		count() === before && !listNames(top).some((name) => name.startsWith("copy-me copy")),
		`entries=${count()} (was ${before})`,
	);
} catch (error) {
	check("run completed", false, String(error).slice(0, 500));
	if (app !== null) {
		const page = await finderWindow(app).catch(() => null);
		await page?.screenshot({ path: join(EVIDENCE, "failure.png") }).catch(() => undefined);
	}
} finally {
	if (app !== null) await app.close().catch(() => undefined);
}

await Bun.write(join(EVIDENCE, "result.json"), JSON.stringify({ checks: results }, null, 2));
const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
