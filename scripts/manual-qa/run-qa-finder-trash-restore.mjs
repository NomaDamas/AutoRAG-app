/**
 * Manual QA: the Trash location restores, empties on confirm, and both ⌘Z
 * paths work (issue #86 acceptance).
 *
 *   1. Put Back moves an app-trashed payload back to its folder (toolbar
 *      button and context-menu item), and ⌘Z undoes the restore.
 *   2. ⌘Z right after a trash puts the item back, Finder-style.
 *   3. 휴지통 비우기 only runs past the confirm dialog, which Escape and the
 *      cancel button both dismiss. The destructive confirm runs against a
 *      throwaway home's Trash (macOS), never the operator's real Trash.
 *
 * Phase 1 trashes through the real OS, like a user does; it restores the item
 * again before closing, so the only lasting artifacts are this run's fixture
 * folder and evidence. Windows empties only a throwaway-home Trash view for
 * the dialog checks; the real Recycle Bin is never emptied on any platform.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { baseName, chord, homeEnv, isWindows, rmRetry, sleep } from "./platform.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));

const REPO = join(HERE, "..", "..");
const EVIDENCE = join(REPO, ".omo", "evidence", "ai-finder-app", "trash-restore");
mkdirSync(EVIDENCE, { recursive: true });

const FIXTURE_DIR = join(homedir(), "Downloads", "ulw-trash-restore-qa");
const FOLDER = "ulw-trash-restore-qa";
const FILE = "put-back-me.txt";
const FILE_PATH = join(FIXTURE_DIR, FILE);
const TRASH_LABEL = isWindows ? "Recycle Bin" : "Trash";
/** The Trash roots this run's victim may land in (macOS only; Windows keeps its bin machine-global). */
const TRASH_ROOTS = [join(homedir(), "Library", "Mobile Documents", ".Trash"), join(homedir(), ".Trash")];
/** Remove every payload this run could have trashed: macOS collision-renames a same-named leftover. */
function cleanTrashRoots() {
	if (isWindows) return;
	for (const root of TRASH_ROOTS) {
		for (const name of readdirSync(root).filter((candidate) => candidate.startsWith(baseName(FILE)))) {
			rmSync(join(root, name), { force: true });
		}
	}
}

function check(label, value, expected) {
	const pass = value === expected;
	if (!pass) process.exitCode = 1;
	console.log(`${pass ? "PASS " : "FAIL "}${label}${pass ? "" : ` — got ${JSON.stringify(value)}, want ${JSON.stringify(expected)}`}`);
}

async function waitFor(predicate, { timeoutMs, label, stepMs = 250 }) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await sleep(stepMs);
	}
	console.log(`FAIL timeout waiting for ${label}`);
	process.exitCode = 1;
	return false;
}

function fixture() {
	mkdirSync(FIXTURE_DIR, { recursive: true });
	writeFileSync(FILE_PATH, `restore me ${new Date().toISOString()}\n`, "utf8");
}

async function openFixtureFolder(page) {
	await page.getByRole("button", { name: "Downloads" }).click();
	await waitFor(async () => (await page.locator('[role="row"]', { hasText: FOLDER }).count()) > 0, {
		timeoutMs: 30_000,
		label: `${FOLDER} row in Downloads`,
	});
	await page.locator('[role="row"]', { hasText: FOLDER }).first().dblclick();
	await page.locator('[role="row"]', { hasText: FILE }).first().waitFor({ timeout: 30_000 });
}

fixture();
cleanTrashRoots();

const USER_DATA = join(tmpdir(), "pw-electron-qa-trash-restore");
rmRetry(USER_DATA);

// ---------------------------------------------------------------- phase 1: Put Back + ⌘Z
const app = await launchFinder({ userDataDir: USER_DATA });
const page = await finderWindow(app);
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForSelector('[role="row"]', { timeout: 60_000 });
await page.screenshot({ path: join(EVIDENCE, "0-launch.png") });

// 1. ⌘Z right after a trash puts the item straight back (Finder behavior).
await openFixtureFolder(page);
check("trash controls hidden in an ordinary folder", await page.getByRole("button", { name: "Put Back" }).count(), 0);
await page.locator('[role="row"]', { hasText: FILE }).first().click({ button: "right" });
await page.getByRole("menuitem", { name: "Move to Trash" }).click();
await waitFor(async () => !existsSync(FILE_PATH), { timeoutMs: 30_000, label: "file left for the OS Trash" });
await waitFor(async () => (await page.locator('[role="row"]', { hasText: FILE }).count()) === 0, {
	timeoutMs: 30_000,
	label: "trashed row left the listing",
});
await page.keyboard.press(chord("Z"));
await waitFor(async () => existsSync(FILE_PATH), { timeoutMs: 30_000, label: "⌘Z put the trashed file back" });
check("⌘Z after trash restored the file", existsSync(FILE_PATH), true);
await page.screenshot({ path: join(EVIDENCE, "1-after-cmd-z-trash.png") });

// 2. The Trash view lists the payload under its original name.
await page.locator('[role="row"]', { hasText: FILE }).first().click({ button: "right" });
await page.getByRole("menuitem", { name: "Move to Trash" }).click();
await waitFor(async () => !existsSync(FILE_PATH), { timeoutMs: 30_000, label: "file left for the OS Trash" });
await page.getByLabel("Places").getByRole("button", { name: TRASH_LABEL, exact: true }).click();
const trashRow = page.locator('[role="row"]', { hasText: FILE });
await trashRow.first().waitFor({ timeout: 30_000 });
check("trash controls shown in the Trash view", await page.getByRole("button", { name: "Put Back" }).isVisible(), true);
check("put back disabled without a selection", await page.getByRole("button", { name: "Put Back" }).isDisabled(), true);
await page.screenshot({ path: join(EVIDENCE, "2-trash-view.png") });

// 3. The row menu offers Put Back, and the toolbar button performs it.
await trashRow.first().click({ button: "right" });
await page.getByRole("menuitem", { name: "Put Back" }).first().click();
await waitFor(async () => existsSync(FILE_PATH), { timeoutMs: 30_000, label: "menu Put Back restored the file" });
check("menu Put Back restored the file", existsSync(FILE_PATH), true);
await waitFor(async () => (await trashRow.count()) === 0, { timeoutMs: 30_000, label: "restored row left the Trash view" });

// 4. ⌘Z undoes the restore: the payload goes back into the Trash.
await page.keyboard.press(chord("Z"));
await waitFor(async () => !existsSync(FILE_PATH), { timeoutMs: 30_000, label: "⌘Z re-trashed the file" });
check("⌘Z after restore re-trashed the file", existsSync(FILE_PATH), false);

// 5. The toolbar button puts it back, leaving the real Trash clean of this run's item.
await trashRow.first().waitFor({ timeout: 30_000 });
await trashRow.first().click();
await page.getByRole("button", { name: "Put Back" }).click();
await waitFor(async () => existsSync(FILE_PATH), { timeoutMs: 30_000, label: "toolbar Put Back restored the file" });
check("toolbar Put Back restored the file", existsSync(FILE_PATH), true);
await page.screenshot({ path: join(EVIDENCE, "3-after-put-back.png") });
await app.close();

// ------------------------------------------------- phase 2: empty on confirm, cancel paths
/**
 * The empty runs against a throwaway home's Trash, never the operator's real
 * one: on macOS the app's Trash view and empty follow HOME; Windows keeps its
 * Recycle Bin machine-global, so there only the non-destructive dialog checks
 * run (the confirm is never clicked).
 */
const THROWAWAY_HOME = mkdtempSync(join(tmpdir(), "ulw-trash-empty-home-"));
const THROWAWAY_TRASH = join(THROWAWAY_HOME, ".Trash");
mkdirSync(THROWAWAY_TRASH, { recursive: true });
// The app's first tab lists a real folder: seed one so the listing has rows on either platform.
const THROWAWAY_DOCUMENTS = join(THROWAWAY_HOME, "Documents");
mkdirSync(THROWAWAY_DOCUMENTS, { recursive: true });
writeFileSync(join(THROWAWAY_DOCUMENTS, "seed.txt"), "seed\n", "utf8");
if (!isWindows) {
	for (const name of ["empty-me-a.txt", "empty-me-b.txt"]) writeFileSync(join(THROWAWAY_TRASH, name), `${name}\n`, "utf8");
	// Finder's own folder metadata must survive an empty.
	writeFileSync(join(THROWAWAY_TRASH, ".DS_Store"), "\0", "utf8");
}
const USER_DATA_EMPTY = join(tmpdir(), "pw-electron-qa-trash-restore-empty");
rmRetry(USER_DATA_EMPTY);
const emptyApp = await launchFinder({ userDataDir: USER_DATA_EMPTY, env: homeEnv(THROWAWAY_HOME) });
const emptyPage = await finderWindow(emptyApp);
await emptyPage.setViewportSize({ width: 1440, height: 900 });
await emptyPage.waitForSelector('[role="row"]', { timeout: 60_000 });
await emptyPage.getByLabel("Places").getByRole("button", { name: TRASH_LABEL, exact: true }).click();
await emptyPage.getByRole("button", { name: "Empty Trash" }).click();
const dialog = emptyPage.getByRole("alertdialog", { name: "Empty Trash" });
await dialog.waitFor({ timeout: 30_000 });
await emptyPage.screenshot({ path: join(EVIDENCE, "4-empty-confirm.png") });

// 6. Escape and the cancel button both dismiss the confirm without deleting.
await emptyPage.keyboard.press("Escape");
await dialog.waitFor({ state: "hidden", timeout: 30_000 });
check("Escape dismissed the empty confirm", await dialog.count() === 0 || (await dialog.isHidden()), true);
if (!isWindows) {
	check("Escape kept the Trash payloads", existsSync(join(THROWAWAY_TRASH, "empty-me-a.txt")), true);
}
await emptyPage.getByRole("button", { name: "Empty Trash" }).click();
await dialog.waitFor({ timeout: 30_000 });
await dialog.getByRole("button", { name: "Cancel" }).click();
await dialog.waitFor({ state: "hidden", timeout: 30_000 });
if (!isWindows) {
	check("Cancel kept the Trash payloads", existsSync(join(THROWAWAY_TRASH, "empty-me-a.txt")), true);
}

// 7. The confirmed empty permanently deletes the payloads, keeping Finder's own metadata.
if (isWindows) {
	console.log("INFO the destructive empty confirm is macOS QA only; Windows empties via the unit-tested fs path (a real bin is never emptied by a lane)");
} else {
	await emptyPage.getByRole("button", { name: "Empty Trash" }).click();
	await dialog.waitFor({ timeout: 30_000 });
	await dialog.getByRole("button", { name: "Empty", exact: true }).click();
	await dialog.waitFor({ state: "hidden", timeout: 30_000 });
	// The empty removes the payloads one by one: wait for every one before reading any.
	await waitFor(async () => !existsSync(join(THROWAWAY_TRASH, "empty-me-a.txt")) && !existsSync(join(THROWAWAY_TRASH, "empty-me-b.txt")), {
		timeoutMs: 30_000,
		label: "confirmed empty deleted the payloads",
	});
	check("confirmed empty deleted the payloads", existsSync(join(THROWAWAY_TRASH, "empty-me-a.txt")), false);
	check("confirmed empty deleted the second payload", existsSync(join(THROWAWAY_TRASH, "empty-me-b.txt")), false);
	check("empty kept Finder's .DS_Store", existsSync(join(THROWAWAY_TRASH, ".DS_Store")), true);
	// ⌘Z after an empty must not resurrect anything.
	await emptyPage.keyboard.press(chord("Z"));
	await sleep(1_000);
	check("⌘Z after empty resurrected nothing", existsSync(join(THROWAWAY_TRASH, "empty-me-a.txt")), false);
	await emptyPage.screenshot({ path: join(EVIDENCE, "5-after-empty.png") });
}
await emptyApp.close();

// Cleanup: only this run's own artifacts.
rmRetry(FIXTURE_DIR);
rmRetry(THROWAWAY_HOME);
cleanTrashRoots();
rmRetry(USER_DATA);
rmRetry(USER_DATA_EMPTY);
console.log(`EVIDENCE ${EVIDENCE}`);
console.log(process.exitCode === 1 ? "RESULT FAIL" : "RESULT PASS");
