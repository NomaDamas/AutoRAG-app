/**
 * Manual QA — a tab keeps its own sort and grouping while panes split, merge, and reorder.
 *
 * Drives the built app with real pointer drags and proves, on the live window:
 *   1. a tab sorted by Size and grouped by Extension keeps both when it is dragged off
 *      into a new pane (split), while the tab left behind stays unsorted and ungrouped;
 *   2. the toolbar Sort and Group menus follow the focused pane's active tab;
 *   3. dragging it back onto the other pane's strip (merge) and reordering it
 *      inside the strip keep its sort and grouping, and its sibling tab stays plain;
 *   4. switching between the two tabs shows each tab's own order and sections.
 * Run `bun run build` first. Evidence lands in the ignored `.omo/` tree.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { chord } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/qa-tab-view-state");
mkdirSync(EVIDENCE, { recursive: true });

const failures = [];
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` :: ${detail}`}`);
	if (!ok) failures.push(label);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WORK = realpathSync(mkdtempSync(join(tmpdir(), "autorag-qa-tab-view-")));
const HOME = join(WORK, "home");
const USER_DATA = join(WORK, "user-data");
const FOLDER = "qa-tab-view";
const FOLDER_PATH = join(HOME, "Documents", FOLDER);
mkdirSync(FOLDER_PATH, { recursive: true });
// Every file has its own bytes — identical files would fold into a duplicate stack and hide rows.
// The three orders below all differ, so each one proves exactly which state a pane shows:
//   plain (name):                 a-small.md  b-mid.txt  c-big.csv  d-large.md
//   size descending:              c-big.csv   d-large.md b-mid.txt  a-small.md
//   size descending + Extension:  CSV: c-big.csv · MD: d-large.md, a-small.md · TXT: b-mid.txt
//   Extension only:               CSV: c-big.csv · MD: a-small.md, d-large.md · TXT: b-mid.txt
const FIXTURES = [
	["a-small.md", 5],
	["b-mid.txt", 500],
	["c-big.csv", 5000],
	["d-large.md", 2000],
];
const NAME_ORDER = FIXTURES.map(([name]) => name);
const SIZE_GROUPED_ORDER = ["c-big.csv", "d-large.md", "a-small.md", "b-mid.txt"];
const fixedTime = new Date("2024-01-02T03:04:05.000Z");
for (const [name, size] of FIXTURES) {
	const file = join(FOLDER_PATH, name);
	writeFileSync(file, randomBytes(size / 2 + 0.5).toString("hex").slice(0, size));
	utimesSync(file, fixedTime, fixedTime);
}

/* ---------------------------------------------------------------- helpers */

const panes = (page) =>
	page.$$eval("[data-workspace-pane]", (elements) =>
		elements.map((element) => {
			const box = element.getBoundingClientRect();
			const section = element.querySelector("section.finder");
			return {
				id: Number(element.dataset.workspacePane),
				x: Math.round(box.x),
				width: Math.round(box.width),
				focused: section?.dataset.focused === "true",
				tabs: [...element.querySelectorAll(".tabs .tab")].map((tab) => ({ active: tab.classList.contains("tab--active") })),
			};
		}),
	);
const paneEl = (page, id) => page.locator(`[data-workspace-pane="${id}"]`);
const tabIn = (page, paneId, index) => paneEl(page, paneId).locator(".tabs .tab").nth(index);
/** The fixture rows a pane shows, top to bottom. */
const rowNames = (page, paneId) =>
	paneEl(page, paneId)
		.locator('[role="row"]')
		.evaluateAll((rows, names) => rows.map((row) => row.getAttribute("data-path")?.split(/[\\/]/u).pop() ?? "").filter((name) => names.includes(name)), NAME_ORDER);
const groupHeaders = (page, paneId) => paneEl(page, paneId).locator(".group-header").count();
const settle = async (page) => {
	await page.evaluate(
		() =>
			new Promise((resolve) => {
				let last = "";
				let still = 0;
				const tick = () => {
					const now = [...document.querySelectorAll("[data-workspace-pane]")].map((element) => element.getAttribute("style")).join("|");
					still = now === last ? still + 1 : 0;
					last = now;
					if (still >= 3) resolve(undefined);
					else requestAnimationFrame(tick);
				};
				requestAnimationFrame(tick);
			}),
	);
	await sleep(350);
};
/** Drag a tab like a user: press, pull it off the strip, glide to the drop point, release. */
async function dragTab(page, tab, [x, y]) {
	const box = await tab.boundingBox();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 30, { steps: 5 });
	await page.mouse.move(x, y, { steps: 10 });
	await sleep(260);
	await page.mouse.up();
	await settle(page);
}
const bodyPoint = async (page, paneId, fx, fy) => {
	const box = await paneEl(page, paneId).boundingBox();
	const top = box.y + 25;
	return [box.x + box.width * fx, top + (box.height - 25) * fy];
};
/** The checked row of the toolbar Sort / Group menu; the menu closes again. */
async function checkedInMenu(page, name) {
	await page.getByRole("button", { name, exact: true }).click();
	const menu = page.getByRole("menu", { name });
	await menu.waitFor();
	const checked = await menu.getByRole("menuitemradio").evaluateAll((items) =>
		items.filter((item) => item.getAttribute("aria-checked") === "true").map((item) => item.textContent?.trim() ?? ""),
	);
	await page.keyboard.press("Escape");
	await menu.waitFor({ state: "detached" });
	return checked;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* -------------------------------------------------------------------- run */

let app;
try {
	app = await launchFinder({ userDataDir: USER_DATA, env: { HOME } });
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(10_000);
	const pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(String(error)));
	await page.setViewportSize({ width: 1500, height: 900 }).catch(() => undefined);
	await page.waitForSelector(".tabs .tab", { timeout: 30_000 });
	await page.getByRole("group", { name: "View" }).getByRole("button", { name: "List" }).click();
	await page.getByLabel("Places").getByRole("button", { name: "Documents", exact: true }).click();
	const folderRow = page.locator('[role="row"]').filter({ hasText: FOLDER }).first();
	await folderRow.waitFor({ timeout: 30_000 });
	await folderRow.dblclick();
	await page.waitForFunction((name) => document.querySelector(".toolbar-title")?.textContent === name, FOLDER);
	await page.waitForSelector(".col-header", { timeout: 30_000 });
	await sleep(500);

	await page.screenshot({ path: join(EVIDENCE, "00-start.png") });
	console.log("rows:", JSON.stringify(await page.locator('[role="row"]').evaluateAll((rows) => rows.map((row) => row.getAttribute("data-path")))));
	let state = await panes(page);
	const first = state[0];
	check("starts as one pane listing the folder in name order", state.length === 1 && same(await rowNames(page, first.id), NAME_ORDER), JSON.stringify(await rowNames(page, first.id)));

	// Tab A: sorted by Size (descending) and grouped by Extension.
	await page.getByRole("button", { name: "Sort", exact: true }).click();
	await page.getByRole("menu", { name: "Sort" }).getByRole("menuitemradio", { name: "Size", exact: true }).click();
	await page.getByRole("button", { name: "Group", exact: true }).click();
	await page.getByRole("menu", { name: "Group" }).getByRole("menuitemradio", { name: "Extension", exact: true }).click();
	await sleep(500);
	check("tab A is sorted by size", same(await rowNames(page, first.id), SIZE_GROUPED_ORDER), JSON.stringify(await rowNames(page, first.id)));
	check("tab A shows one section per extension", (await groupHeaders(page, first.id)) === 3, String(await groupHeaders(page, first.id)));
	await page.screenshot({ path: join(EVIDENCE, "01-tab-a-sorted-grouped.png") });

	// Tab B: opens beside it on the same folder and is plain — a tab's choices are its own.
	await page.keyboard.press(chord("t"));
	await page.waitForFunction(() => document.querySelectorAll(".tabs .tab").length === 2);
	await page.waitForFunction(() => document.querySelectorAll('[role="row"]').length > 0);
	await sleep(500);
	check("a new tab B starts unsorted", same(await rowNames(page, first.id), NAME_ORDER), JSON.stringify(await rowNames(page, first.id)));
	check("a new tab B starts ungrouped", (await groupHeaders(page, first.id)) === 0, String(await groupHeaders(page, first.id)));
	check("the Sort menu of tab B has no sort checked", same(await checkedInMenu(page, "Sort"), []), JSON.stringify(await checkedInMenu(page, "Sort")));
	await page.screenshot({ path: join(EVIDENCE, "02-tab-b-plain.png") });

	// Back to tab A through the strip: its choices are still there after switching tabs.
	await tabIn(page, first.id, 0).click();
	await sleep(500);
	check("switching back to tab A keeps its size order", same(await rowNames(page, first.id), SIZE_GROUPED_ORDER), JSON.stringify(await rowNames(page, first.id)));
	check("switching back to tab A keeps its sections", (await groupHeaders(page, first.id)) === 3);

	// 1. Split tab A off to the right: it keeps sort and grouping; tab B stays plain.
	await dragTab(page, tabIn(page, first.id, 0), await bodyPoint(page, first.id, 0.95, 0.5));
	state = await panes(page);
	const [leftPane, rightPane] = [...state].sort((a, b) => a.x - b.x);
	check("the drop splits into two panes, the new one focused", state.length === 2 && rightPane.focused && rightPane.tabs.length === 1 && leftPane.tabs.length === 1);
	await sleep(500);
	check("the split-off tab A keeps its size order", same(await rowNames(page, rightPane.id), SIZE_GROUPED_ORDER), JSON.stringify(await rowNames(page, rightPane.id)));
	check("the split-off tab A keeps its sections", (await groupHeaders(page, rightPane.id)) === 3, String(await groupHeaders(page, rightPane.id)));
	check("tab B left behind is still in name order", same(await rowNames(page, leftPane.id), NAME_ORDER), JSON.stringify(await rowNames(page, leftPane.id)));
	check("tab B left behind is still ungrouped", (await groupHeaders(page, leftPane.id)) === 0);
	await page.screenshot({ path: join(EVIDENCE, "03-split-a-right.png") });

	// 2. The toolbar menus follow the focused pane.
	check("with the right pane focused, Sort shows Size and Descending", same(await checkedInMenu(page, "Sort"), ["Size", "Descending"]), JSON.stringify(await checkedInMenu(page, "Sort")));
	check("with the right pane focused, Group shows Extension", same(await checkedInMenu(page, "Group"), ["Extension"]), JSON.stringify(await checkedInMenu(page, "Group")));
	// Click the tab, not the path bar: a breadcrumb click would navigate.
	await tabIn(page, leftPane.id, 0).click();
	await sleep(300);
	check("with the left pane focused, Sort shows nothing", same(await checkedInMenu(page, "Sort"), []), JSON.stringify(await checkedInMenu(page, "Sort")));
	check("with the left pane focused, Group shows None", same(await checkedInMenu(page, "Group"), ["None"]), JSON.stringify(await checkedInMenu(page, "Group")));

	// 3a. Merge tab A back onto the left pane's strip, ahead of tab B.
	const stripBox = await tabIn(page, leftPane.id, 0).boundingBox();
	await dragTab(page, tabIn(page, rightPane.id, 0), [stripBox.x + 8, stripBox.y + stripBox.height / 2]);
	state = await panes(page);
	check("merging closes the emptied pane and holds both tabs", state.length === 1 && state[0].tabs.length === 2, JSON.stringify(state.map((pane) => pane.tabs.length)));
	const merged = state[0];
	await sleep(500);
	check("the merged tab A (first, active) keeps its size order", same(await rowNames(page, merged.id), SIZE_GROUPED_ORDER), JSON.stringify(await rowNames(page, merged.id)));
	check("the merged tab A keeps its sections", (await groupHeaders(page, merged.id)) === 3);
	await page.screenshot({ path: join(EVIDENCE, "04-merged.png") });

	// 3b. Reorder inside the strip: tab A moves behind tab B.
	const lastTab = await tabIn(page, merged.id, 1).boundingBox();
	await dragTab(page, tabIn(page, merged.id, 0), [lastTab.x + lastTab.width - 8, lastTab.y + lastTab.height / 2]);
	await sleep(500);
	check("after reordering, tab A (now last, active) keeps its size order", same(await rowNames(page, merged.id), SIZE_GROUPED_ORDER), JSON.stringify(await rowNames(page, merged.id)));
	check("after reordering, tab A keeps its sections", (await groupHeaders(page, merged.id)) === 3);

	// 4. Switch to tab B: still plain.
	await tabIn(page, merged.id, 0).click();
	await sleep(500);
	check("tab B, selected again, is still in name order", same(await rowNames(page, merged.id), NAME_ORDER), JSON.stringify(await rowNames(page, merged.id)));
	check("tab B, selected again, is still ungrouped", (await groupHeaders(page, merged.id)) === 0);
	await page.screenshot({ path: join(EVIDENCE, "05-tab-b-after-moves.png") });

	check("no renderer errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
	await app?.close();
}

console.log(failures.length === 0 ? "\nall checks passed" : `\n${failures.length} FAILED: ${failures.join("; ")}`);
if (failures.length > 0) process.exitCode = 1;
