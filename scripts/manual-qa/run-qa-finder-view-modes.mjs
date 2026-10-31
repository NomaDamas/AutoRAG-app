import { fileURLToPath } from "node:url";
/**
 * Manual QA — the Finder view toggle (icons / list / columns).
 *
 * Drives the real production app (out/) with Playwright on a fixture tree in
 * the Documents folder of a throwaway HOME (the operator's files stay untouched): toggles each mode from the toolbar and with ⌘1/⌘2/⌘3,
 * checks the icon grid (thumbnails, folder open), and walks the column view
 * three folders deep until the panes slide. Evidence goes to
 * .omo/evidence/ai-finder-app/qa-view-modes/.
 *
 * Run from the repo root after `bun run build`:
 * `bun scripts/manual-qa/run-qa-finder-view-modes.mjs`
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { deflateSync } from "node:zlib";
import { AI_PANEL, launchFinder, finderWindow } from "./launch-finder.mjs";
import { chord, cssAttr } from "./platform.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "");
const EVIDENCE = join(ROOT, ".omo", "evidence", "ai-finder-app", "qa-view-modes");
mkdirSync(EVIDENCE, { recursive: true });

const stamp = Date.now();
const home = mkdtempSync(join(tmpdir(), "ulw-view-home-"));
const documents = join(home, "Documents");
const top = `ulw-view-${stamp}`;
// Native-separator paths: the app's data-path attributes join with path.sep,
// so the lane's selectors must too (issue #51).
const topPath = join(documents, top);
const alphaPath = join(topPath, "alpha");
const betaPath = join(alphaPath, "beta");
const gammaPath = join(betaPath, "gamma");
// top/ alpha/ beta/ gamma/ delta.txt, plus files at every level
const tree = {
	[topPath]: ["alpha/", "red.png", "blue.png", "notes.md"],
	[alphaPath]: ["beta/", "alpha-1.md", "alpha-2.md"],
	[betaPath]: ["gamma/", "beta-1.md"],
	[gammaPath]: ["delta.txt"],
};

function crc32(buf) {
	let crc = 0xffffffff;
	for (const byte of buf) {
		crc ^= byte;
		for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}
function solidPng(size, [r, g, b]) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const raw = Buffer.alloc(size * (1 + size * 3));
	for (let y = 0; y < size; y++) {
		const off = y * (1 + size * 3);
		for (let x = 0; x < size; x++) raw.set([r, g, b], off + 1 + x * 3);
	}
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

for (const [dir, items] of Object.entries(tree)) {
	mkdirSync(dir, { recursive: true });
	for (const item of items) {
		if (item.endsWith("/")) continue;
		const file = join(dir, item);
		if (item === "red.png") await Bun.write(file, solidPng(256, [220, 40, 40]));
		else if (item === "blue.png") await Bun.write(file, solidPng(256, [40, 60, 220]));
		else await Bun.write(file, `fixture ${item}\n`);
	}
}

const results = [];
const check = (label, actual, expected) => {
	const pass = JSON.stringify(actual) === JSON.stringify(expected);
	results.push({ label, actual, expected, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}: ${JSON.stringify(actual)}`);
};

const userDataDir = mkdtempSync(join(tmpdir(), "ulw-view-modes-"));
let app;
try {
	app = await launchFinder({ userDataDir, env: { HOME: home, USERPROFILE: home } });
	const page = await finderWindow(app);
	await page.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
	const sidebarBox = await page.locator(".sidebar").boundingBox();
	const inspectorBox = await page.locator(".inspector").boundingBox();
	check("C1 sidebar defaults to minimum width", Math.round(sidebarBox.width), 180);
	check("C1 inspector defaults to minimum width", Math.round(inspectorBox.width), 300);
	const composer = page.locator(`${AI_PANEL} textarea[aria-label="Ask Dazzi"]`);
	const tabCount = () => page.locator(".tabs .tab").count();
	check("C1 there is no AI Search dock under the Finder", await page.locator(AI_PANEL).count(), 0);
	await page.keyboard.press(chord("k"));
	await page.waitForSelector(AI_PANEL);
	check("C1 Cmd+K opens an AI Search tab", await tabCount(), 2);
	await composer.fill("draft survives toggle");
	await page.locator(".tabs .tab").first().click();
	await page.waitForSelector(AI_PANEL, { state: "detached" });
	await page.keyboard.press(chord("k"));
	await page.waitForSelector(AI_PANEL);
	check("C1 Cmd+K adopts the existing AI Search tab", await tabCount(), 2);
	check("C1 Cmd+K preserves the composer draft", await composer.inputValue(), "draft survives toggle");
	check("C1 Cmd+K refocuses the composer", await composer.evaluate((input) => document.activeElement === input), true);
	await page.locator(".tabs .tab").first().click();
	await page.getByLabel("Places").getByRole("button", { name: "Documents", exact: true }).click();
	const topRow = page.locator('[role="row"]').filter({ hasText: top }).first();
	await topRow.waitFor({ timeout: 30000 });
	await topRow.dblclick();
	await page.waitForFunction((name) => document.querySelector(".toolbar-title")?.textContent === name, top);
	await page.locator('[role="row"]').filter({ hasText: "notes.md" }).waitFor();

	const toggle = page.getByRole("group", { name: "View" });
	const pressed = () =>
		toggle.locator("button").evaluateAll((buttons) => buttons.map((b) => `${b.getAttribute("aria-label")}=${b.getAttribute("aria-pressed")}`));
	const toolbarBox = await page.locator(".toolbar").boundingBox();
	const toggleBox = await toggle.boundingBox();
	check("C1 toggle lives in the toolbar's right half", toggleBox.x > toolbarBox.x + toolbarBox.width / 2, true);
	check("C1 list is the default mode", await pressed(), ["Icons=false", "List=true", "Columns=false"]);
	check("C1 toolbar navigation hit area is larger", await page.getByRole("button", { name: "Back" }).evaluate((button) => {
		const box = button.getBoundingClientRect();
		const glyph = button.querySelector("svg")?.getBoundingClientRect();
		return { button: [Math.round(box.width), Math.round(box.height)], glyph: glyph === undefined ? null : [Math.round(glyph.width), Math.round(glyph.height)] };
	}), { button: [32, 32], glyph: [18, 18] });
	check("C1 view mode controls are larger", await toggle.locator("button").first().evaluate((button) => {
		const box = button.getBoundingClientRect();
		const glyph = button.querySelector("svg")?.getBoundingClientRect();
		return { button: [Math.round(box.width), Math.round(box.height)], glyph: glyph === undefined ? null : [Math.round(glyph.width), Math.round(glyph.height)] };
	}), { button: [32, 32], glyph: [18, 18] });
	await page.locator(".toolbar").screenshot({ path: `${EVIDENCE}/toolbar-toggle.png` });

	// ----- C2 icons
	await toggle.getByRole("button", { name: "Icons" }).click();
	await page.waitForSelector(".icon-grid");
	check("C1 Icons button pressed after click", await pressed(), ["Icons=true", "List=false", "Columns=false"]);
	check("C2 icon view has no list rows or column header", await page.locator('[role="row"], .col-header').count(), 0);
	check("C2 one tile per entry", await page.locator(".icon-tile").count(), tree[topPath].length);
	await page.waitForSelector('.icon-tile[aria-label="red.png"] img.tile--image', { timeout: 20000 });
	const redTile = await page.locator('.icon-tile[aria-label="red.png"] img.tile--image').evaluate(async (image) => {
		if (!image.complete) await image.decode();
		const canvas = document.createElement("canvas");
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		const context = canvas.getContext("2d");
		context.drawImage(image, 0, 0);
		const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
		let r = 0, b = 0;
		for (let i = 0; i < data.length; i += 4) { r += data[i]; b += data[i + 2]; }
		const box = image.getBoundingClientRect();
		return { natural: image.naturalWidth, rendered: Math.round(box.width), redDominant: r > b * 2 };
	});
	check("C2 red.png tile shows its red thumbnail", redTile.redDominant, true);
	check("C2 tile renders at 64px", redTile.rendered, 64);
	check("C2 thumbnail is at least 2x the tile (>=128px)", redTile.natural >= 128, true);
	check("C2 folder tile renders the folder glyph", await page.locator('.icon-tile[aria-label="alpha"] svg').count(), 1);
	await page.locator('.icon-tile[aria-label="notes.md"]').click();
	check("C2 click selects a tile", await page.locator('.icon-tile[aria-label="notes.md"]').getAttribute("aria-selected"), "true");
	await page.keyboard.press("ArrowLeft");
	check("C2 ArrowLeft moves to the previous tile", await page.locator('.icon-tile[aria-selected="true"]').getAttribute("aria-label"), "blue.png");
	await page.screenshot({ path: `${EVIDENCE}/icons.png` });
	await page.locator('.icon-tile[aria-label="alpha"]').dblclick();
	await page.waitForFunction(() => document.querySelector(".toolbar-title")?.textContent === "alpha");
	await page.waitForSelector('.icon-tile[aria-label="alpha-1.md"]');
	check("C2 double-click on a folder tile opens it", await page.locator(".toolbar-title").textContent(), "alpha");
	check("C2 opened folder shows its tiles", await page.locator(".icon-tile").count(), tree[alphaPath].length);
	await page.getByRole("button", { name: "Back" }).click();
	await page.waitForFunction((name) => document.querySelector(".toolbar-title")?.textContent === name, top);

	// ----- C4 keyboard mode switching + list regression
	await page.locator(".finder").click({ position: { x: 5, y: 200 } }).catch(() => {});
	await page.keyboard.press(chord("2"));
	await page.waitForSelector('[role="row"]');
	check("C4 ⌘2 shows the list", await pressed(), ["Icons=false", "List=true", "Columns=false"]);
	check("C4 list keeps its column header", await page.locator(".col-header").count(), 1);
	check("C4 list shows one row per entry", await page.locator('[role="row"]').count(), tree[topPath].length);
	const listRows = page.locator('[role="row"]');
	const rowGeometry = await listRows.nth(0).evaluate((row) => {
		const style = getComputedStyle(row);
		return { height: Math.round(row.getBoundingClientRect().height), radius: style.borderRadius, margin: `${style.marginLeft}/${style.marginRight}` };
	});
	const stripeColors = await listRows.evaluateAll((rows) => rows.slice(0, 2).map((row) => getComputedStyle(row).backgroundColor));
	check("C4 compact Bloom row geometry", rowGeometry, { height: 24, radius: "0px", margin: "0px/0px" });
	check("C4 adjacent list rows use alternating washes", stripeColors[0] !== stripeColors[1], true);
	check("C4 alternate list row uses #F4F5F5", stripeColors[1], "rgb(244, 245, 245)");
	const rowTypography = await listRows.nth(1).evaluate((row) => ({
		name: getComputedStyle(row.querySelector(".row__label")).fontSize,
		meta: getComputedStyle(row.querySelector(".row__meta")).fontSize,
		nameColor: getComputedStyle(row.querySelector(".row__label")).color,
	}));
	check("C4 Finder row typography and default ink", rowTypography, { name: "12px", meta: "12px", nameColor: "rgb(29, 29, 31)" });
	await page.locator(".col-header__sort").first().click();
	check("C4 sort indicator is larger", await page.locator(".col-header__sort svg").first().evaluate((svg) => {
		const box = svg.getBoundingClientRect();
		return [Math.round(box.width), Math.round(box.height)];
	}), [12, 12]);
	// The row's data-path ends with the platform separator (CSS attribute
	// selectors need a lone backslash escaped on Windows).
	const selectedRow = page.locator(`[role="row"][data-path$="${cssAttr(`${sep}notes.md`)}"]`);
	await selectedRow.click();
	const selectedStyle = await selectedRow.evaluate((row) => {
		const style = getComputedStyle(row);
		return {
			ariaSelected: row.getAttribute("aria-selected"),
			className: row.className,
			background: style.backgroundColor,
			transitionProperty: style.transitionProperty,
		};
	});
	check("C4 focused selection applies immediately", [selectedStyle.ariaSelected, selectedStyle.className.includes("bg-accent"), selectedStyle.background, selectedStyle.transitionProperty], ["true", true, "rgb(10, 100, 216)", "box-shadow"]);
	await page.screenshot({ path: `${EVIDENCE}/list.png` });
	await page.keyboard.press(chord("1"));
	await page.waitForSelector(".icon-grid");
	check("C4 ⌘1 shows the icons", await pressed(), ["Icons=true", "List=false", "Columns=false"]);
	await page.keyboard.press(chord("3"));
	await page.waitForSelector(".column");
	check("C4 ⌘3 shows the columns", await pressed(), ["Icons=false", "List=false", "Columns=true"]);

	// ----- C3 columns
	const panes = () => page.locator(".column").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-path")));
	const paneNames = (index) =>
		page.locator(".column").nth(index).locator(".column-row").evaluateAll((rows) => rows.map((r) => r.getAttribute("aria-label")).sort());
	check("C3 columns start with the current folder only", await panes(), [topPath]);
	await page.locator(`.column[data-path="${cssAttr(topPath)}"] .column-row[aria-label="alpha"]`).click();
	await page.waitForFunction(() => document.querySelectorAll(".column").length === 2);
	check("C3 folder in pane 1 opens pane 2", await panes(), [topPath, alphaPath]);
	await page.waitForSelector(`.column[data-path="${cssAttr(alphaPath)}"] .column-row`);
	check("C3 pane 2 lists the folder's children", await paneNames(1), ["alpha-1.md", "alpha-2.md", "beta"]);
	await page.locator(`.column[data-path="${cssAttr(alphaPath)}"] .column-row[aria-label="beta"]`).click();
	await page.waitForFunction(() => document.querySelectorAll(".column").length === 3);
	await page.waitForSelector(`.column[data-path="${cssAttr(betaPath)}"] .column-row`);
	check("C3 subfolder in pane 2 opens pane 3", await panes(), [topPath, alphaPath, betaPath]);
	check("C3 pane 3 lists the sub-subfolder", await paneNames(2), ["beta-1.md", "gamma"]);
	// v7 marks the opened-but-not-selected folder row by muting it (`text-ink-muted`)
	// instead of the v6 `column-row--opened` modifier; the selected state stays on aria-selected.
	const openedRow = page.locator(`.column[data-path="${cssAttr(topPath)}"] .column-row[aria-label="alpha"]`);
	check(
		"C3 the opened folder stays marked in pane 1",
		[(await openedRow.getAttribute("class")).includes("text-ink-muted"), await openedRow.getAttribute("aria-selected")],
		[true, "false"],
	);
	await page.screenshot({ path: `${EVIDENCE}/columns-3.png` });
	await page.locator(`.column[data-path="${cssAttr(betaPath)}"] .column-row[aria-label="gamma"]`).click();
	await page.waitForFunction((p) => document.querySelector(".column")?.getAttribute("data-path") === p, alphaPath);
	await page.waitForSelector(`.column[data-path="${cssAttr(gammaPath)}"] .column-row`);
	check("C3 folder in pane 3 slides the panes (still 3, pane 1 = old pane 2)", await panes(), [alphaPath, betaPath, gammaPath]);
	check("C3 slid pane 3 lists gamma", await paneNames(2), ["delta.txt"]);
	check("C3 breadcrumb follows the first pane", await page.locator(".toolbar-title").textContent(), "alpha");
	await page.screenshot({ path: `${EVIDENCE}/columns-slid.png` });
	await page.locator(`.column[data-path="${cssAttr(gammaPath)}"] .column-row[aria-label="delta.txt"]`).click();
	await page.keyboard.press("ArrowLeft");
	check("C3 ArrowLeft moves back to the parent folder row", await page.locator('.column-row[aria-selected="true"]').getAttribute("aria-label"), "gamma");
	await page.keyboard.press("ArrowLeft");
	await page.keyboard.press("ArrowLeft");
	await page.waitForFunction((p) => document.querySelector(".column")?.getAttribute("data-path") === p, topPath);
	// Like Finder, stepping left closes the rightmost pane: the focused folder's contents stay open.
	check("C3 ArrowLeft past pane 1 slides the panes back", await panes(), [topPath, alphaPath]);
	check("C3 slid-back focus is the folder it slid from", await page.locator('.column-row[aria-selected="true"]').getAttribute("aria-label"), "alpha");
	await page.locator(`.column[data-path="${cssAttr(topPath)}"] .column-row[aria-label="notes.md"]`).click();
	check("C3 choosing a file closes the deeper panes", await panes(), [topPath]);

	// Column-view context menu rename in pane 2
	await page.locator(`.column[data-path="${cssAttr(topPath)}"] .column-row[aria-label="alpha"]`).click();
	await page.waitForSelector(`.column[data-path="${cssAttr(alphaPath)}"] .column-row[aria-label="alpha-1.md"]`);
	await page.locator(`.column[data-path="${cssAttr(alphaPath)}"] .column-row[aria-label="alpha-1.md"]`).click({ button: "right" });
	await page.getByRole("menuitem", { name: /Rename/ }).click();
	await page.keyboard.press(chord("a"));
	await page.keyboard.type("alpha-renamed.md");
	await page.keyboard.press("Enter");
	await page.waitForSelector(`.column[data-path="${cssAttr(alphaPath)}"] .column-row[aria-label="alpha-renamed.md"]`, { timeout: 10000 });
	check("C3 rename from pane 2 renames on disk", await Bun.file(join(alphaPath, "alpha-renamed.md")).exists(), true);

	// Pane widths remain user-resizable and persist across relaunch.
	const dragSeparator = async (label, delta) => {
		const separator = page.getByRole("separator", { name: label });
		const box = await separator.boundingBox();
		if (box === null) throw new Error(`${label} has no bounds`);
		const y = box.y + box.height / 2;
		const x = box.x + box.width / 2;
		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.mouse.move(x + delta, y);
		await page.mouse.up();
	};
	await dragSeparator("Resize sidebar", 24);
	await dragSeparator("Resize inspector", -24);
	const resized = await page.evaluate(() => ({
		sidebar: Math.round(document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0),
		inspector: Math.round(document.querySelector(".inspector")?.getBoundingClientRect().width ?? 0),
	}));
	check("C4 resized pane widths apply", resized, { sidebar: 204, inspector: 324 });

	// Persistence: the chosen mode and pane widths survive a relaunch.
	await app.close();
	app = await launchFinder({ userDataDir, env: { HOME: home, USERPROFILE: home } });
	const relaunched = await finderWindow(app);
	await relaunched.waitForSelector(".seg");
	await relaunched.waitForSelector(".column", { timeout: 30000 });
	const persistedSizes = await relaunched.evaluate(() => ({
		sidebar: Math.round(document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0),
		inspector: Math.round(document.querySelector(".inspector")?.getBoundingClientRect().width ?? 0),
	}));
	check("C4 pane widths survive a relaunch", persistedSizes, { sidebar: 204, inspector: 324 });
	check(
		"C4 the chosen mode survives a relaunch",
		await relaunched.getByRole("group", { name: "View" }).locator("button[aria-pressed=true]").getAttribute("aria-label"),
		"Columns",
	);
} finally {
	if (app !== undefined) await app.close();
	await rm(home, { recursive: true, force: true });
	await rm(userDataDir, { recursive: true, force: true });
}

await Bun.write(`${EVIDENCE}/result.json`, JSON.stringify({ checks: results }, null, 2));
const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
