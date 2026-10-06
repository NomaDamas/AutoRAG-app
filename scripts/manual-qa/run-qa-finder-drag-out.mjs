/**
 * Manual QA — a Finder row drag inside the app vs. out of it (issue #83).
 *
 * Drives the production Electron app (out/) with Playwright against a fixture
 * folder in a throwaway HOME and proves the window edge splits one gesture:
 *
 *   1. dragged inside the window onto a folder row, a row moves there, with a
 *      visible drop highlight and the move cursor while it hovers;
 *   2. ⌥ held during that drag copies instead, with the copy cursor;
 *   3. dropped on another folder tab, the row moves into that tab's folder;
 *   4. a multi-row selection dragged onto a folder row moves every row;
 *   5. dragged onto an AI Search tab, the row attaches and stays in place;
 *   6. Escape cancels a held drag: nothing moves;
 *   7. dragged past the window edge, the rows go to the OS file drag
 *      (`fs:startDrag` → `webContents.startDrag`) with every selected path, and
 *      nothing moves inside the app;
 *   8. a plain click still selects (the drag threshold keeps clicks clicks);
 *   9. (opt-in, macOS, QA_REAL_DRAG_OUT=1) a real pointer drag from a row to a
 *      real Finder window lands the file there — the end-to-end proof that the
 *      OS receives the files. It moves the real cursor and needs Accessibility
 *      permission for the terminal.
 *
 * The automated checks never move the real cursor: Playwright's mouse is
 * synthesized inside the renderer, and `stubNativeDrag` turns the OS drag the
 * app starts at the window edge into a recorded no-op.
 *
 * Prerequisites: `bun run build`.
 * Run: bun scripts/manual-qa/run-qa-finder-drag-out.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AI_PANEL, dragRowOut, finderWindow, launchFinder, openAiSearch, stubNativeDrag } from "./launch-finder.mjs";
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

const MOVED = join(top, "moved.txt");
const COPIED = join(top, "copied.txt");
const TABBED = join(top, "tabbed.txt");
const MULTI_1 = join(top, "multi-1.txt");
const MULTI_2 = join(top, "multi-2.txt");
const ATTACHED = join(top, "attached.txt");
const CANCELLED = join(top, "cancelled.txt");
const OUTSIDE_1 = join(top, "outside-1.txt");
const OUTSIDE_2 = join(top, "outside-2.txt");
for (const path of [MOVED, COPIED, TABBED, MULTI_1, MULTI_2, ATTACHED, CANCELLED, OUTSIDE_1, OUTSIDE_2]) {
	// Distinct bodies: near-identical siblings would stack as one version family.
	writeFileSync(path, `${path}\n${"#".repeat(path.length * 7)}\n${Math.random()}\n`.repeat(path.length % 5 + 1));
}
writeFileSync(join(out, "target-placeholder.txt"), "target\n");

const results = [];
const check = (name, pass, detail) => {
	results.push({ name, pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
};

const row = (page, path) => page.locator(`[data-path="${path}"]`).first();
const listNames = (dir) => readdirSync(dir).sort();
const atTitle = (page, name) =>
	page.waitForFunction((want) => document.querySelector(".toolbar-title")?.textContent === want, name, { timeout: 15_000 });
const dragCursor = (page) => page.evaluate(() => document.documentElement.dataset.rowDrag ?? null);

/** Wait until `predicate` holds or the deadline passes. */
async function until(page, predicate, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await page.waitForTimeout(150);
	}
	return predicate();
}

/**
 * Press a row and carry it onto `target` inside the window. `whileHeld` runs
 * with the drag hovering the target, before the release (or instead of it,
 * when it cancels the drag itself).
 */
async function dragRowTo(page, path, target, { alt = false, whileHeld, release = true } = {}) {
	const from = await row(page, path).boundingBox();
	const to = await target.boundingBox();
	if (from === null || to === null) throw new Error("drag source or target is not visible");
	await page.mouse.move(from.x + 24, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(from.x + 40, from.y + from.height / 2, { steps: 4 });
	if (alt) await page.keyboard.down("Alt");
	await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
	await page.waitForTimeout(200);
	if (whileHeld !== undefined) await whileHeld();
	if (release) await page.mouse.up();
	if (alt) await page.keyboard.up("Alt");
	await page.waitForTimeout(400);
}

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
	await row(page, MOVED).waitFor({ state: "visible", timeout: 15_000 });
	const startDrags = await stubNativeDrag(app);

	/* ----------------------------------- 1. inside the app: onto a folder row */
	let highlighted = false;
	let moveCursor = null;
	await dragRowTo(page, MOVED, row(page, dirA), {
		whileHeld: async () => {
			highlighted = await row(page, dirA).evaluate((node) => node.className.includes("accent-drop-hover"));
			moveCursor = await dragCursor(page);
			await page.screenshot({ path: join(EVIDENCE, "1-move-hover.png") });
		},
	});
	await until(page, () => existsSync(join(dirA, "moved.txt")));
	check(
		"a row dragged onto a folder row inside the app moves there, highlighted, with the move cursor",
		highlighted && moveCursor === "move" && existsSync(join(dirA, "moved.txt")) && !existsSync(MOVED),
		`highlight=${highlighted} cursor=${moveCursor} A=${listNames(dirA)}`,
	);

	/* --------------------------------------------- 2. ⌥ makes the drop a copy */
	let copyCursor = null;
	await dragRowTo(page, COPIED, row(page, dirA), {
		alt: true,
		whileHeld: async () => {
			copyCursor = await dragCursor(page);
		},
	});
	await until(page, () => existsSync(join(dirA, "copied.txt")));
	check(
		"⌥ held during the drag copies onto the folder row, with the copy cursor",
		copyCursor === "copy" && existsSync(join(dirA, "copied.txt")) && existsSync(COPIED),
		`cursor=${copyCursor} A=${listNames(dirA)} source=${existsSync(COPIED)}`,
	);

	/* --------------------------------------------- 3. onto another folder tab */
	await page.keyboard.press(chord("t"));
	await page.waitForFunction(() => document.querySelectorAll(".tab").length === 2);
	await row(page, dirB).dblclick();
	await atTitle(page, "B");
	await page.locator(".tab").first().click();
	await atTitle(page, "qa-native-drag-out");
	await dragRowTo(page, TABBED, page.locator(".tab").nth(1));
	await atTitle(page, "B");
	await until(page, () => existsSync(join(dirB, "tabbed.txt")));
	check(
		"a row dropped on another tab moves into that tab's folder",
		existsSync(join(dirB, "tabbed.txt")) && !existsSync(TABBED),
		`B=${listNames(dirB)}`,
	);
	await page.keyboard.press(chord("w"));
	await atTitle(page, "qa-native-drag-out");

	/* ----------------------------------------- 4. a multi-row selection moves */
	await row(page, MULTI_1).click();
	await row(page, MULTI_2).click({ modifiers: [isMac ? "Meta" : "Control"] });
	await dragRowTo(page, MULTI_2, row(page, dirA));
	await until(page, () => existsSync(join(dirA, "multi-1.txt")) && existsSync(join(dirA, "multi-2.txt")));
	check(
		"a selection dragged by one of its rows moves every selected row",
		existsSync(join(dirA, "multi-1.txt")) && existsSync(join(dirA, "multi-2.txt")) && !existsSync(MULTI_1) && !existsSync(MULTI_2),
		`A=${listNames(dirA)}`,
	);

	/* ------------------------------------- 5. onto AI Search: attach, not move */
	await page.keyboard.press(chord("t"));
	await openAiSearch(page);
	await page.locator(".tab").first().click();
	await row(page, ATTACHED).waitFor({ state: "visible", timeout: 15_000 });
	await dragRowTo(page, ATTACHED, page.locator('.tabs .tab[data-ai-search="true"]').first());
	await page.waitForTimeout(400);
	const attached = await page.$$eval(`${AI_PANEL} .composer-attach-pill`, (nodes) => nodes.map((node) => node.getAttribute("title")));
	check(
		"a row dropped on an AI Search tab attaches and stays in place",
		attached.includes(ATTACHED) && existsSync(ATTACHED),
		`pills=${JSON.stringify(attached)}`,
	);
	await page.screenshot({ path: join(EVIDENCE, "2-attach.png") });
	await page.locator(".tab").first().click();
	await row(page, CANCELLED).waitFor({ state: "visible", timeout: 15_000 });

	/* ----------------------------------------------- 6. Escape cancels a drag */
	await dragRowTo(page, CANCELLED, row(page, dirA), {
		release: false,
		whileHeld: async () => {
			await page.keyboard.press("Escape");
			await page.mouse.up();
		},
	});
	check(
		"Escape cancels a held drag: nothing moves and the drag cursor clears",
		existsSync(CANCELLED) && !existsSync(join(dirA, "cancelled.txt")) && (await dragCursor(page)) === null,
		`A=${listNames(dirA)}`,
	);

	/* ------------------------------------- 7. past the window edge: the OS drag */
	await row(page, OUTSIDE_1).click();
	await row(page, OUTSIDE_2).click({ modifiers: [isMac ? "Meta" : "Control"] });
	const before = (await startDrags()).length;
	await dragRowOut(page, OUTSIDE_2);
	await page.waitForTimeout(400);
	const sent = (await startDrags()).slice(before);
	check(
		"dragging past the window edge hands every selected path to the OS file drag, once",
		sent.length === 1 && sent[0].length === 2 && sent[0].includes(OUTSIDE_1) && sent[0].includes(OUTSIDE_2),
		JSON.stringify(sent),
	);
	check(
		"a drag that left the window moves nothing inside the app",
		existsSync(OUTSIDE_1) && existsSync(OUTSIDE_2) && (await dragCursor(page)) === null,
		`root=${listNames(top)}`,
	);

	/* --------------------------------------------------- 8. a click is a click */
	await row(page, COPIED).click();
	const selected = await row(page, COPIED).getAttribute("aria-selected");
	check("a plain click on a row still selects it", selected === "true", `aria-selected=${selected}`);

	/* ---------------- 9. opt-in: a real pointer drag reaches a Finder window */
	if (REAL_DRAG) {
		if (!isMac) {
			check("real drag-out is macOS-only", false, "skipped on this platform");
		} else {
			// The real OS drag must run now: replace the stub with a fresh app.
			await app.close();
			app = await launchFinder({
				userDataDir: mkdtempSync(join(tmpdir(), "ulw-native-drag-out-data-")),
				env: { HOME: home, AUTORAG_QA_ROOT: top },
			});
			const real = await finderWindow(app, 30_000);
			await atTitle(real, "qa-native-drag-out");
			const bounds = await app.evaluate(({ BrowserWindow }) =>
				BrowserWindow.getAllWindows()
					.filter((window) => window.webContents.getURL().endsWith("/index.html"))
					.map((window) => window.getContentBounds())[0],
			);
			// The Finder window sits to the right of the app, so the drag crosses the edge.
			const finderBounds = [bounds.x + bounds.width + 20, bounds.y, bounds.x + bounds.width + 520, bounds.y + 400];
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
			await real.bringToFront();
			await sleep(500);
			const box = await row(real, COPIED).boundingBox();
			const from = { x: bounds.x + box.x + 24, y: bounds.y + box.y + box.height / 2 };
			const to = { x: (finderBounds[0] + finderBounds[2]) / 2, y: (finderBounds[1] + finderBounds[3]) / 2 };
			execFileSync("swift", [join(ROOT, "scripts", "manual-qa", "os-drag.swift"), "drag", String(from.x), String(from.y), String(to.x), String(to.y)]);
			await until(real, () => existsSync(join(out, "copied.txt")), 15_000);
			check("a real pointer drag out of the app lands the file in a Finder window", existsSync(join(out, "copied.txt")), `target=${listNames(out)}`);
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
