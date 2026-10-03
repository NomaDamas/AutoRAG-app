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
 *      into that tab's folder, with the tab highlighted while hovered;
 *   7. ⌘C/⌘V while the search field has focus never touches the filesystem.
 *
 * Drags go through Chromium's native drag path (`Input.dispatchDragEvent`, the
 * same route an OS drag takes); the ⌥ variant dispatches the identical
 * `DragEvent` from the page because Chromium aborts a synthesized drop while
 * Alt is held.
 *
 * Run from the repo root after `bun run build`:
 * `bun scripts/manual-qa/run-qa-finder-file-ops.mjs`
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = join(ROOT, ".omo", "evidence", "ai-finder-app", "qa-file-ops");
mkdirSync(EVIDENCE, { recursive: true });

const FINDER_DRAG_TYPE = "application/x-autorag-finder-entries";

const home = mkdtempSync(join(tmpdir(), "ulw-fileops-home-"));
const top = join(home, "Documents", "qa-file-ops");
const dirA = join(top, "A");
const dirB = join(top, "B");
for (const directory of [top, dirA, dirB]) mkdirSync(directory, { recursive: true });

const COPIES = join(top, "copy-me.txt");
const MOVES = join(top, "move-me.txt");
const DRAGS = join(top, "drag-me.txt");
const ALTS = join(top, "alt-me.txt");
const TABS = join(top, "tab-me.txt");
for (const [path, body] of [
	[COPIES, "copy fixture\n"],
	[MOVES, "move fixture\n"],
	[DRAGS, "drag fixture\n"],
	[ALTS, "alt fixture\n"],
	[TABS, "tab fixture\n"],
]) {
	await Bun.write(path, body);
}

const results = [];
const check = (name, pass, detail) => {
	results.push({ name, pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
};

/** Rows are addressed by their absolute path, so a fixture name can never alias another row. */
const row = (page, path) => page.locator(`[data-path="${path}"]`);
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
				const over = document.querySelector(`[data-path="${target}"]`);
				over?.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data, altKey }));
				window.setTimeout(() => {
					const highlighted =
						document.querySelector(`[data-path="${target}"]`)?.className.includes("accent-drop-hover") ?? false;
					document
						.querySelector(`[data-path="${target}"]`)
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
	await page.keyboard.press("Meta+c");
	await row(page, dirB).dblclick();
	await atTitle(page, "B");
	await page.keyboard.press("Meta+v");
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
	await page.keyboard.press("Meta+v");
	await page.waitForTimeout(800);
	check(
		"⌘V in the row's own folder writes nothing",
		!listNames(top).some((name) => name.startsWith("copy-me copy")),
		`root=${listNames(top)}`,
	);

	/* ------------------------------------------------------ 3. ⌘X / ⌘V move */
	await row(page, MOVES).click();
	await page.keyboard.press("Meta+x");
	await row(page, dirB).dblclick();
	await atTitle(page, "B");
	await page.keyboard.press("Meta+v");
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
	await page.keyboard.press("Meta+t");
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

	/* ---------------------------------------- 7. ⌘V while typing stays text */
	const count = () => listNames(top).length + listNames(dirA).length + listNames(dirB).length;
	const before = count();
	await page.locator(".search__input").click();
	await page.keyboard.type("copy");
	await page.keyboard.press("Meta+a");
	await page.keyboard.press("Meta+c");
	await page.keyboard.press("Meta+v");
	await page.waitForTimeout(600);
	await page.keyboard.press("Escape");
	check(
		"⌘C/⌘V in the search field never touches the filesystem",
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
