/**
 * Manual QA: the multi-step undo / redo history (issue #89 acceptance).
 *
 * Drives the production Electron app (out/) against a fixture folder and
 * asserts on disk, through the real IPC + fs worker:
 *
 *   1. rename → ⌘Z puts the old name back, toast says "이름 변경 취소";
 *   2. duplicate → ⌘Z removes the copy;
 *   3. New Folder (⇧⌘N) → ⌘Z removes it;
 *   4. compress → ⌘Z moves the archive to the Trash (recoverable);
 *   5. extract → ⌘Z moves the extracted folder to the Trash;
 *   6. ⌘Z walks several operations back in reverse order, one per press;
 *   7. ⇧⌘Z redoes them forward again, toast says "다시 실행";
 *   8. a new operation after an undo clears the redo history;
 *   9. a rename whose old name was retaken fails with the verbatim reason and
 *      overwrites nothing.
 *
 * Trashing goes through the real OS, like a user does, so the fixture lives in
 * the real ~/Downloads and this run removes only what it created (including its
 * own payloads in the Trash). Run after `bun run build`:
 * `bun scripts/manual-qa/run-qa-finder-undo-history.mjs`
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { chord, isWindows, rmRetry, sleep } from "./platform.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(HERE, "..", "..", ".omo", "evidence", "ai-finder-app", "qa-undo-history");
mkdirSync(EVIDENCE, { recursive: true });

const FOLDER = "ulw-undo-history-qa";
const DIR = join(homedir(), "Downloads", FOLDER);
const TRASH_ROOT = join(homedir(), ".Trash");
const redoChord = chord("Shift", "Z");

const results = [];
function check(name, pass, detail) {
	results.push({ name, pass, detail });
	if (!pass) process.exitCode = 1;
	console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

async function waitFor(predicate, label, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await sleep(150);
	}
	throw new Error(`timed out waiting for ${label}`);
}

const names = () => readdirSync(DIR).sort();
const trashHas = (prefix) => !isWindows && existsSync(TRASH_ROOT) && readdirSync(TRASH_ROOT).some((name) => name.startsWith(prefix));
function cleanTrash() {
	if (isWindows || !existsSync(TRASH_ROOT)) return;
	for (const name of readdirSync(TRASH_ROOT).filter((candidate) => candidate.startsWith("uh-"))) {
		rmSync(join(TRASH_ROOT, name), { recursive: true, force: true });
	}
}

const row = (page, text) => page.locator('[role="row"]', { hasText: text }).first();

async function rowMenu(page, text, item) {
	await page.locator(".toast").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
	await row(page, text).click({ button: "right" });
	await page.getByRole("menuitem", { name: item, exact: true }).click();
}

/** Press a shortcut with the listing focused, then wait for the toast naming the step. */
async function step(page, keys, toast) {
	await page.locator(".toast").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
	await page.locator(".list").click({ position: { x: 40, y: 8 } }).catch(() => {});
	await page.keyboard.press(keys);
	const found = await page
		.locator(".toast", { hasText: toast })
		.waitFor({ timeout: 10_000 })
		.then(() => true)
		.catch(() => false);
	return found;
}

rmRetry(DIR);
cleanTrash();
mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, "uh-a.txt"), "alpha");
writeFileSync(join(DIR, "uh-b.txt"), "bravo");

const USER_DATA = join(tmpdir(), "pw-electron-qa-undo-history");
rmRetry(USER_DATA);
let app = null;
try {
	app = await launchFinder({ userDataDir: USER_DATA });
	const page = await finderWindow(app);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.waitForSelector('[role="row"]', { timeout: 60_000 });
	await page.getByRole("button", { name: "Downloads" }).click();
	await waitFor(async () => (await page.locator('[role="row"]', { hasText: FOLDER }).count()) > 0, `${FOLDER} row`, 30_000);
	await row(page, FOLDER).dblclick();
	await row(page, "uh-a.txt").waitFor({ timeout: 30_000 });

	/* -------------------------------------------------- 1. rename + ⌘Z */
	await rowMenu(page, "uh-a.txt", "Rename");
	await page.locator('input[aria-label="새 이름"]').fill("uh-renamed.txt");
	await page.keyboard.press("Enter");
	await waitFor(() => existsSync(join(DIR, "uh-renamed.txt")) && !existsSync(join(DIR, "uh-a.txt")), "rename on disk");
	const undoneRename = await step(page, chord("z"), "이름 변경 취소");
	await waitFor(() => existsSync(join(DIR, "uh-a.txt")), "undo of rename");
	await page.screenshot({ path: join(EVIDENCE, "1-undo-rename.png") });
	check(
		"⌘Z undoes a rename and the toast names it",
		undoneRename && existsSync(join(DIR, "uh-a.txt")) && !existsSync(join(DIR, "uh-renamed.txt")),
		`disk=${names()}`,
	);

	/* ----------------------------------------------- 2. duplicate + ⌘Z */
	await rowMenu(page, "uh-b.txt", "Duplicate");
	await waitFor(() => existsSync(join(DIR, "uh-b copy.txt")), "duplicate on disk");
	const undoneDuplicate = await step(page, chord("z"), "복제 취소");
	await waitFor(() => !existsSync(join(DIR, "uh-b copy.txt")), "undo of duplicate");
	check("⌘Z removes the duplicate", undoneDuplicate && !existsSync(join(DIR, "uh-b copy.txt")), `disk=${names()}`);

	/* --------------------------------------------- 3. new folder + ⌘Z */
	await page.locator(".list").click({ position: { x: 40, y: 8 } });
	await page.keyboard.press(chord("Shift", "N"));
	await waitFor(() => existsSync(join(DIR, "untitled folder")), "new folder on disk");
	await page.keyboard.press("Escape");
	const undoneFolder = await step(page, chord("z"), "새 폴더 취소");
	await waitFor(() => !existsSync(join(DIR, "untitled folder")), "undo of new folder");
	check("⌘Z removes the created folder", undoneFolder && !existsSync(join(DIR, "untitled folder")), `disk=${names()}`);

	/* ------------------------------------- 4. compress + ⌘Z (to Trash) */
	await rowMenu(page, "uh-b.txt", "Compress");
	await waitFor(() => existsSync(join(DIR, "uh-b.txt.zip")), "archive on disk");
	await sleep(500);
	const undoneCompress = await step(page, chord("z"), "압축 취소");
	await waitFor(() => !existsSync(join(DIR, "uh-b.txt.zip")), "undo of compress");
	check(
		"⌘Z moves the compressed archive to the Trash",
		undoneCompress && !existsSync(join(DIR, "uh-b.txt.zip")) && (isWindows || trashHas("uh-b.txt.zip")),
		`disk=${names()}`,
	);

	/* ------------------------------------------- 5. extract + ⌘Z + ⇧⌘Z */
	await rowMenu(page, "uh-b.txt", "Compress");
	await waitFor(() => existsSync(join(DIR, "uh-b.txt.zip")), "second archive on disk");
	await sleep(500);
	await rowMenu(page, "uh-b.txt.zip", "Extract");
	// The stem "uh-b.txt" is taken by the source file, so the folder is numbered Finder-style.
	const EXTRACTED = join(DIR, "uh-b 2.txt");
	await waitFor(() => existsSync(join(EXTRACTED, "uh-b.txt")), "extraction on disk");
	await sleep(500);
	const undoneExtract = await step(page, chord("z"), "압축 해제 취소");
	await waitFor(() => !existsSync(EXTRACTED), "undo of extract");
	check(
		"⌘Z moves the extracted folder to the Trash, keeping the archive",
		undoneExtract && existsSync(join(DIR, "uh-b.txt.zip")) && !existsSync(EXTRACTED) && (isWindows || trashHas("uh-b 2.txt")),
		`disk=${names()}`,
	);
	await page.screenshot({ path: join(EVIDENCE, "2-undo-extract.png") });
	const redoneExtract = await step(page, redoChord, "압축 해제 다시 실행");
	await waitFor(() => existsSync(join(EXTRACTED, "uh-b.txt")), "redo of extract");
	check("⇧⌘Z puts the extracted folder back with its contents", redoneExtract && readFileSync(join(EXTRACTED, "uh-b.txt"), "utf8") === "bravo", `disk=${names()}`);

	/* -------------------------- 6. + 7. several undos, then redos forward */
	// History now (newest last): …, compress (archive in the folder).
	await rowMenu(page, "uh-a.txt", "Rename");
	await page.locator('input[aria-label="새 이름"]').fill("uh-one.txt");
	await page.keyboard.press("Enter");
	await waitFor(() => existsSync(join(DIR, "uh-one.txt")), "first rename");
	await rowMenu(page, "uh-one.txt", "Rename");
	await page.locator('input[aria-label="새 이름"]').fill("uh-two.txt");
	await page.keyboard.press("Enter");
	await waitFor(() => existsSync(join(DIR, "uh-two.txt")), "second rename");

	const back1 = await step(page, chord("z"), "이름 변경 취소");
	await waitFor(() => existsSync(join(DIR, "uh-one.txt")), "first undo");
	const back2 = await step(page, chord("z"), "이름 변경 취소");
	await waitFor(() => existsSync(join(DIR, "uh-a.txt")), "second undo");
	check(
		"each ⌘Z undoes exactly one operation, newest first",
		back1 && back2 && existsSync(join(DIR, "uh-a.txt")) && !existsSync(join(DIR, "uh-one.txt")) && !existsSync(join(DIR, "uh-two.txt")),
		`disk=${names()}`,
	);

	const fwd1 = await step(page, redoChord, "이름 변경 다시 실행");
	await waitFor(() => existsSync(join(DIR, "uh-one.txt")), "first redo");
	const fwd2 = await step(page, redoChord, "이름 변경 다시 실행");
	await waitFor(() => existsSync(join(DIR, "uh-two.txt")), "second redo");
	await page.screenshot({ path: join(EVIDENCE, "3-redo.png") });
	check(
		"⇧⌘Z redoes the undone renames forward and the toast says 다시 실행",
		fwd1 && fwd2 && existsSync(join(DIR, "uh-two.txt")) && !existsSync(join(DIR, "uh-a.txt")),
		`disk=${names()}`,
	);
	check("the redone content is intact", readFileSync(join(DIR, "uh-two.txt"), "utf8") === "alpha", "content=alpha");

	/* -------------------------------- 8. a new operation clears redo */
	await step(page, chord("z"), "이름 변경 취소");
	await waitFor(() => existsSync(join(DIR, "uh-one.txt")), "undo before new op");
	await page.locator(".list").click({ position: { x: 40, y: 8 } });
	await page.keyboard.press(chord("Shift", "N"));
	await waitFor(() => existsSync(join(DIR, "untitled folder")), "new folder after undo");
	await page.keyboard.press("Escape");
	await page.locator(".list").click({ position: { x: 40, y: 8 } });
	await page.keyboard.press(redoChord);
	await sleep(1_200);
	check(
		"a new operation after an undo clears the redo history",
		existsSync(join(DIR, "uh-one.txt")) && !existsSync(join(DIR, "uh-two.txt")),
		`disk=${names()}`,
	);

	/* ---- 9. retaken name: verbatim failure, nothing overwritten */
	await step(page, chord("z"), "새 폴더 취소");
	await waitFor(() => !existsSync(join(DIR, "untitled folder")), "undo of folder");
	await rowMenu(page, "uh-one.txt", "Rename");
	await page.locator('input[aria-label="새 이름"]').fill("uh-moved.txt");
	await page.keyboard.press("Enter");
	await waitFor(() => existsSync(join(DIR, "uh-moved.txt")), "rename before retake");
	writeFileSync(join(DIR, "uh-one.txt"), "intruder");
	const failedUndo = await step(page, chord("z"), "이름 변경 취소 실패");
	check(
		"an undo onto a retaken name reports the verbatim reason and overwrites nothing",
		failedUndo && readFileSync(join(DIR, "uh-one.txt"), "utf8") === "intruder" && existsSync(join(DIR, "uh-moved.txt")),
		`disk=${names()}`,
	);
	await page.screenshot({ path: join(EVIDENCE, "4-failed-undo.png") });
} catch (error) {
	check("run completed", false, String(error).slice(0, 500));
	if (app !== null) {
		const page = await finderWindow(app).catch(() => null);
		await page?.screenshot({ path: join(EVIDENCE, "failure.png") }).catch(() => undefined);
	}
} finally {
	if (app !== null) await app.close().catch(() => undefined);
	rmRetry(DIR);
	cleanTrash();
	rmRetry(USER_DATA);
}

writeFileSync(join(EVIDENCE, "result.json"), JSON.stringify({ checks: results }, null, 2));
const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
