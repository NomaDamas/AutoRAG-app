/**
 * Manual QA — Inspector Info panel metadata (real Electron).
 *
 * Builds a fixture folder with an EXIF JPEG and a text file, then checks on the
 * running app that selecting a file loads its rich metadata (path, created and
 * modified times, ownership, EXIF camera tags), that the Show more / Show less
 * toggle reveals and hides the long tail, that a non-image file shows no photo
 * section, and that a tall panel scrolls. Screenshots land in EVIDENCE.
 *
 * `bun run build` first, then
 * `bun scripts/manual-qa/run-qa-finder-info-metadata.mjs`
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExifJpeg } from "../../test/support/exif-fixture.ts";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";

const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-info-metadata");
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

const home = join(tmpdir(), "ulw-info-qa-home");
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });

const fixtureName = "ulw-info-qa";
const folder = join(home, "Documents", fixtureName);
mkdirSync(folder, { recursive: true });
const photo = join(folder, "photo.jpg");
await Bun.write(photo, buildExifJpeg());
await Bun.write(join(folder, "notes.txt"), "info panel qa\n");
mkdirSync(join(folder, "subfolder"), { recursive: true });
// A stable mtime so the "Date Modified" assertion does not depend on run time.
const FIXTURE_MTIME = new Date("2026-01-02T09:05:00Z");
for (const name of ["photo.jpg", "notes.txt"]) utimesSync(join(folder, name), FIXTURE_MTIME, FIXTURE_MTIME);

const userDataDir = mkdtempSync(join(tmpdir(), "ulw-info-data-"));

const results = [];
const check = (label, pass, detail = "") => {
	results.push({ label, pass, detail });
	if (!pass) console.log(`FAIL  ${label} ${detail}`);
};

/** Read the Info panel's sections and rows straight from the live DOM. */
const probe = (page) =>
	page.evaluate(() => {
		const body = document.querySelector(".inspector-body");
		if (body === null) return null;
		const sections = [...body.querySelectorAll(".info-section")].map((section) => ({
			title: section.querySelector(".section-title span")?.textContent ?? "",
			toggle: section.querySelector("button")?.textContent ?? null,
			rows: [...section.querySelectorAll("dl > div")].map((row) => ({
				label: row.querySelector("dt")?.textContent ?? "",
				value: row.querySelector("dd")?.textContent ?? "",
			})),
		}));
		return {
			sections,
			scrollHeight: body.scrollHeight,
			clientHeight: body.clientHeight,
			scrollTop: body.scrollTop,
			text: body.innerText,
		};
	});

const sectionRows = (state, title) => state.sections.find((section) => section.title === title)?.rows ?? [];
const valueOf = (rows, label) => rows.find((row) => row.label === label)?.value;
const hasLabel = (state, label) => state.sections.some((section) => section.rows.some((row) => row.label === label));

let app;
try {
	app = await launchFinder({ userDataDir, env: { HOME: home, USERPROFILE: home } });
	const page = await finderWindow(app, 30000);
	await page.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
	await page.waitForSelector(".toolbar-title", { timeout: 30000 });
	await page.waitForSelector(".sidebar__item", { timeout: 30000 });

	await page.getByLabel("Places").getByRole("button", { name: "Documents", exact: true }).click();
	const row = page.locator('[role="row"]').filter({ hasText: fixtureName }).first();
	await row.waitFor({ timeout: 30000 });
	await row.dblclick();
	await page.waitForFunction((name) => document.querySelector(".toolbar-title")?.textContent === name, fixtureName);
	await page.locator('[role="row"]').filter({ hasText: "photo.jpg" }).waitFor();
	await page.mouse.move(2, 2);

	// ---------------------------------------------------------- photo.jpg
	await page.locator('[role="row"]').filter({ hasText: "photo.jpg" }).first().click();
	await page.waitForFunction(() =>
		document.querySelector(".inspector-body")?.innerText.includes("Date Created"),
	);
	await page.waitForFunction(() =>
		document.querySelector(".inspector-body")?.innerText.includes("Camera Model"),
	);
	await new Promise((resolve) => setTimeout(resolve, 300));
	await page.screenshot({ path: join(EVIDENCE, "01-photo-expanded.png") });

	const expanded = await probe(page);
	const general = sectionRows(expanded, "General Info");
	const photo_ = sectionRows(expanded, "Image Info");

	check("General Info section is present", expanded.sections.some((section) => section.title === "General Info"));
	check("Path row shows the absolute path", valueOf(general, "Path") === photo, String(valueOf(general, "Path")));
	check("Where row shows the parent folder", valueOf(general, "Where") === folder, String(valueOf(general, "Where")));
	check("Date Created row is present", /^\d{4}-\d{2}-\d{2} /.test(String(valueOf(general, "Date Created"))), String(valueOf(general, "Date Created")));
	check("Date Modified row is present", /^\d{4}-\d{2}-\d{2} /.test(String(valueOf(general, "Date Modified"))), String(valueOf(general, "Date Modified")));
	check("Date Accessed row is present when expanded", hasLabel(expanded, "Date Accessed"));
	check("Date Changed row is present when expanded", hasLabel(expanded, "Date Changed"));
	check("Permissions row is present", /^[-dl][rwxsSt-]{9}$/.test(String(valueOf(general, "Permissions"))), String(valueOf(general, "Permissions")));
	check("Owner row is present", (valueOf(general, "Owner") ?? "") !== "", String(valueOf(general, "Owner")));
	check("Inode row is present", /^\d+$/.test(String(valueOf(general, "Inode"))), String(valueOf(general, "Inode")));

	check("Image Info section is present for an EXIF image", photo_.length > 0);
	check("Camera Make comes from EXIF", valueOf(photo_, "Camera Make") === "TestMake", String(valueOf(photo_, "Camera Make")));
	check("Camera Model comes from EXIF", valueOf(photo_, "Camera Model") === "TestModel", String(valueOf(photo_, "Camera Model")));
	check("Lens comes from EXIF", valueOf(photo_, "Lens") === "TestLens 24-70", String(valueOf(photo_, "Lens")));
	check("ISO comes from EXIF", valueOf(photo_, "ISO") === "400", String(valueOf(photo_, "ISO")));
	check("Aperture is formatted as f-number", valueOf(photo_, "Aperture") === "f/2.8", String(valueOf(photo_, "Aperture")));
	check("Shutter Speed is formatted as a reciprocal", valueOf(photo_, "Shutter Speed") === "1/125 s", String(valueOf(photo_, "Shutter Speed")));
	check("Focal Length is formatted in mm", valueOf(photo_, "Focal Length") === "35 mm", String(valueOf(photo_, "Focal Length")));
	check("Image Size is formatted as width × height", valueOf(photo_, "Image Size") === "4000 × 3000", String(valueOf(photo_, "Image Size")));

	// ------------------------------------------------------- show less / more
	const toggleLabel = (state) =>
		state.sections.find((section) => section.title === "General Info")?.toggle ?? null;
	check("the toggle starts on Show less (fully expanded)", toggleLabel(expanded) === "Show less", String(toggleLabel(expanded)));

	await page.locator(".info-section button", { hasText: "Show less" }).click();
	await page.waitForFunction(() => document.querySelector(".inspector-body")?.innerText.includes("Show more"));
	await new Promise((resolve) => setTimeout(resolve, 200));
	const collapsed = await probe(page);
	await page.screenshot({ path: join(EVIDENCE, "02-photo-collapsed.png") });
	check("Show less keeps the core Path row", hasLabel(collapsed, "Path"));
	check("Show less keeps the core Date Created row", hasLabel(collapsed, "Date Created"));
	check("Show less hides the Date Accessed row", !hasLabel(collapsed, "Date Accessed"));
	check("Show less hides the Image Info section", sectionRows(collapsed, "Image Info").length === 0);
	check("the toggle flips to Show more", toggleLabel(collapsed) === "Show more", String(toggleLabel(collapsed)));
	check("collapsing shortens the visible list", collapsed.text.length < expanded.text.length);

	await page.locator(".info-section button", { hasText: "Show more" }).click();
	await page.waitForFunction(() => document.querySelector(".inspector-body")?.innerText.includes("Show less"));
	await new Promise((resolve) => setTimeout(resolve, 200));
	const reexpanded = await probe(page);
	check("Show more restores the Image Info section", sectionRows(reexpanded, "Image Info").length > 0);
	check("Show more restores the Date Accessed row", hasLabel(reexpanded, "Date Accessed"));

	// -------------------------------------------------------------- scrolling
	await app.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith("/index.html"));
		window.setMinimumSize(600, 420);
		window.setSize(1500, 560);
	});
	// The window's own content height, read in main: the page's outerHeight includes Windows' invisible frame.
	for (const deadline = Date.now() + 5000; ; await new Promise((resolve) => setTimeout(resolve, 100))) {
		const height = await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith("/index.html")).getContentSize()[1],
		);
		if (Math.abs(height - 560) <= 2) break;
		if (Date.now() > deadline) throw new Error(`the window never reached 560px (content height ${height})`);
	}
	await new Promise((resolve) => setTimeout(resolve, 200));
	const tall = await probe(page);
	check("the panel overflows at a short window height", tall.scrollHeight > tall.clientHeight, `scroll=${tall.scrollHeight} client=${tall.clientHeight}`);
	const scrolled = await page.evaluate(() => {
		const body = document.querySelector(".inspector-body");
		body.scrollTop = body.scrollHeight;
		return body.scrollTop;
	});
	check("the panel body actually scrolls", scrolled > 0, String(scrolled));
	await page.screenshot({ path: join(EVIDENCE, "03-photo-scrolled.png") });
	await page.evaluate(() => {
		document.querySelector(".inspector-body").scrollTop = 0;
	});

	// ---------------------------------------------------------- notes.txt
	await page.locator('[role="row"]').filter({ hasText: "notes.txt" }).first().click();
	await page.waitForFunction(() =>
		document.querySelector(".inspector-body")?.innerText.includes("General Info"),
	);
	await page.waitForFunction((path) => {
		const rows = [...document.querySelectorAll(".inspector-body dl > div")];
		return rows.some((row) => row.querySelector("dt")?.textContent === "Path" && row.querySelector("dd")?.textContent === path);
	}, join(folder, "notes.txt"));
	await new Promise((resolve) => setTimeout(resolve, 300));
	const text = await probe(page);
	await page.screenshot({ path: join(EVIDENCE, "04-text-file.png") });
	check("a non-image file shows no Image Info section", sectionRows(text, "Image Info").length === 0);
	check("a non-image file has no Camera Model row", !hasLabel(text, "Camera Model"));
	check("a non-image file still shows Path", hasLabel(text, "Path"));

	// ------------------------------------------------------------ subfolder
	await page.locator('[role="row"]').filter({ hasText: "subfolder" }).first().click();
	await page.waitForFunction(() =>
		document.querySelector(".inspector-body")?.innerText.includes("Date Created"),
	);
	await new Promise((resolve) => setTimeout(resolve, 300));
	const dir = await probe(page);
	await page.screenshot({ path: join(EVIDENCE, "05-folder.png") });
	check(
		"a folder shows its kind and no photo section",
		/Folder/.test(String(valueOf(sectionRows(dir, "General Info"), "Kind"))) && sectionRows(dir, "Image Info").length === 0,
		String(valueOf(sectionRows(dir, "General Info"), "Kind")),
	);

	await Bun.write(
		join(EVIDENCE, "manifest.json"),
		`${JSON.stringify({ results, photo, folder }, null, 2)}\n`,
	);
} finally {
	await app?.close();
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed → ${EVIDENCE}`);
if (failed.length > 0 || results.length === 0) process.exitCode = 1;
