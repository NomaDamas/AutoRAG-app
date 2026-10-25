/**
 * Manual QA: renaming a file to another format's extension converts it (Filee).
 *
 * Drives the production Electron app (out/) against a fixture folder and asserts
 * on disk, through the real IPC, the real filee-cli, and the real Trash:
 *
 *   1. hwpx → pdf rename opens the keep/replace dialog; "Keep original" writes a
 *      real PDF under the new name and leaves the .hwpx where it was
 *   2. "Replace original" writes the PDF under a *different* stem (the typed
 *      name wins), removes the original from the folder and puts it in the Trash
 *   3. Cancel and Esc close the dialog and change nothing
 *   4. an extension with no route (mp3 → pdf) names the problem in a toast, opens
 *      no dialog, and does not rename the file
 *   5. a rename that keeps the format (txt → txt) is a plain rename, no dialog
 *   6. no `.dazzi-convert-*` staging folder is left behind
 *
 * Needs filee-cli (on PATH, or the app downloads the pinned release on first use).
 * The fixture lives in the real ~/Downloads and this run removes only what it
 * created (including its own payloads in the Trash). Run after `bun run build`:
 * `bun scripts/manual-qa/run-qa-finder-convert-rename.mjs`
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHwp } from "../../test/support/hwp-fixture.ts";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { isWindows, rmRetry, sleep } from "./platform.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(HERE, "..", "..", ".omo", "evidence", "ai-finder-app", "convert-rename");
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

const FOLDER = "ulw-convert-rename-qa";
const DIR = join(homedir(), "Downloads", FOLDER);
const TRASH_ROOT = join(homedir(), ".Trash");

function check(name, pass, detail) {
	if (!pass) process.exitCode = 1;
	console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

async function waitFor(predicate, label, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await sleep(150);
	}
	throw new Error(`timed out waiting for ${label}`);
}

const names = () => readdirSync(DIR).sort();
const isPdf = (path) => readFileSync(path).subarray(0, 4).toString("latin1") === "%PDF";
const trashHas = (prefix) => !isWindows && existsSync(TRASH_ROOT) && readdirSync(TRASH_ROOT).some((name) => name.startsWith(prefix));
function cleanTrash() {
	if (isWindows || !existsSync(TRASH_ROOT)) return;
	for (const name of readdirSync(TRASH_ROOT).filter((candidate) => candidate.startsWith("cr-"))) {
		rmSync(join(TRASH_ROOT, name), { recursive: true, force: true });
	}
}

const row = (page, text) => page.locator('[role="row"]', { hasText: text }).first();

async function startRename(page, from, to) {
	await page.locator(".toast").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
	await row(page, from).click({ button: "right" });
	await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
	await page.locator('input[aria-label="New name"]').fill(to);
	await page.keyboard.press("Enter");
}

const dialog = (page) => page.getByRole("alertdialog");

rmRetry(DIR);
cleanTrash();
mkdirSync(DIR, { recursive: true });
for (const name of ["cr-keep.hwpx", "cr-replace.hwpx", "cr-cancel.hwpx"]) {
	writeFileSync(join(DIR, name), buildHwp([`${name} 첫 쪽`, "둘째 쪽"], "hwpx"));
}
writeFileSync(join(DIR, "cr-song.mp3"), "not really audio");
writeFileSync(join(DIR, "cr-plain.txt"), "plain");

const USER_DATA = join(tmpdir(), "pw-electron-qa-convert-rename");
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
	await row(page, "cr-keep.hwpx").waitFor({ timeout: 30_000 });

	/* ------------------------------------------------ 1. keep the original */
	await startRename(page, "cr-keep.hwpx", "cr-keep.pdf");
	await dialog(page).waitFor({ timeout: 10_000 });
	const message = await dialog(page).innerText();
	// The dialog rises in; a frame taken at once catches it mid-animation.
	await sleep(1000);
	await page.screenshot({ path: join(EVIDENCE, "1-dialog.png") });
	check("the dialog names both files and both choices", /cr-keep\.hwpx/.test(message) && /cr-keep\.pdf/.test(message) && /Keep original/.test(message) && /Replace original/.test(message), JSON.stringify(message));
	check("nothing is renamed before the answer", existsSync(join(DIR, "cr-keep.hwpx")) && !existsSync(join(DIR, "cr-keep.pdf")), names().join(", "));
	await dialog(page).getByRole("button", { name: "Keep original", exact: true }).click();
	await sleep(150);
	await page.screenshot({ path: join(EVIDENCE, "1b-working.png") });
	await waitFor(() => existsSync(join(DIR, "cr-keep.pdf")), "converted cr-keep.pdf", 240_000);
	await dialog(page).waitFor({ state: "detached", timeout: 10_000 });
	check("keep: a real PDF is written under the new name", isPdf(join(DIR, "cr-keep.pdf")), `${readFileSync(join(DIR, "cr-keep.pdf")).length} bytes`);
	check("keep: the original is untouched", existsSync(join(DIR, "cr-keep.hwpx")), names().join(", "));
	await row(page, "cr-keep.pdf").waitFor({ timeout: 15_000 });
	await page.screenshot({ path: join(EVIDENCE, "2-kept.png") });

	/* ------------------------------------------ 2. replace, with a new stem */
	await startRename(page, "cr-replace.hwpx", "cr-replaced final.pdf");
	await dialog(page).waitFor({ timeout: 10_000 });
	await dialog(page).getByRole("button", { name: "Replace original", exact: true }).click();
	await waitFor(() => existsSync(join(DIR, "cr-replaced final.pdf")) && !existsSync(join(DIR, "cr-replace.hwpx")), "replaced conversion");
	check("replace: the PDF takes the typed name, not the source's", isPdf(join(DIR, "cr-replaced final.pdf")), names().join(", "));
	check("replace: the original left the folder", !existsSync(join(DIR, "cr-replace.hwpx")), names().join(", "));
	if (!isWindows) check("replace: the original is in the Trash", trashHas("cr-replace.hwpx"), TRASH_ROOT);
	await row(page, "cr-replaced final.pdf").waitFor({ timeout: 15_000 });
	await page.screenshot({ path: join(EVIDENCE, "3-replaced.png") });

	/* ---------------------------------------------------- 3. cancel and Esc */
	await startRename(page, "cr-cancel.hwpx", "cr-cancel.pdf");
	await dialog(page).waitFor({ timeout: 10_000 });
	await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
	await dialog(page).waitFor({ state: "detached", timeout: 10_000 });
	await startRename(page, "cr-cancel.hwpx", "cr-cancel.pdf");
	await dialog(page).waitFor({ timeout: 10_000 });
	await page.keyboard.press("Escape");
	await dialog(page).waitFor({ state: "detached", timeout: 10_000 });
	await sleep(500);
	check("cancel and Esc change nothing", existsSync(join(DIR, "cr-cancel.hwpx")) && !existsSync(join(DIR, "cr-cancel.pdf")), names().join(", "));

	/* ----------------------------------------------- 4. unsupported extension */
	await startRename(page, "cr-song.mp3", "cr-song.pdf");
	const toast = await page.locator(".toast", { hasText: "not supported" }).waitFor({ timeout: 10_000 }).then(() => page.locator(".toast").innerText());
	await page.screenshot({ path: join(EVIDENCE, "4-unsupported.png") });
	check("an unsupported route says so", /mp3/.test(toast) && /pdf/.test(toast), JSON.stringify(toast));
	check("an unsupported route opens no dialog and renames nothing", (await dialog(page).count()) === 0 && existsSync(join(DIR, "cr-song.mp3")) && !existsSync(join(DIR, "cr-song.pdf")), names().join(", "));

	/* ------------------------------------------------- 5. same-format rename */
	await startRename(page, "cr-plain.txt", "cr-plain-2.txt");
	await waitFor(() => existsSync(join(DIR, "cr-plain-2.txt")), "plain rename");
	check("a rename that keeps the format is a plain rename", (await dialog(page).count()) === 0 && !existsSync(join(DIR, "cr-plain.txt")), names().join(", "));

	/* ------------------------------------------------------- 6. no leftovers */
	check("no staging folder is left behind", !names().some((name) => name.startsWith(".dazzi-convert-")), names().join(", "));
} finally {
	await app?.close().catch(() => {});
	rmRetry(DIR);
	cleanTrash();
}
