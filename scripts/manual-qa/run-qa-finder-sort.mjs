import { fileURLToPath } from "node:url";
/**
 * Manual QA — the list column header sorts the rows on click and shows the
 * ascending/descending state.
 *
 * Drives the real production build (out/) with Playwright on a fixture folder
 * in a throwaway HOME (the operator's files stay untouched): the header band in
 * list view (⌘2) must expose a sort button on Name as well as Date Modified /
 * Size / Kind, and each click must cycle ascending → descending → cleared while
 * reordering the rows. Evidence goes to
 * .omo/evidence/ai-finder-app/qa-list-sort/.
 *
 * Run from the repo root after `bun run build`:
 * `bun scripts/manual-qa/run-qa-finder-sort.mjs`
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const EVIDENCE = `${ROOT}/.omo/evidence/ai-finder-app/qa-list-sort`;
mkdirSync(EVIDENCE, { recursive: true });

const stamp = Date.now();
const home = mkdtempSync(join(tmpdir(), "ulw-sort-home-"));
const documents = join(home, "Documents");
const folderName = `ulw-sort-${stamp}`;
const folderPath = join(documents, folderName);
// Distinct sizes and distinct repeated content so dupey does not fold the file
// fixtures into one version family (identical bodies would stack them). The
// extra folder proves folders are no longer pinned above the files.
const fixtures = [
	["alpha.txt", "a", 120],
	["charlie.txt", "c", 1500],
	["delta.txt", "d", 40],
];
mkdirSync(join(folderPath, "bravo-dir"), { recursive: true });
for (const [name, char, size] of fixtures) await Bun.write(join(folderPath, name), char.repeat(size));

const localeName = (a, b) => a.localeCompare(b, "ko");
const namesAsc = ["alpha.txt", "bravo-dir", "charlie.txt", "delta.txt"];
const namesDesc = [...namesAsc].reverse();
// Folders carry size 0, so Size ranks bravo-dir last descending / first ascending.
const sizeDesc = ["charlie.txt", "alpha.txt", "delta.txt", "bravo-dir"];
const sizeAsc = [...sizeDesc].reverse();

const results = [];
const check = (label, actual, expected) => {
	const pass = JSON.stringify(actual) === JSON.stringify(expected);
	results.push({ label, actual, expected, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}: app=${JSON.stringify(actual)}`);
};

const userDataDir = mkdtempSync(join(tmpdir(), "ulw-list-sort-"));
let app;
try {
	app = await launchFinder({ userDataDir, env: { HOME: home, USERPROFILE: home } });
	const page = await finderWindow(app);
	await page.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
	await page.waitForSelector(".toolbar-title", { timeout: 30000 });
	await page.getByRole("group", { name: "View" }).getByRole("button", { name: "List" }).click();
	await page.getByLabel("Places").getByRole("button", { name: "Documents", exact: true }).click();
	const folderRow = page.locator('[role="row"]').filter({ hasText: folderName }).first();
	await folderRow.waitFor({ timeout: 30000 });
	await folderRow.dblclick();
	await page.waitForFunction((name) => document.querySelector(".toolbar-title")?.textContent === name, folderName);
	await page.waitForSelector(".col-header");
	await page.waitForTimeout(300);

const rows = () =>
	page.locator('[role="row"]').evaluateAll((list) =>
		list
			.map((row) => (row.querySelector('[role="gridcell"] .row__label')?.textContent ?? "").trim())
			.filter(Boolean),
	);
	const sortedRows = async () => (await rows()).slice().sort(localeName);
	const baseline = await rows();
	check("S0 the fixture folder lists the three files and one folder", (await sortedRows()), namesAsc);

	// ----- header band exposes a sort button on every sortable column
	const header = page.locator(".col-header");
	const sortLabels = await header.locator(".col-header__sort").allInnerTexts();
	check("S1 Name is a sort button, not a static label", sortLabels.some((text) => text.trim().startsWith("Name")), true);
	check(
		"S1 every one of Name/Date Modified/Size/Kind is a sort button",
		["Name", "Date Modified", "Size", "Kind"].map((label) => sortLabels.some((text) => text.trim().startsWith(label))),
		[true, true, true, true],
	);

	const headerState = (label) =>
		header.evaluate((node, wanted) => {
			const button = [...node.querySelectorAll(".col-header__sort")].find((b) => b.textContent.trim().startsWith(wanted));
			if (button === undefined) return null;
			const chevron = button.querySelector(".col-header__chevron");
			return {
				tag: button.tagName,
				ariaSort: button.getAttribute("aria-sort"),
				chevron: chevron !== null,
				flipped: chevron !== null && chevron.classList.contains("rotate-180"),
			};
		}, label);

	check("S1 Name header starts unsorted", await headerState("Name"), {
		tag: "BUTTON",
		ariaSort: "none",
		chevron: false,
		flipped: false,
	});

	// ----- Name cycles ascending → descending → cleared and reorders the rows
	const nameButton = header.locator(".col-header__sort", { hasText: "Name" }).first();
	await nameButton.click();
	await page.waitForTimeout(200);
	check("S2 first Name click sorts ascending", await rows(), namesAsc);
	check("S2 the folder sorts between the files by name, not above them", (await rows()).indexOf("bravo-dir"), 1);
	check("S2 ascending state shows an up chevron and aria-sort=ascending", await headerState("Name"), {
		tag: "BUTTON",
		ariaSort: "ascending",
		chevron: true,
		flipped: false,
	});
	await header.screenshot({ path: `${EVIDENCE}/name-ascending.png` });

	await nameButton.click();
	await page.waitForTimeout(200);
	check("S3 second Name click sorts descending", await rows(), namesDesc);
	check("S3 descending state flips the chevron and sets aria-sort=descending", await headerState("Name"), {
		tag: "BUTTON",
		ariaSort: "descending",
		chevron: true,
		flipped: true,
	});
	await header.screenshot({ path: `${EVIDENCE}/name-descending.png` });

	await nameButton.click();
	await page.waitForTimeout(200);
	check("S4 third Name click clears sorting and restores the listing", await rows(), baseline);
	check("S4 cleared state drops the chevron", await headerState("Name"), {
		tag: "BUTTON",
		ariaSort: "none",
		chevron: false,
		flipped: false,
	});

	// ----- Size still works and cycles independently
	const sizeButton = header.locator(".col-header__sort", { hasText: "Size" }).first();
	await sizeButton.click();
	await page.waitForTimeout(200);
	check("S5 first Size click sorts descending (bytes)", await rows(), sizeDesc);
	check("S5 Size owns the active indicator, Name does not", [await headerState("Size"), await headerState("Name")], [
		{ tag: "BUTTON", ariaSort: "descending", chevron: true, flipped: true },
		{ tag: "BUTTON", ariaSort: "none", chevron: false, flipped: false },
	]);
	await sizeButton.click();
	await page.waitForTimeout(200);
	check("S6 second Size click sorts ascending (bytes)", await rows(), sizeAsc);
	await page.screenshot({ path: `${EVIDENCE}/list-sorted-size.png` });
} finally {
	await app.close();
}

await Bun.write(`${EVIDENCE}/result.json`, JSON.stringify({ checks: results }, null, 2));
const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
