/**
 * Manual QA — copied Finder rows paste as FILES in other apps.
 *
 * Drives the production Electron app (out/) against a fixture folder in a
 * throwaway HOME. ⌘C on rows must put the files themselves on the OS clipboard
 * (not their paths as text), so a browser/chat/Finder pastes the image, while
 * the in-app ⌘V / ⌘X-⌘V still copy and move the files:
 *
 *   1. ⌘C on one image: a web page's `paste` event receives that image as a
 *      File with the right bytes, and no path text;
 *   2. ⌘C on two rows: both arrive as Files, in order;
 *   3. (macOS) the real NSPasteboard lists both as file URLs;
 *   4. ⌘V in another folder still copies the same rows on disk;
 *   5. ⌘X then ⌘V still moves the row, and the OS clipboard carries it too;
 *   6. ⌘C in the sidebar search field leaves the OS clipboard to the field.
 *
 * Run from the repo root after `bun run build`:
 * `bun scripts/manual-qa/run-qa-finder-os-clipboard.mjs`
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { chord, cssAttr } from "./platform.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = join(ROOT, ".omo", "evidence", "ai-finder-app", "qa-os-clipboard");
mkdirSync(EVIDENCE, { recursive: true });

// 2x2 PNGs with distinct pixels so the pasted bytes identify the source file.
const PNG_RED = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==", "base64");
const PNG_BLUE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNgYPgPRmAKABf2A/1+6zfzAAAAAElFTkSuQmCC", "base64");

const home = mkdtempSync(join(tmpdir(), "ulw-osclip-home-"));
const top = join(home, "Documents", "qa-os-clipboard");
const dest = join(top, "dest");
mkdirSync(dest, { recursive: true });
const RED = join(top, "red 사진 #1.png");
const BLUE = join(top, "blue.png");
const MOVER = join(top, "mover.png");
writeFileSync(RED, PNG_RED);
writeFileSync(BLUE, PNG_BLUE);
writeFileSync(MOVER, PNG_RED);

const results = [];
const check = (name, pass, detail) => {
	results.push({ name, pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
};
const row = (page, path) => page.locator(`[data-path="${cssAttr(path)}"]`);
const atTitle = (page, name) =>
	page.waitForFunction((want) => document.querySelector(".toolbar-title")?.textContent === want, name, { timeout: 15_000 });

/**
 * What another application sees on ⌘V: a second, unrelated window pastes the
 * system clipboard into a contenteditable and reports the `paste` event's
 * files (name, bytes as base64) and text.
 */
async function pasteIntoForeignWindow(app) {
	return app.evaluate(async ({ BrowserWindow }) => {
		const win = new BrowserWindow({ show: true, width: 400, height: 300, webPreferences: { sandbox: true } });
		await win.loadURL(
			"data:text/html," +
				encodeURIComponent(
					`<div id=box contenteditable style="width:300px;height:200px"></div><script>
					window.pasted = new Promise((resolve) => document.getElementById("box").addEventListener("paste", async (event) => {
						const files = await Promise.all([...event.clipboardData.files].map(async (file) => {
							const bytes = new Uint8Array(await file.arrayBuffer());
							let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
							return { name: file.name, type: file.type, base64: btoa(bin) };
						}));
						resolve({ files, text: event.clipboardData.getData("text/plain"), types: [...event.clipboardData.types] });
					}));
					</script>`,
				),
		);
		win.focus();
		await win.webContents.executeJavaScript("document.getElementById('box').focus()");
		win.webContents.paste();
		const result = await Promise.race([
			win.webContents.executeJavaScript("window.pasted"),
			new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 8000)),
		]);
		win.destroy();
		return result;
	});
}

/** macOS only: the file URLs the real general NSPasteboard offers (macOS hands names back decomposed, hence the NFC compare). */
function pasteboardFiles() {
	return JSON.parse(
		execFileSync("osascript", [
			"-l",
			"JavaScript",
			"-e",
			`ObjC.import("AppKit"); const o=$.NSPasteboard.generalPasteboard.readObjectsForClassesOptions($([$.NSURL]), $({NSPasteboardURLReadingFileURLsOnlyKey:true})); const r=[]; if(o){for(let i=0;i<o.count;i++) r.push(ObjC.unwrap(o.objectAtIndex(i).path));} JSON.stringify(r)`,
		]).toString(),
	);
}

let app = null;
try {
	console.log(`fixture: ${top}`);
	app = await launchFinder({
		userDataDir: mkdtempSync(join(tmpdir(), "ulw-osclip-data-")),
		env: { HOME: home, AUTORAG_QA_ROOT: top },
	});
	const page = await finderWindow(app, 30_000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
	await page.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
	await page.waitForSelector(".toolbar-title", { timeout: 30_000 });
	await atTitle(page, "qa-os-clipboard");
	await row(page, RED).first().waitFor({ state: "visible", timeout: 15_000 });

	/* ------------------------------------------- 1. one image pastes as an image */
	await row(page, RED).click();
	await page.keyboard.press(chord("c"));
	await page.waitForTimeout(500);
	const one = await pasteIntoForeignWindow(app);
	const redOk = one.files?.length === 1 && one.files[0].type === "image/png" && one.files[0].base64 === PNG_RED.toString("base64");
	check("⌘C on an image pastes that image as a File in another window", redOk, JSON.stringify({ ...one, files: one.files?.map((f) => `${f.name}:${f.type}:${f.base64.length}`) }));
	check(
		"the pasted payload carries no filesystem path as text",
		typeof one.text === "string" && !one.text.includes(top) && !one.text.includes("/"),
		`text=${JSON.stringify(one.text)}`,
	);
	await page.screenshot({ path: join(EVIDENCE, "1-copy-one.png") });

	/* ----------------------------------------------- 2. two rows paste as two files */
	await row(page, RED).click();
	await row(page, BLUE).click({ modifiers: ["Meta"] });
	await page.keyboard.press(chord("c"));
	await page.waitForTimeout(500);
	const two = await pasteIntoForeignWindow(app);
	check(
		"⌘C on two rows pastes both as Files, in order",
		two.files?.length === 2 && two.files[0].base64 === PNG_RED.toString("base64") && two.files[1].base64 === PNG_BLUE.toString("base64"),
		JSON.stringify(two.files?.map((f) => f.name)),
	);

	/* ------------------------------------------------ 3. the real OS pasteboard */
	if (process.platform === "darwin") {
		const urls = pasteboardFiles();
		check("macOS NSPasteboard lists both files as file URLs", urls.length === 2 && urls[0].normalize("NFC") === RED.normalize("NFC") && urls[1] === BLUE, JSON.stringify(urls));
	}

	/* ---------------------------------------------- 4. in-app ⌘V still copies */
	await row(page, dest).dblclick();
	await atTitle(page, "dest");
	await page.keyboard.press(chord("v"));
	await row(page, join(dest, "blue.png")).first().waitFor({ state: "visible", timeout: 15_000 });
	check(
		"in-app ⌘V still copies the rows (sources stay)",
		existsSync(join(dest, "blue.png")) && existsSync(join(dest, "red 사진 #1.png")) && existsSync(RED) && existsSync(BLUE) && readFileSync(join(dest, "blue.png")).equals(PNG_BLUE),
		`dest=${JSON.stringify(readdirSync(dest).sort())}`,
	);
	await page.screenshot({ path: join(EVIDENCE, "2-in-app-paste.png") });

	/* ------------------------------------------------ 5. in-app cut + paste moves */
	await page.locator("nav.pathbar .path-seg", { hasText: "qa-os-clipboard" }).first().click();
	await atTitle(page, "qa-os-clipboard");
	await row(page, MOVER).click();
	await page.keyboard.press(chord("x"));
	await page.waitForTimeout(500);
	const cut = await pasteIntoForeignWindow(app);
	check("⌘X also hands the file to other apps", cut.files?.length === 1 && cut.files[0].base64 === PNG_RED.toString("base64"), JSON.stringify(cut.files?.map((f) => f.name)));
	await row(page, dest).dblclick();
	await atTitle(page, "dest");
	await page.keyboard.press(chord("v"));
	await row(page, join(dest, "mover.png")).first().waitFor({ state: "visible", timeout: 15_000 });
	check("in-app ⌘X then ⌘V still moves the row", existsSync(join(dest, "mover.png")) && !existsSync(MOVER), `dest=${JSON.stringify(readdirSync(dest).sort())}`);

	/* ---------------------------------- 6. a text field keeps its own copy/paste */
	await page.locator("nav.pathbar .path-seg", { hasText: "qa-os-clipboard" }).first().click();
	await atTitle(page, "qa-os-clipboard");
	await row(page, BLUE).click();
	await page.keyboard.press(chord("c"));
	await page.waitForTimeout(300);
	const field = page.locator(".side-search input");
	await field.click();
	await page.keyboard.type("hello-field");
	await page.keyboard.press(chord("a"));
	await page.keyboard.press(chord("c"));
	await page.waitForTimeout(500);
	const fromField = await pasteIntoForeignWindow(app);
	check(
		"⌘C inside a text field copies its text, not the selected row",
		(fromField.files?.length ?? 0) === 0 && fromField.text === "hello-field",
		`files=${fromField.files?.length} text=${JSON.stringify(fromField.text)}`,
	);
	await page.keyboard.press("Escape");
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
