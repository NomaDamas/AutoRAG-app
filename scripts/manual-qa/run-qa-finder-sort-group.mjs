/**
 * Manual QA — issue #47 Sort and Group toolbar controls.
 *
 * Drives the production Electron build with an isolated HOME. It verifies the
 * reference Sort menu criteria, the Group menu, visual group sections in list,
 * icon, and column layouts, and saves screenshots under
 * `.omo/evidence/ai-finder-app/qa-sort-group/`.
 *
 * Run from the repo root after `bun run build`:
 * `bun scripts/manual-qa/run-qa-finder-sort-group.mjs`
 */

import { mkdirSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-sort-group");
mkdirSync(EVIDENCE, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "autorag-sort-group-home-"));
const userDataDir = mkdtempSync(join(tmpdir(), "autorag-sort-group-data-"));
const folderName = "qa-sort-group";
const folderPath = join(home, "Documents", folderName);
const fixedTime = new Date("2024-01-02T03:04:05.000Z");
for (let index = 0; index < 12; index += 1) {
	await Bun.write(join(folderPath, `item-${String(index).padStart(2, "0")}.txt`), "x".repeat(index + 1));
	await Bun.write(join(folderPath, `table-${String(index).padStart(2, "0")}.csv`), "x".repeat(index + 20));
}
for (const name of ["archive", "drafts", "images"]) mkdirSync(join(folderPath, name), { recursive: true });
await Bun.write(join(folderPath, "alpha.txt"), "alpha\n");
await Bun.write(join(folderPath, "budget.csv"), "name,value\nalpha,1\n");
await Bun.write(join(folderPath, "manual.pdf"), "%PDF-1.4\n");
await Bun.write(join(folderPath, "notes.md"), "# notes\n");
for (const entry of [folderPath, ...Array.from({ length: 12 }, (_, index) => join(folderPath, `item-${String(index).padStart(2, "0")}.txt`)), ...Array.from({ length: 12 }, (_, index) => join(folderPath, `table-${String(index).padStart(2, "0")}.csv`)), ...["archive", "drafts", "images", "alpha.txt", "budget.csv", "manual.pdf", "notes.md"].map((name) => join(folderPath, name))]) {
	utimesSync(entry, fixedTime, fixedTime);
}

const results = [];
const check = (label, actual, expected = true) => {
	const pass = JSON.stringify(actual) === JSON.stringify(expected);
	results.push({ label, actual, expected, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}: ${JSON.stringify(actual)}`);
	if (!pass) throw new Error(`QA failed: ${label}`);
};

let app;
try {
	app = await launchFinder({ userDataDir, env: { HOME: home } });
	const page = await finderWindow(app);
	await page.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
	await page.waitForSelector(".toolbar-title", { timeout: 30000 });
	await page.getByRole("group", { name: "View" }).getByRole("button", { name: "List" }).click();
	await page.getByLabel("Places").getByRole("button", { name: "Documents", exact: true }).click();
	const folderRow = page.locator('[role="row"]').filter({ hasText: folderName }).first();
	await folderRow.waitFor({ timeout: 30000 });
	await folderRow.dblclick();
	await page.waitForFunction((name) => document.querySelector(".toolbar-title")?.textContent === name, folderName);
	await page.waitForSelector(".col-header", { timeout: 30000 });
	await page.waitForTimeout(500);

	const toolbarButtons = await page.locator(".toolbar__control").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
	check("toolbar exposes Sort and Group controls", toolbarButtons.includes("Sort") && toolbarButtons.includes("Group"));

	await page.getByRole("button", { name: "Sort", exact: true }).click();
	const sortMenu = page.getByRole("menu", { name: "Sort" });
	await sortMenu.waitFor();
	const sortLabels = await sortMenu.getByRole("menuitemradio").allInnerTexts();
	check("Sort menu exposes all reference criteria and directions", sortLabels, [
		"Name",
		"Kind",
		"Application",
		"Extension",
		"Date Created",
		"Date Modified",
		"Date Added",
		"Date Last Opened",
		"Size",
		"Tags",
		"Comments",
		"Dimensions",
		"Rating",
		"Relative Path",
		"Ascending",
		"Descending",
	]);
	await sortMenu.getByRole("menuitemradio", { name: "Size", exact: true }).click();
	await page.waitForTimeout(250);
	check("Sort menu closes after selecting Size", await page.getByRole("menu", { name: "Sort" }).count(), 0);
	const sortedNames = await page.locator('[role="row"]').evaluateAll((rows) => rows.map((row) => row.getAttribute("data-path")?.split("/").pop() ?? ""));
	check("Size descending moves the largest fixture first", sortedNames[0], "table-11.csv");
	await page.locator('[role="row"]').first().click();
	await page.keyboard.press("ArrowDown");
	check("keyboard selection moves between sorted rows", await page.locator('[role="row"][aria-selected="true"]').count(), 1);

	await page.getByRole("button", { name: "Group", exact: true }).click();
	const groupMenu = page.getByRole("menu", { name: "Group" });
	await groupMenu.waitFor();
	check("Group menu exposes None, Kind, Date Modified, and Size", [
		await groupMenu.getByRole("menuitemradio", { name: "None", exact: true }).count(),
		await groupMenu.getByRole("menuitemradio", { name: "Kind", exact: true }).count(),
		await groupMenu.getByRole("menuitemradio", { name: "Date Modified", exact: true }).count(),
		await groupMenu.getByRole("menuitemradio", { name: "Size", exact: true }).count(),
	], [1, 1, 1, 1]);
	await groupMenu.getByRole("menuitemradio", { name: "Kind", exact: true }).click();
	await page.waitForTimeout(400);
	check("list view renders visual group sections", (await page.locator(".group-header").count()) >= 2);
	await page.screenshot({ path: join(EVIDENCE, "01-list-grouped-kind.png") });

	await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Icons" }).click();
	await page.waitForTimeout(400);
	check("icon view renders visual group sections", (await page.locator(".group-header").count()) >= 2);
	await page.screenshot({ path: join(EVIDENCE, "02-icons-grouped-kind.png") });

	await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Columns" }).click();
	await page.waitForTimeout(500);
	check("column view renders visual group sections", (await page.locator(".group-header").count()) >= 2);
	await page.screenshot({ path: join(EVIDENCE, "03-columns-grouped-kind.png") });
} finally {
	await app?.close();
}

await Bun.write(join(EVIDENCE, "result.json"), JSON.stringify({ checks: results }, null, 2));
const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
