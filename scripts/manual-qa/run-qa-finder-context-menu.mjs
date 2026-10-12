/**
 * Manual QA: the row context menu carries the Inspector's headline actions.
 *
 * Right-clicking a row must offer what the Inspector action bar offers —
 * Open With, Compress, Extract for a .zip, Share where the OS has a sheet,
 * and New Folder for the folder in view — gated by the machine's real
 * capabilities and trimmed to what a multi-selection can actually honour.
 *
 * Fixture: a fixed QA root passed through AUTORAG_QA_ROOT, plus tiny real
 * files (a base64 PNG, a folder, and a zip built with the app's own fflate).
 * Evidence: .omo/evidence/ai-finder-app/context-menu/.
 * Run from the repo root after `bun run build`:
 *   bun scripts/manual-qa/run-qa-finder-context-menu.mjs
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, zipSync } from "fflate";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { isMac, rmRetry } from "./platform.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const EVIDENCE = join(REPO, ".omo", "evidence", "ai-finder-app", "context-menu");
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

const HOME = join(tmpdir(), "ulw-cmenu-home");
const QA_ROOT = join(HOME, "ContextMenuQA");
const USER_DATA = join(tmpdir(), "ulw-cmenu-data");
rmSync(HOME, { recursive: true, force: true });
rmSync(USER_DATA, { recursive: true, force: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A real (tiny) PNG, so the row carries a real file. */
const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

function fixture() {
	mkdirSync(join(QA_ROOT, "docs"), { recursive: true });
	writeFileSync(join(QA_ROOT, "notes.txt"), "context menu\n");
	writeFileSync(join(QA_ROOT, "photo.png"), PNG_1X1);
	writeFileSync(join(QA_ROOT, "docs", "readme.md"), "# docs\n");
	writeFileSync(
		join(QA_ROOT, "bundle.zip"),
		zipSync({
			"bundle/": new Uint8Array(0),
			"bundle/inside.txt": new Uint8Array(Buffer.from("inside")),
		}),
	);
}

function check(label, value, expected) {
	const ok = value === expected;
	console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(value)} (expected ${JSON.stringify(expected)})`);
	if (!ok) process.exitCode = 1;
}

async function waitFor(predicate, { timeoutMs = 20000, label, stepMs = 100 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		last = await predicate();
		if (last) return last;
		await sleep(stepMs);
	}
	throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The row for `name`, matched on its own label so siblings' zips do not shadow it. */
const rowFor = (page, name) =>
	page
		.locator('[role="row"]')
		.filter({ has: page.locator(".row__label", { hasText: new RegExp(`^${escapeRegExp(name)}$`) }) })
		.first();

/** The labels of every open menu item, main menu and popout flattened. */
const menuLabels = (page) => page.locator('[role="menuitem"]').allInnerTexts();

/** Right-click the row named `name` and wait for the menu to settle. */
async function openRowMenu(page, name) {
	await page.locator(".toast").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
	const row = rowFor(page, name);
	await row.waitFor({ timeout: 15_000 });
	await row.click({ button: "right" });
	await page.waitForSelector('[role="menuitem"]');
	// The menu rises in over `--dur-menu`; shoot and read it settled.
	await sleep(400);
}

/** Right-click a point in the empty listing background, below the last row. */
async function openBackgroundMenu(page) {
	await page.locator(".toast").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
	const listBox = await page.locator(".list").boundingBox();
	const lastRowBox = await page.locator('[role="row"]').last().boundingBox().catch(() => null);
	if (listBox === null) throw new Error("no listing");
	if (lastRowBox !== null && listBox.y + listBox.height - 24 <= lastRowBox.y + lastRowBox.height) {
		throw new Error("fixture has no empty listing background below its rows");
	}
	await page.mouse.click(listBox.x + listBox.width / 2, listBox.y + listBox.height - 24, { button: "right" });
	await page.waitForSelector('[role="menuitem"]');
	await sleep(400);
}

async function closeMenu(page) {
	await page.keyboard.press("Escape");
	await page.waitForSelector('[role="menuitem"]', { state: "detached" });
}

fixture();
/** The share sheet is macOS-only; the Windows menu hides the item by capability. */
const canShare = isMac;
const app = await launchFinder({ userDataDir: USER_DATA, env: { HOME, USERPROFILE: HOME, AUTORAG_QA_ROOT: QA_ROOT } });
try {
	const page = await finderWindow(app, 30_000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
	await page.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
	await page.waitForSelector(".toolbar-title", { timeout: 60_000 });
	await page.locator('[role="row"]').first().waitFor({ timeout: 30_000 });

	// 1. The file menu carries the headline actions, gated by capability.
	await openRowMenu(page, "notes.txt");
	let labels = await menuLabels(page);
	check("file menu offers Open With", labels.includes("Open With"), true);
	check("file menu offers Compress", labels.includes("Compress"), true);
	check("file menu offers New Folder", labels.includes("New Folder"), true);
	check("file menu offers no Extract for a plain file", labels.includes("Extract"), false);
	check("file menu offers Share only with a share sheet", labels.includes("Share"), canShare);
	await page.screenshot({ path: join(EVIDENCE, "1-file-menu.png") });
	await closeMenu(page);

	// 2. A .zip offers Extract, and it runs from the menu.
	await openRowMenu(page, "bundle.zip");
	labels = await menuLabels(page);
	check("zip menu offers Extract", labels.includes("Extract"), true);
	await page.screenshot({ path: join(EVIDENCE, "2-zip-menu.png") });
	await page.getByRole("menuitem", { name: "Extract", exact: true }).click();
	await waitFor(() => existsSync(join(QA_ROOT, "bundle", "inside.txt")), { label: "the extracted folder" });
	check("extract restored the folder", existsSync(join(QA_ROOT, "bundle", "inside.txt")), true);

	// 3. Compress writes the zip next to the row.
	await openRowMenu(page, "notes.txt");
	await page.getByRole("menuitem", { name: "Compress", exact: true }).click();
	await waitFor(() => existsSync(join(QA_ROOT, "notes.txt.zip")), { label: "notes.txt.zip" });
	check("compress wrote a zip", existsSync(join(QA_ROOT, "notes.txt.zip")), true);

	// 4. A multi-selection keeps the batch actions and compresses into one Archive.zip.
	const meta = isMac ? "Meta" : "Control";
	await rowFor(page, "notes.txt").click();
	await rowFor(page, "photo.png").click({ modifiers: [meta] });
	await rowFor(page, "notes.txt").click({ button: "right" });
	await page.waitForSelector('[role="menuitem"]');
	labels = await menuLabels(page);
	check("multi menu counts the compress", labels.includes("Compress 2 Items"), true);
	check("multi menu drops Extract", labels.includes("Extract"), false);
	await page.screenshot({ path: join(EVIDENCE, "3-multi-menu.png") });
	await page.getByRole("menuitem", { name: "Compress 2 Items", exact: true }).click();
	await waitFor(() => existsSync(join(QA_ROOT, "Archive.zip")), { label: "Archive.zip" });
	check("multi compress wrote one Archive.zip", existsSync(join(QA_ROOT, "Archive.zip")), true);
	const archived = unzipSync(new Uint8Array(readFileSync(join(QA_ROOT, "Archive.zip"))));
	check(
		"Archive.zip holds both rows",
		Object.keys(archived).includes("notes.txt") && Object.keys(archived).includes("photo.png"),
		true,
	);

	// 5. New Folder creates in the folder in view.
	await openRowMenu(page, "notes.txt");
	await page.getByRole("menuitem", { name: "New Folder", exact: true }).click();
	await waitFor(() => existsSync(join(QA_ROOT, "untitled folder")), { label: "untitled folder" });
	check("new folder created in view", existsSync(join(QA_ROOT, "untitled folder")), true);
	await page.screenshot({ path: join(EVIDENCE, "4-new-folder.png") });

	// 6. The background menu still carries no row actions.
	await openBackgroundMenu(page);
	labels = await menuLabels(page);
	check("background menu keeps New", labels.includes("New"), true);
	check("background menu has no Compress", labels.includes("Compress"), false);
	check("background menu has no Open With", labels.includes("Open With"), false);
	await page.screenshot({ path: join(EVIDENCE, "5-background-menu.png") });
	await closeMenu(page);

	// 7. Share from the menu opens the sheet on macOS; the assertion is that
	// the request reached the OS without an error toast.
	if (canShare) {
		await openRowMenu(page, "notes.txt");
		await page.getByRole("menuitem", { name: "Share", exact: true }).click();
		await sleep(800);
		const toast = await page.locator(".toast").allInnerTexts();
		check("menu share did not error", toast.some((text) => text.includes("does not support") || text.includes("Error")), false);
	}

	// 8. Open With opens the native application chooser. The sheet is a native
	// modal, so the assertion is that the renderer survives it — the sheet
	// itself goes away with the process when the run ends.
	await openRowMenu(page, "notes.txt");
	await page.getByRole("menuitem", { name: "Open With", exact: true }).click();
	await sleep(1500);
	const responsive = await page.evaluate(() => document.querySelectorAll(".menu").length === 0);
	check("open-with chooser leaves the window responsive", responsive, true);
	await page.screenshot({ path: join(EVIDENCE, "6-open-with.png") });

	await page.screenshot({ path: join(EVIDENCE, "7-final.png") });
} finally {
	// The macOS ShareMenu's native tracking session (and the open-with sheet)
	// outlives the checks and blocks even `app.exit(0)` — only killing the
	// Electron process ends it. All assertions and screenshots are done here.
	try {
		process.kill(app.process().pid, "SIGKILL");
	} catch {
		// Already gone.
	}
	await app.close().catch(() => undefined);
}

// Cleanup: only this run's own artifacts.
rmRetry(HOME);
rmRetry(USER_DATA);
console.log(`EVIDENCE ${EVIDENCE}`);
console.log(process.exitCode === 1 ? "RESULT FAIL" : "RESULT PASS");
