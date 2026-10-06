/**
 * Manual QA — dragging Finder rows out of the app, and the in-app drops that
 * must survive it (issue #83).
 *
 * Drives the production Electron app (out/) with Playwright against a fixture
 * folder in a throwaway HOME and proves:
 *
 *   1. a row `dragstart` cancels the HTML5 gesture and hands the row's absolute
 *      path to the main process (`fs:startDrag` → `webContents.startDrag`);
 *   2. a multi-select drag hands the whole selection;
 *   3. the native drag coming back over a folder row moves the rows there, with
 *      a visible drop highlight while it hovers;
 *   4. ⌥ makes that drop copy instead;
 *   5. a drop on another folder tab moves the rows into that tab's folder;
 *   6. a drag another app started is left alone by the folder rows (only this
 *      window's own drag moves);
 *   7. the same drag dropped on an AI Search tab still attaches, never moves;
 *   8. (opt-in, macOS, QA_REAL_DRAG_OUT=1) a real pointer drag from a row to a
 *      real Finder window lands the file there — the end-to-end proof that the
 *      OS receives the files. It moves the real cursor and needs Accessibility
 *      permission for the terminal.
 *
 * The automated checks never post OS mouse events: `stubNativeDrag` neutralizes
 * the real drag in the main process and `startRowDrag` arms it the way the app
 * does, while the drops go through Chromium's native drop path
 * (`Input.dispatchDragEvent` with `files`, the same route an OS drag takes).
 *
 * Prerequisites: `bun run build`.
 * Run: bun scripts/manual-qa/run-qa-finder-drag-out.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { AI_PANEL, finderWindow, launchFinder, openAiSearch, startRowDrag, stubNativeDrag } from "./launch-finder.mjs";
import { chord, isMac, sleep } from "./platform.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = join(ROOT, ".omo", "evidence", "ai-finder-app", "qa-native-drag-out");
mkdirSync(EVIDENCE, { recursive: true });
const REAL_DRAG = process.env.QA_REAL_DRAG_OUT === "1";

const home = mkdtempSync(join(tmpdir(), "ulw-native-drag-out-home-"));
const top = join(home, "Documents", "qa-native-drag-out");
const dirA = join(top, "A");
const dirB = join(top, "B");
// The real-drag target sits outside the browsed folder, as another app's window would.
const out = join(home, "Downloads", "drag-target");
for (const directory of [top, dirA, dirB, out]) mkdirSync(directory, { recursive: true });

const SINGLE = join(top, "single.txt");
const SECOND = join(top, "second.txt");
const MOVED = join(top, "moved.txt");
const COPIED = join(top, "copied.txt");
const TABBED = join(top, "tabbed.txt");
const FOREIGN = join(top, "foreign.txt");
const ATTACHED = join(top, "attached.txt");
for (const [path, body] of [
	[SINGLE, "single\n"],
	[SECOND, "second\n"],
	[MOVED, "move me\n"],
	[COPIED, "copy me\n"],
	[TABBED, "tab me\n"],
	[FOREIGN, "foreign\n"],
	[ATTACHED, "attach me\n"],
]) {
	writeFileSync(path, body);
}
writeFileSync(join(out, "target-placeholder.txt"), "target\n");

const results = [];
const check = (name, pass, detail) => {
	results.push({ name, pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
};

const row = (page, path) => page.locator(`[data-path="${path}"]`);
const listNames = (dir) => readdirSync(dir).sort();
const atTitle = (page, name) =>
	page.waitForFunction((want) => document.querySelector(".toolbar-title")?.textContent === want, name, { timeout: 15_000 });

/** Wait until `predicate` holds or the deadline passes. */
async function until(page, predicate, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await page.waitForTimeout(150);
	}
	return predicate();
}

/** The point at the center of a locator's box. */
async function centerOf(target) {
	const box = await target.boundingBox();
	if (box === null) throw new Error("drop target is not visible");
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * A held native drag entering/hovering a point, then dropped there. Blink's
 * operation bits are Copy=1 and Move=16; allowing both lets a target that asks
 * for either (`copy` on AI Search, `move` on a folder row) accept the drop.
 */
async function cdpDropAt(page, cdp, paths, point, midCheck) {
	const data = { items: [], files: paths, dragOperationsMask: 1 | 16 };
	for (const type of ["dragEnter", "dragOver"]) {
		await cdp.send("Input.dispatchDragEvent", { type, ...point, data, modifiers: 0 });
		await page.waitForTimeout(150);
	}
	if (midCheck !== undefined) await midCheck();
	await cdp.send("Input.dispatchDragEvent", { type: "drop", ...point, data, modifiers: 0 });
	await page.waitForTimeout(400);
}

const cdpDrop = async (page, cdp, paths, target, midCheck) =>
	cdpDropAt(page, cdp, paths, await centerOf(target), midCheck);

let app = null;
try {
	console.log(`fixture: ${top}`);
	app = await launchFinder({
		userDataDir: mkdtempSync(join(tmpdir(), "ulw-native-drag-out-data-")),
		env: { HOME: home, AUTORAG_QA_ROOT: top },
	});
	const page = await finderWindow(app, 30_000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
	await page.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
	await page.waitForSelector(".toolbar-title", { timeout: 30_000 });
	await atTitle(page, "qa-native-drag-out");
	const cdp = await page.context().newCDPSession(page);
	const startDrags = await stubNativeDrag(app);

	/* ----------------------------- 1. a single row drag hands the OS its path */
	await row(page, SINGLE).click();
	await startRowDrag(page, SINGLE);
	const single = await startDrags();
	check(
		"a row dragstart hands the row's absolute path to the native drag",
		JSON.stringify(single.at(-1)) === JSON.stringify([SINGLE]),
		JSON.stringify(single),
	);

	/* ------------------------------- 2. a multi-select drag hands the whole set */
	await row(page, SINGLE).click();
	await row(page, SECOND).click({ modifiers: ["Meta"] });
	await startRowDrag(page, SECOND);
	const multi = (await startDrags()).at(-1) ?? [];
	check(
		"dragging one row of a selection hands every selected path",
		multi.length === 2 && multi.includes(SINGLE) && multi.includes(SECOND),
		JSON.stringify(multi),
	);
	await page.keyboard.press("Escape");

	/* --------------------- 3. the drag coming back onto a folder row moves it */
	await row(page, MOVED).click();
	await startRowDrag(page, MOVED);
	let highlighted = false;
	await cdpDrop(page, cdp, [MOVED], row(page, dirA), async () => {
		highlighted = await row(page, dirA).evaluate((node) => node.className.includes("accent-drop-hover"));
		await page.screenshot({ path: join(EVIDENCE, "1-move-hover.png") });
	});
	await until(page, () => existsSync(join(dirA, "moved.txt")));
	check(
		"the row drag dropped on a folder row moves it there, with a visible highlight",
		highlighted && existsSync(join(dirA, "moved.txt")) && !existsSync(MOVED),
		`highlight=${highlighted} A=${listNames(dirA)}`,
	);
	await page.screenshot({ path: join(EVIDENCE, "2-move.png") });

	/* ------------------------------------------- 4. ⌥ makes the drop a copy */
	await row(page, COPIED).click();
	// Chromium aborts a synthesized drop while Alt is held, so the ⌥ variant is
	// the same DragEvent from the page with a `Files` payload.
	await startRowDrag(page, COPIED);
	const copiedHighlighted = await page.evaluate((target) => {
		const data = new DataTransfer();
		data.items.add(new File(["x"], "x"));
		const node = document.querySelector(`[data-path="${target}"]`);
		node?.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data, altKey: true }));
		return new Promise((resolve) =>
			window.setTimeout(() => {
				const highlighted = node?.className.includes("accent-drop-hover") ?? false;
				node?.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data, altKey: true }));
				resolve(highlighted);
			}, 250),
		);
	}, dirA);
	await until(page, () => existsSync(join(dirA, "copied.txt")));
	check(
		"⌥-dropping the row drag on a folder row copies it",
		copiedHighlighted && existsSync(join(dirA, "copied.txt")) && existsSync(COPIED),
		`highlight=${copiedHighlighted} A=${listNames(dirA)}`,
	);

	/* ------------------------------------ 5. a drop on another tab moves there */
	await page.keyboard.press(chord("t"));
	await page.waitForFunction(() => document.querySelectorAll(".tab").length === 2);
	await row(page, dirB).dblclick();
	await atTitle(page, "B");
	await page.locator(".tab").first().click();
	await atTitle(page, "qa-native-drag-out");
	await row(page, TABBED).click();
	await startRowDrag(page, TABBED);
	await cdpDrop(page, cdp, [TABBED], page.locator(".tab").nth(1));
	await atTitle(page, "B");
	await until(page, () => existsSync(join(dirB, "tabbed.txt")));
	check(
		"the row drag dropped on another tab moves it into that tab's folder",
		existsSync(join(dirB, "tabbed.txt")) && !existsSync(TABBED),
		`B=${listNames(dirB)}`,
	);
	await page.screenshot({ path: join(EVIDENCE, "3-tab.png") });
	await page.keyboard.press(chord("w"));
	await atTitle(page, "qa-native-drag-out");

	/* -------------------- 7. a drag another app started is left alone */
	check("foreign-source fixture is in place", existsSync(FOREIGN), FOREIGN);
	const beforeForeign = listNames(dirA);
	// No startRowDrag: this drag is another app's, so the folder row must ignore it.
	await cdpDrop(page, cdp, [FOREIGN], row(page, dirA));
	await page.waitForTimeout(600);
	check(
		"a file dropped from another app is not treated as this window's row drag",
		existsSync(FOREIGN) && JSON.stringify(listNames(dirA)) === JSON.stringify(beforeForeign),
		`A=${listNames(dirA)} (was ${beforeForeign})`,
	);

	/* -------------------- 8. the same drag on AI Search still attaches, not moves */
	// A second tab becomes AI Search; the folder tab stays in front so its rows
	// can be dragged onto the AI Search strip tab.
	await page.keyboard.press(chord("t"));
	await openAiSearch(page);
	await page.locator(".tab").first().click();
	await row(page, ATTACHED).first().waitFor({ state: "visible", timeout: 15_000 });
	await row(page, ATTACHED).click();
	await startRowDrag(page, ATTACHED);
	await cdpDrop(page, cdp, [ATTACHED], page.locator('.tabs .tab[data-ai-search="true"]').first());
	await page.waitForTimeout(600);
	const attached = await page.$$eval(`${AI_PANEL} .composer-attach-pill`, (nodes) =>
		nodes.map((node) => node.getAttribute("title")),
	);
	check(
		"the row drag dropped on AI Search attaches the path and leaves the file in place",
		attached.includes(ATTACHED) && existsSync(ATTACHED),
		`pills=${JSON.stringify(attached)}`,
	);
	await page.screenshot({ path: join(EVIDENCE, "4-attach.png") });

	/* ---------------- 9. opt-in: a real pointer drag reaches a Finder window */
	if (REAL_DRAG) {
		if (!isMac) {
			check("real drag-out is macOS-only", false, "skipped on this platform");
		} else {
			const bounds = await app.evaluate(({ BrowserWindow }) =>
				BrowserWindow.getAllWindows()
					.filter((window) => window.webContents.getURL().endsWith("/index.html"))
					.map((window) => window.getContentBounds())[0],
			);
			const finderBounds = [bounds.x + 40, bounds.y + 40, bounds.x + 620, bounds.y + 420];
			execFileSync("osascript", [
				"-e",
				`tell application "Finder"
					activate
					set w to make new Finder window to (POSIX file "${out}" as alias)
					set current view of w to icon view
					set bounds of w to {${finderBounds.join(", ")}}
				end tell`,
			]);
			await sleep(1500);
			// The app is behind the Finder window now; bring its row into view.
			await page.bringToFront();
			await sleep(500);
			const box = await row(page, SINGLE).boundingBox();
			const from = { x: bounds.x + box.x + box.width / 2, y: bounds.y + box.y + box.height / 2 };
			const to = { x: (finderBounds[0] + finderBounds[2]) / 2, y: (finderBounds[1] + finderBounds[3]) / 2 };
			execFileSync("swift", [join(ROOT, "scripts", "manual-qa", "os-drag.swift"), "drag", String(from.x), String(from.y), String(to.x), String(to.y)]);
			await until(page, () => existsSync(join(out, "single.txt")), 15_000);
			check(
				"a real pointer drag out of the app lands the file in a Finder window",
				existsSync(join(out, "single.txt")),
				`target=${listNames(out)}`,
			);
		}
	} else {
		console.log("SKIP real pointer drag-out (set QA_REAL_DRAG_OUT=1 to run it)");
	}
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
