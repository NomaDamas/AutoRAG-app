/**
 * Manual QA — Finder "New File" on the real build.
 *
 * Drives the production Electron app (out/) with Playwright against a fixture
 * folder in a throwaway HOME and proves the New feature end to end (through the
 * real IPC + filesystem, asserted on disk, not just in the UI):
 *
 *   1. right-clicking the empty listing background opens a menu whose "새로
 *      만들기" submenu lists a folder plus every document format;
 *   2. choosing 텍스트 파일 writes "untitled.txt" and starts the inline rename
 *      immediately, with the created row selected;
 *   3. committing the inline rename renames the file on disk;
 *   4. choosing Word 문서 writes a real OOXML package (docx) that unzips;
 *   5. a second text file collides Finder-style to "untitled 2.txt";
 *   6. ⌘Z removes the file the New menu just created;
 *   7. the sidebar "New file" button and ⌥⌘N create a text file too;
 *   8. ⇧⌘N creates a folder and starts its inline rename.
 *
 * Run from the repo root after `bun run build`:
 * `bun scripts/manual-qa/run-qa-finder-new-file.mjs`
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = join(ROOT, ".omo", "evidence", "ai-finder-app", "qa-new-file");
mkdirSync(EVIDENCE, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "ulw-newfile-home-"));
const top = join(home, "Documents", "qa-new-file");
mkdirSync(top, { recursive: true });

const results = [];
const check = (name, pass, detail) => {
	results.push({ name, pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
};

const listNames = (dir) => readdirSync(dir).sort();
const atTitle = (page, name) =>
	page.waitForFunction((want) => document.querySelector(".toolbar-title")?.textContent === want, name, { timeout: 15_000 });
const waitForDisk = async (test, label) => {
	const deadline = Date.now() + 10_000;
	while (!test() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 120));
	if (!test()) throw new Error(`timed out waiting for ${label}`);
};

/** Right-click a point in the empty listing background, below the last row. */
async function openBackgroundMenu(page) {
	// The bottom-center toast would intercept the click; wait it out.
	await page.locator(".toast").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
	const listBox = await page.locator(".list").boundingBox();
	const lastRowBox = await page.locator('[role="row"]').last().boundingBox().catch(() => null);
	if (listBox === null) throw new Error("no listing");
	if (lastRowBox !== null && listBox.y + listBox.height - 24 <= lastRowBox.y + lastRowBox.height) {
		throw new Error("fixture has no empty listing background below its rows");
	}
	await page.mouse.click(listBox.x + listBox.width / 2, listBox.y + listBox.height - 24, { button: "right" });
	await page.waitForSelector(".menu", { timeout: 5_000 });
}

/** Open the New submenu and click one of its items by label. */
async function chooseNew(page, label) {
	await page.getByRole("menuitem", { name: "새로 만들기" }).hover();
	await page.getByRole("menuitem", { name: label }).click();
}

let app = null;
try {
	console.log(`fixture: ${top}`);
	app = await launchFinder({
		userDataDir: mkdtempSync(join(tmpdir(), "ulw-newfile-data-")),
		env: { HOME: home, AUTORAG_QA_ROOT: top },
	});
	const page = await finderWindow(app, 30_000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
	await page.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
	await page.waitForSelector(".toolbar-title", { timeout: 30_000 });
	await atTitle(page, "qa-new-file");

	/* ------------------------------- 1. background menu + New submenu contents */
	await openBackgroundMenu(page);
	await page.getByRole("menuitem", { name: "새로 만들기" }).hover();
	const submenuLabels = await page.locator('[role="menu"]').last().getByRole("menuitem").allInnerTexts();
	await page.screenshot({ path: join(EVIDENCE, "1-new-submenu.png") });
	check(
		"the empty-space menu's New submenu lists a folder and every document format",
		submenuLabels.includes("새 폴더") &&
			["텍스트 파일", "Markdown 문서", "서식 있는 텍스트", "Word 문서", "Excel 스프레드시트", "PowerPoint 프레젠테이션"].every((label) =>
				submenuLabels.includes(label),
			),
		`items=${JSON.stringify(submenuLabels)}`,
	);

	/* ----------------------- 2 + 3. text file, inline rename, commit the rename */
	await chooseNew(page, "텍스트 파일");
	await waitForDisk(() => existsSync(join(top, "untitled.txt")), "untitled.txt");
	await page.waitForSelector('input[aria-label="새 이름"]', { timeout: 5_000 });
	const draft = await page.locator('input[aria-label="새 이름"]').inputValue();
	await page.screenshot({ path: join(EVIDENCE, "2-inline-rename.png") });
	check(
		"the New menu writes untitled.txt and starts the inline rename selected",
		existsSync(join(top, "untitled.txt")) && draft === "untitled.txt",
		`draft=${draft} disk=${listNames(top)}`,
	);
	await page.locator('input[aria-label="새 이름"]').fill("meeting-notes.txt");
	await page.keyboard.press("Enter");
	await waitForDisk(() => existsSync(join(top, "meeting-notes.txt")) && !existsSync(join(top, "untitled.txt")), "rename commit");
	check(
		"committing the inline rename renames the created file on disk",
		existsSync(join(top, "meeting-notes.txt")) && !existsSync(join(top, "untitled.txt")),
		`disk=${listNames(top)}`,
	);

	/* ------------------------------------ 4. Word document is a real package */
	await openBackgroundMenu(page);
	await chooseNew(page, "Word 문서");
	await waitForDisk(() => existsSync(join(top, "untitled.docx")), "untitled.docx");
	const parts = Object.keys(unzipSync(new Uint8Array(await Bun.file(join(top, "untitled.docx")).arrayBuffer())));
	check(
		"Word 문서 writes an OOXML docx package, not an empty stub",
		parts.includes("[Content_Types].xml") && parts.includes("word/document.xml"),
		`parts=${JSON.stringify(parts)}`,
	);
	await page.keyboard.press("Escape");

	/** Names that appeared since `before`; polls the disk. */
	const newNames = (before) => listNames(top).filter((name) => !before.includes(name));
	const waitForNewName = async (before, label) => {
		const deadline = Date.now() + 10_000;
		for (;;) {
			const fresh = newNames(before);
			if (fresh.length > 0) return fresh[0];
			if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
			await new Promise((resolve) => setTimeout(resolve, 120));
		}
	};

	/* ------------------------------ 5. Finders-style collision numbering */
	const before5 = listNames(top);
	await openBackgroundMenu(page);
	await chooseNew(page, "텍스트 파일");
	const firstText = await waitForNewName(before5, "first new text file");
	await page.keyboard.press("Escape");
	check("a new text file is untitled.txt", firstText === "untitled.txt", `new=${firstText} disk=${listNames(top)}`);

	const before5b = listNames(top);
	await openBackgroundMenu(page);
	await chooseNew(page, "텍스트 파일");
	const secondText = await waitForNewName(before5b, "second new text file");
	await page.keyboard.press("Escape");
	check(
		"a taken name falls through to untitled 2.txt",
		secondText === "untitled 2.txt",
		`new=${secondText} disk=${listNames(top)}`,
	);

	/* ---------------------------------- 6. ⌘Z removes the created file */
	const undoBefore = listNames(top).length;
	await page.keyboard.press("Meta+z");
	await waitForDisk(() => !existsSync(join(top, "untitled 2.txt")), "undo of create");
	await page.screenshot({ path: join(EVIDENCE, "3-undo-create.png") });
	check(
		"⌘Z removes the file the New menu created",
		!existsSync(join(top, "untitled 2.txt")) && listNames(top).length === undoBefore - 1,
		`disk=${listNames(top)}`,
	);

	/* ------------------------- 7. sidebar New file button and ⌥⌘N */
	const before7 = listNames(top);
	await page.getByRole("button", { name: "New file", exact: true }).first().click();
	const viaButton = await waitForNewName(before7, "sidebar New file");
	await page.keyboard.press("Escape");
	check("the sidebar New file button creates a text file", viaButton === "untitled 2.txt", `new=${viaButton} disk=${listNames(top)}`);

	await page.locator(".list").click({ position: { x: 40, y: 200 } });
	const before7b = listNames(top);
	// ⌥⌘N is a dead-key chord on macOS, so dispatch the event the app listens for.
	await page.evaluate(() =>
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "n", altKey: true, metaKey: true, bubbles: true })),
	);
	const viaChord = await waitForNewName(before7b, "⌥⌘N text file");
	await page.keyboard.press("Escape");
	check("⌥⌘N creates the next text file", viaChord === "untitled 3.txt", `new=${viaChord} disk=${listNames(top)}`);

	/* ------------------------- 8. ⇧⌘N creates a folder with inline rename */
	await page.locator(".list").click({ position: { x: 40, y: 200 } });
	const before8 = listNames(top);
	await page.keyboard.press("Meta+Shift+n");
	const folderName = await waitForNewName(before8, "⇧⌘N folder");
	await page.screenshot({ path: join(EVIDENCE, "4-shift-cmd-n.png") });
	check("⇧⌘N creates an untitled folder", folderName === "untitled folder", `new=${folderName} disk=${listNames(top)}`);
} catch (error) {
	check("run completed", false, String(error).slice(0, 500));
	if (app !== null) {
		const page = await finderWindow(app).catch(() => null);
		await page?.screenshot({ path: join(EVIDENCE, "failure.png") }).catch(() => undefined);
	}
} finally {
	if (app !== null) await app.close().catch(() => undefined);
}

await Bun.write(join(EVIDENCE, "result.json"), JSON.stringify({ checks: results }, null, 2));
const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
