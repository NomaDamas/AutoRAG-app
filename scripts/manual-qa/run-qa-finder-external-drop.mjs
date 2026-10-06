// Live QA for external (OS) file drops onto Finder drop targets — issue #84.
//
// Drives the built Finder app and proves, on disk through the real IPC, that a
// file or folder dragged in from another app:
//   1. copies into the folder row it is dropped on (default verb), with the
//      row highlighted while the drag hovers;
//   2. copies a whole folder tree;
//   3. takes Finder-style collision naming ("conflict copy.txt") when a sibling
//      already has the name;
//   4. moves into the folder when ⌥ is held;
//   5. copies into the tab's folder when dropped on another tab;
//   6. copies into the listing folder when dropped on the empty background;
//   7. is ignored when the drag carries only a web link;
//   8. still attaches (never transfers) when dropped on the AI Search panel;
//   9. joins ⌘Z: undo removes the copy the external drop created.
//
// Drops go through Chromium's native drop path (CDP Input.dispatchDragEvent
// with `files`), the same browser-side route an OS drag takes, so paths
// resolve through Electron's webUtils.getPathForFile — no real mouse needed.
//
// Prerequisites: `bun run build`.
// Run: bun scripts/manual-qa/run-qa-finder-external-drop.mjs
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AI_PANEL, finderWindow, launchFinder, openAiSearch } from "./launch-finder.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = join(ROOT, ".omo", "evidence", "ai-finder-app", "qa-external-drop");
mkdirSync(EVIDENCE, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "ulw-external-drop-home-"));
const top = join(home, "Documents", "qa-external-drop");
const dirA = join(top, "A");
const dirB = join(top, "B");
// The sources sit outside the browsed folder, as another app's drag would.
const out = join(home, "Downloads", "external-src");
const photoSet = join(out, "photo-set");
for (const directory of [top, dirA, dirB, out, photoSet]) mkdirSync(directory, { recursive: true });

const DROPPED = join(out, "dropped.txt");
const CONFLICT = join(out, "conflict.txt");
const ALT_MOVE = join(out, "alt-move.txt");
const BACKGROUND = join(out, "background.txt");
const TAB = join(out, "tab.txt");
const UNDO = join(out, "undo.txt");
writeFileSync(join(dirA, "conflict.txt"), "original A conflict\n");
for (const [path, body] of [
	[DROPPED, "dropped from another app\n"],
	[CONFLICT, "external conflict\n"],
	[ALT_MOVE, "alt move me\n"],
	[BACKGROUND, "background copy\n"],
	[TAB, "tab copy\n"],
	[UNDO, "undo this copy\n"],
	[join(photoSet, "inner.txt"), "nested photo\n"],
]) {
	writeFileSync(path, body);
}

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

/** Screen point at the center of a locator's box. */
async function centerOf(target) {
	const box = await target.boundingBox();
	if (box === null) throw new Error("drop target is not visible");
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** One native drag-and-drop (OS files, or a URI list) dropped at `point`. */
async function cdpDrop(page, cdp, data, point, { modifiers = 0, midCheck } = {}) {
	const payload = { items: [], files: [], dragOperationsMask: 1, ...data };
	for (const type of ["dragEnter", "dragOver"]) {
		await cdp.send("Input.dispatchDragEvent", { type, ...point, data: payload, modifiers });
		await page.waitForTimeout(150);
	}
	if (midCheck !== undefined) await midCheck();
	await cdp.send("Input.dispatchDragEvent", { type: "drop", ...point, data: payload, modifiers });
	await page.waitForTimeout(400);
}

const dropFiles = async (page, cdp, files, target, options) => {
	const point = await centerOf(target);
	await cdpDrop(page, cdp, { files }, point, options);
};

let app = null;
try {
	console.log(`fixture: ${top}`);
	app = await launchFinder({
		userDataDir: mkdtempSync(join(tmpdir(), "ulw-external-drop-data-")),
		env: { HOME: home, AUTORAG_QA_ROOT: top },
	});
	const page = await finderWindow(app, 30_000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
	await page.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
	await page.waitForSelector(".toolbar-title", { timeout: 30_000 });
	await atTitle(page, "qa-external-drop");
	const cdp = await page.context().newCDPSession(page);

	/* ---------------------------------- 1. external file onto a folder row */
	let highlighted = false;
	await dropFiles(page, cdp, [DROPPED], row(page, dirA), {
		midCheck: async () => {
			highlighted = await row(page, dirA).evaluate((node) => node.className.includes("accent-drop-hover"));
			await page.screenshot({ path: join(EVIDENCE, "1-hover.png") });
		},
	});
	await until(page, () => existsSync(join(dirA, "dropped.txt")));
	check(
		"an OS file dropped on a folder row is copied there, with a visible highlight",
		highlighted && existsSync(join(dirA, "dropped.txt")) && existsSync(DROPPED),
		`highlight=${highlighted} A=${listNames(dirA)}`,
	);
	await page.screenshot({ path: join(EVIDENCE, "2-copy.png") });

	/* ------------------------------------ 2. external folder onto a folder row */
	await dropFiles(page, cdp, [photoSet], row(page, dirB));
	await until(page, () => existsSync(join(dirB, "photo-set", "inner.txt")));
	check(
		"an OS folder dropped on a folder row copies its whole tree",
		existsSync(join(dirB, "photo-set", "inner.txt")) && existsSync(join(photoSet, "inner.txt")),
		`B=${listNames(dirB)}`,
	);

	/* ----------------------------------------- 3. Finder-style collision name */
	await dropFiles(page, cdp, [CONFLICT], row(page, dirA));
	await until(page, () => existsSync(join(dirA, "conflict copy.txt")));
	check(
		"a name collision takes Finder-style numbering, leaving the original intact",
		existsSync(join(dirA, "conflict copy.txt")) && existsSync(join(dirA, "conflict.txt")),
		`A=${listNames(dirA)}`,
	);

	/* ---------------------------------------- 4. ⌥-drop moves the external file */
	// Chromium aborts a synthesized drop while Alt is held, so this drag is the
	// same `file:` URI-list an OS drag carries, dispatched with altKey — an
	// external-origin path, so the default verb is copy and ⌥ must move.
	await row(page, dirA).evaluate(
		(node, url) =>
			new Promise((resolve) => {
				const data = new DataTransfer();
				data.setData("text/uri-list", url);
				node.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data, altKey: true }));
				window.setTimeout(() => {
					node.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data, altKey: true }));
					resolve();
				}, 250);
			}),
		`file://${ALT_MOVE}`,
	);
	await until(page, () => existsSync(join(dirA, "alt-move.txt")) || !existsSync(ALT_MOVE));
	check(
		"⌥-dropping an OS file moves it into the folder",
		existsSync(join(dirA, "alt-move.txt")) && !existsSync(ALT_MOVE),
		`A=${listNames(dirA)} source=${existsSync(ALT_MOVE)}`,
	);

	/* ------------------------------ 5. external file onto another tab's folder */
	await page.keyboard.press("Meta+t");
	await page.waitForFunction(() => document.querySelectorAll(".tab").length === 2);
	await row(page, dirB).dblclick();
	await atTitle(page, "B");
	await page.locator(".tab").first().click();
	await atTitle(page, "qa-external-drop");
	await dropFiles(page, cdp, [TAB], page.locator(".tab").nth(1));
	await atTitle(page, "B");
	await until(page, () => existsSync(join(dirB, "tab.txt")));
	check(
		"an OS file dropped on another tab copies into that tab's folder and switches to it",
		existsSync(join(dirB, "tab.txt")) && existsSync(TAB),
		`B=${listNames(dirB)}`,
	);
	await page.screenshot({ path: join(EVIDENCE, "3-tab.png") });
	await page.keyboard.press("Meta+w");
	await atTitle(page, "qa-external-drop");

	/* ----------------------------------- 6. external file onto the background */
	const listBox = await page.locator(".list").boundingBox();
	const lastRowBox = await page.locator('[role="row"]').last().boundingBox();
	if (listBox === null || lastRowBox === null || listBox.y + listBox.height - 24 <= lastRowBox.y + lastRowBox.height) {
		throw new Error("fixture has no empty listing background below its rows");
	}
	const backgroundPoint = { x: listBox.x + listBox.width / 2, y: lastRowBox.y + lastRowBox.height + 12 };
	let backgroundHighlighted = false;
	await cdpDrop(page, cdp, { files: [BACKGROUND] }, backgroundPoint, {
		midCheck: async () => {
			backgroundHighlighted = await page.locator(".list").evaluate((node) => node.className.includes("bg-accent-drop-hover"));
			await page.screenshot({ path: join(EVIDENCE, "6-background-hover.png") });
		},
	});
	await until(page, () => existsSync(join(top, "background.txt")));
	check(
		"an OS file dropped on the listing background copies into the folder in view",
		backgroundHighlighted && existsSync(join(top, "background.txt")) && existsSync(BACKGROUND),
		`highlight=${backgroundHighlighted} root=${listNames(top)}`,
	);

	/* ------------------------------------------ 7. a web link is not a transfer */
	const beforeLink = listNames(dirA);
	await cdpDrop(
		page,
		cdp,
		{ items: [{ mimeType: "text/uri-list", data: "https://example.com/" }] },
		await centerOf(row(page, dirA)),
	);
	await page.waitForTimeout(600);
	check(
		"a web-link drop on a folder row transfers nothing",
		JSON.stringify(listNames(dirA)) === JSON.stringify(beforeLink),
		`A=${listNames(dirA)} (was ${beforeLink})`,
	);

	/* ------------------------------------------- 8. ⌘Z undoes the external copy */
	await dropFiles(page, cdp, [UNDO], row(page, dirA));
	await until(page, () => existsSync(join(dirA, "undo.txt")));
	await page.keyboard.press("Meta+z");
	await until(page, () => !existsSync(join(dirA, "undo.txt")));
	check(
		"⌘Z removes the copy an external drop created",
		!existsSync(join(dirA, "undo.txt")) && existsSync(UNDO),
		`A=${listNames(dirA)}`,
	);
	await page.screenshot({ path: join(EVIDENCE, "4-undo.png") });

	/* -------------------------------------- 9. AI Search still attaches, not moves */
	await page.keyboard.press("Meta+t");
	await openAiSearch(page);
	await dropFiles(page, cdp, [DROPPED], page.locator(AI_PANEL));
	await page
		.waitForFunction(
			(want) => [...document.querySelectorAll(".composer-attach-pill")].some((element) => element.getAttribute("title") === want),
			DROPPED,
			{ timeout: 10_000 },
		)
		.catch(() => undefined);
	const pills = await page.$$eval(".composer-attach-pill", (elements) => elements.map((element) => element.getAttribute("title")));
	check(
		"an OS file dropped on AI Search attaches instead of transferring",
		pills.includes(DROPPED) && existsSync(DROPPED),
		`pills=${JSON.stringify(pills)}`,
	);
	await page.screenshot({ path: join(EVIDENCE, "5-ai-attach.png") });
} catch (error) {
	check("run completed", false, String(error).slice(0, 500));
	if (app !== null) {
		const page = await finderWindow(app).catch(() => null);
		await page?.screenshot({ path: join(EVIDENCE, "failure.png") }).catch(() => undefined);
	}
} finally {
	if (app !== null) await app.close().catch(() => undefined);
}

writeFileSync(join(EVIDENCE, "result.json"), JSON.stringify({ checks: results }, null, 2));
const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
