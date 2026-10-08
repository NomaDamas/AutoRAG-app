/**
 * Manual QA — macOS application bundles (`.app`) in the Finder.
 *
 * A `.app` is a directory on disk, but the OS treats it as one launchable
 * item. This lane drives the real production build (out/) against a hand-built
 * bundle and proves, with the isolated HOME and QA root the other lanes use:
 *  1. the Applications-style row renders the app's own OS icon, not a folder
 *     glyph (the tile is an `<img>`, which only `kind: "file"` rows get);
 *  2. its Kind cell reads "Application", the OS's own answer for the bundle;
 *  3. double-clicking it LAUNCHES the bundle — its executable really runs, so
 *     the marker file it writes appears — instead of navigating into its
 *     `Contents/`;
 *  4. Space opens the app's own panel (its icon and "Application"), never the
 *     folder listing with `Contents` in it;
 *  5. a plain folder beside it still navigates, so bundles were not bought by
 *     turning folders into files.
 *
 * Fixture: a real, launchable bundle (Info.plist + an executable shell script)
 * plus a plain folder and a plain file, under AUTORAG_QA_ROOT.
 * Evidence: .omo/evidence/ai-finder-app/app-bundles/.
 * Run from the repo root after `bun run build`:
 *   bun scripts/manual-qa/run-qa-finder-app-bundles.mjs
 */

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const EVIDENCE = join(REPO, ".omo", "evidence", "ai-finder-app", "app-bundles");
const HOME = join(tmpdir(), "ulw-app-bundles-home");
const QA_ROOT = join(HOME, "AppBundleQA");
const USER_DATA = join(tmpdir(), "ulw-app-bundles-data");
const APP_NAME = "HelloQA.app";
const BUNDLE = join(QA_ROOT, APP_NAME);
const MARKER = join(QA_ROOT, "launched.txt");

if (process.platform !== "darwin") {
	console.log("SKIP  macOS application bundles only exist on darwin");
	process.exit(0);
}

rmSync(HOME, { recursive: true, force: true });
rmSync(USER_DATA, { recursive: true, force: true });
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

/** A real bundle: LaunchServices needs an Info.plist and its executable. */
function fixture() {
	mkdirSync(join(BUNDLE, "Contents", "MacOS"), { recursive: true });
	writeFileSync(
		join(BUNDLE, "Contents", "Info.plist"),
		[
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
			'<plist version="1.0"><dict>',
			"<key>CFBundleExecutable</key><string>HelloQA</string>",
			"<key>CFBundleIdentifier</key><string>com.example.autorag.helloqa</string>",
			"<key>CFBundleName</key><string>HelloQA</string>",
			"<key>CFBundlePackageType</key><string>APPL</string>",
			"<key>CFBundleVersion</key><string>1</string>",
			"<key>CFBundleShortVersionString</key><string>1.0</string>",
			"</dict></plist>",
		].join("\n"),
	);
	const executable = join(BUNDLE, "Contents", "MacOS", "HelloQA");
	// The launch is only proven when the bundle's own process runs.
	writeFileSync(executable, `#!/bin/sh\nprintf 'launched\\n' >> ${JSON.stringify(MARKER)}\n`);
	chmodSync(executable, 0o755);
	mkdirSync(join(QA_ROOT, "Docs"), { recursive: true });
	writeFileSync(join(QA_ROOT, "notes.txt"), "hello bundle qa\n");
}

fixture();

const mdlsKind = () => {
	try {
		return execFileSync("/usr/bin/mdls", ["-name", "kMDItemKind", "-raw", BUNDLE], { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
};
/** Spotlight can answer nothing for a brand-new bundle; the app's own fallback is "Application" either way. */
const osKind = mdlsKind();
console.log(`INFO mdls kMDItemKind = ${JSON.stringify(osKind)}`);

const results = [];
const check = (label, value, expected) => {
	const pass = value === expected;
	results.push({ label, actual: value, expected, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}: ${JSON.stringify(value)} (expected ${JSON.stringify(expected)})`);
};

async function waitFor(predicate, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await predicate();
		if (value) return value;
		if (Date.now() >= deadline) return null;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

const app = await launchFinder({ userDataDir: USER_DATA, env: { HOME, USERPROFILE: HOME, AUTORAG_QA_ROOT: QA_ROOT } });
try {
	const page = await finderWindow(app, 30_000);
	page.setViewportSize({ width: 1500, height: 900 });
	await page.waitForSelector(".toolbar-title", { timeout: 60_000 });

	// The QA root is its own sidebar place; reach it the way a user does.
	await page.locator(".sidebar__item", { hasText: "QA" }).click();
	const title = () => page.locator(".toolbar-title").innerText();
	await waitFor(async () => (await title()) === "AppBundleQA");
	check("the QA root opens the Applications-style listing", await title(), "AppBundleQA");

	const row = page.locator('[role="row"]').filter({ hasText: APP_NAME }).first();
	await row.waitFor({ timeout: 30_000 });

	// 1. The tile is the app's own OS icon — an <img> only file rows ever get.
	const icon = await waitFor(async () => (await row.locator("img.tile--image").count()) > 0, 20_000);
	check("the bundle row renders an OS icon tile, not a folder glyph", icon !== null, true);

	// 2. The Kind cell shows the OS's answer. A folder row can never show one.
	// The default column order is Name, Date Modified, Size, Kind (Extension and
	// Relative Path start hidden), the same cell the kind lane reads.
	const KIND_CELL_INDEX = 3;
	const kindCell = async () => {
		const cells = await row.locator('[role="gridcell"]').allInnerTexts();
		return cells[KIND_CELL_INDEX]?.trim() ?? "";
	};
	const kind = (await waitFor(async () => (await kindCell()) || null)) ?? "";
	// Spotlight can answer nothing for a bundle under the tmp volume; the app's
	// own fallback for the `app` extension is the same label.
	const expectedKind = osKind !== "" && osKind !== "(null)" ? osKind : "Application";
	check("the Kind cell is the OS's own answer for the bundle", kind, expectedKind);
	check("the bundle is not listed as a folder", kind === "Folder", false);
	await page.screenshot({ path: `${EVIDENCE}/listing.png` });

	// 3. Double-click launches the bundle; it must not navigate into it.
	await row.dblclick();
	const launched = await waitFor(() => existsSync(MARKER), 20_000);
	check("double-click launches the bundle (its executable ran)", launched !== null, true);
	check("the row is still listed — activating it did not navigate inside", await row.count(), 1);
	check("the toolbar still shows the enclosing folder", await title(), "AppBundleQA");

	// 4. Space opens the app's own panel, never the bundle's contents.
	const previews = await app.windows();
	const preview = previews.find((candidate) => candidate.url().includes("quick-look.html"));
	if (preview === undefined) throw new Error("Quick Look window did not pre-warm");
	await row.click();
	await page.keyboard.press("Space");
	const panel = await waitFor(() => preview.locator(".ql-bundle").count().then((count) => count > 0), 20_000);
	check("Space opens the app panel", panel !== null, true);
	check("the panel names the app", (await preview.locator(".ql-bundle__name").innerText()).trim(), APP_NAME);
	check("the panel calls it an Application", (await preview.locator(".ql-bundle").innerText()).includes("Application"), true);
	check("the panel draws the app's own icon", await preview.locator(".ql-bundle__icon").count(), 1);
	check(
		"the app icon really loads through autorag-thumb",
		await preview
			.locator(".ql-bundle__icon")
			.evaluate((image) => image instanceof HTMLImageElement && image.naturalWidth > 0 && image.src.startsWith("autorag-thumb://")),
		true,
	);
	check("the panel lists no Contents", await preview.locator(".ql-folder__items").count(), 0);
	const previewWidth = () =>
		app.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("quick-look.html"));
			return window === undefined ? null : window.getBounds().width;
		});
	await waitFor(async () => (await previewWidth()) === 620, 5_000);
	check("the app panel is the Other panel's 620px width", await previewWidth(), 620);
	check("the toolbar button launches the app itself, never \"Open with\"", (await preview.locator(".qlw__open").innerText()).trim(), "Open");
	await preview.screenshot({ path: `${EVIDENCE}/preview.png` });

	const previewVisible = () =>
		app.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("quick-look.html"));
			return window !== undefined && window.isVisible();
		});
	await page.keyboard.press("Space");
	await waitFor(async () => (await previewVisible()) === false, 10_000);
	check("Space closes the app panel", await previewVisible(), false);

	// 5. A plain folder still opens.
	const folder = page.locator('[role="row"]').filter({ hasText: "Docs" }).first();
	await folder.dblclick();
	await waitFor(async () => (await title()) === "Docs", 20_000);
	check("a plain folder still navigates on double-click", await title(), "Docs");
	await page.screenshot({ path: `${EVIDENCE}/after-open.png` });
} finally {
	await app.close();
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
