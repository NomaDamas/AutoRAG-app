/**
 * Manual QA — scrollbars must never move the layout (real Electron).
 *
 * The Info panel's metadata can grow past the container; the scrollbar that
 * appears for it must overlay the content, not consume layout width — the
 * preview paper and every row keep the same width whether the panel scrolls
 * or not. The script measures the panel with a minimal file selected (fits,
 * no scrollbar), then with an EXIF-rich JPEG fully expanded (overflows,
 * scrollbar), and asserts nothing moved.
 *
 * `bun run build` first, then
 * `bun scripts/manual-qa/run-qa-finder-overlay-scrollbars.mjs`
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExifJpeg } from "../../test/support/exif-fixture.ts";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";

const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-overlay-scrollbars");
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

// A short home path on Windows: the Info panel wraps "Where"/"Path" and would overflow even for a tiny file with a long profile folder.
const home = join(process.platform === "win32" ? `${process.env.SystemDrive ?? "C:"}\\` : tmpdir(), "ulw-scroll-qa-home");
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });

const fixtureName = "ulw-scroll-qa";
const folder = join(home, "Documents", fixtureName);
mkdirSync(folder, { recursive: true });
await Bun.write(join(folder, "photo.jpg"), buildExifJpeg());
await Bun.write(join(folder, "notes.txt"), "overlay scrollbar qa\n");
const MT = new Date("2026-01-02T09:05:00Z");
for (const name of ["photo.jpg", "notes.txt"]) utimesSync(join(folder, name), MT, MT);

const userDataDir = mkdtempSync(join(tmpdir(), "ulw-scroll-data-"));

const results = [];
const check = (label, pass, detail = "") => {
	results.push({ label, pass, detail });
	if (!pass) console.log(`FAIL  ${label} ${detail}`);
};

const measure = (page) =>
	page.evaluate(() => {
		const body = document.querySelector(".inspector-body");
		const paper = document.querySelector(".preview-paper");
		const title = document.querySelector(".preview-title");
		return {
			bodyClientWidth: body.clientWidth,
			verticalBarWidth: body.offsetWidth - body.clientWidth,
			paperWidth: paper === null ? null : Math.round(paper.getBoundingClientRect().width),
			titleWidth: title === null ? null : Math.round(title.getBoundingClientRect().width),
			overflowing: body.scrollHeight > body.clientHeight,
		};
	});

const select = async (page, name) => {
	await page.locator('[role="row"]').filter({ hasText: name }).first().click();
	await page.waitForFunction(
		(fileName) => document.querySelector(".preview-title")?.textContent === fileName,
		name,
		{ timeout: 10000 },
	);
};

let app;
try {
	app = await launchFinder({ userDataDir, env: { HOME: home } });
	const page = await finderWindow(app, 30000);
	await page.setViewportSize({ width: 1400, height: 900 }).catch(() => {});
	await page.waitForSelector(".sidebar__item", { timeout: 30000 });
	await page.getByLabel("Places").getByRole("button", { name: "Documents", exact: true }).click();
	const fixtureRow = page.locator('[role="row"]').filter({ hasText: fixtureName }).first();
	await fixtureRow.waitFor({ timeout: 30000 });
	await fixtureRow.dblclick();
	await page.waitForFunction((name) => document.querySelector(".toolbar-title")?.textContent === name, fixtureName);

	// State A — the text file's panel fits: no scrollbar at all.
	await select(page, "notes.txt");
	await page.waitForFunction(
		() => {
			const body = document.querySelector(".inspector-body");
			return body !== null && body.scrollHeight <= body.clientHeight;
		},
		undefined,
		{ timeout: 5000 },
	);
	await new Promise((resolve) => setTimeout(resolve, 200));
	const fitting = await measure(page);
	await page.screenshot({ path: join(EVIDENCE, "01-fitting-no-scrollbar.png") });

	// State B — the EXIF-rich photo (the panel starts fully expanded): scrolls.
	await select(page, "photo.jpg");
	await page.waitForFunction(() => document.querySelector(".inspector-body")?.innerText.includes("Date Created"), undefined, {
		timeout: 10000,
	});
	await page.waitForFunction(
		() => {
			const body = document.querySelector(".inspector-body");
			return body !== null && body.scrollHeight > body.clientHeight;
		},
		undefined,
		{ timeout: 5000 },
	);
	await new Promise((resolve) => setTimeout(resolve, 300));
	const scrolling = await measure(page);
	await page.screenshot({ path: join(EVIDENCE, "02-scrolling-overflow.png") });

	check("the fixture genuinely toggles overflow", !fitting.overflowing && scrolling.overflowing, JSON.stringify({ fitting: fitting.overflowing, scrolling: scrolling.overflowing }));
	check(
		"the panel keeps its usable width when the scrollbar appears",
		fitting.bodyClientWidth === scrolling.bodyClientWidth,
		`fitting=${fitting.bodyClientWidth}px scrolling=${scrolling.bodyClientWidth}px`,
	);
	// Only macOS has overlay scrollbars; elsewhere the bar is thin and its gutter is reserved up front (the checks above).
	check(
		"the scrollbar consumes no layout width (overlay)",
		process.platform !== "darwin" || scrolling.verticalBarWidth === 0,
		`vertical bar width=${scrolling.verticalBarWidth}px`,
	);
	check(
		"the preview paper keeps its width when the scrollbar appears",
		fitting.paperWidth !== null && scrolling.paperWidth !== null && fitting.paperWidth === scrolling.paperWidth,
		`fitting=${String(fitting.paperWidth)}px scrolling=${String(scrolling.paperWidth)}px`,
	);

	await Bun.write(join(EVIDENCE, "manifest.json"), `${JSON.stringify({ results }, null, 2)}\n`);
} finally {
	await app?.close();
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed → ${EVIDENCE}`);
if (failed.length > 0 || results.length === 0) process.exitCode = 1;
