/**
 * Manual QA — Quick Look on a password-protected PDF (issue #235).
 *
 * Space on an encrypted PDF opens a password prompt in the preview instead of
 * the "cannot open" panel; the typed password unlocks it in place. Run on the
 * production build (`bun run build` first). Keys go through Electron's native
 * input path (`sendInputEvent`), because Playwright's CDP keys skip
 * `before-input-event`, where Quick Look claims Space and the arrows.
 *
 * The fixture is test/fixtures/encrypted-open-sesame.pdf (AES-128, user
 * password "open-sesame"). Read the screenshots in the evidence directory: the
 * assertions read the DOM, the screenshots show what a person sees.
 */

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

const EVIDENCE = process.env.QA_OUT ?? process.argv[2] ?? "/tmp/autorag-quicklook-pdf-password";
mkdirSync(EVIDENCE, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "autorag-ql-pdfpw-"));
copyFileSync(fileURLToPath(new URL("../../test/fixtures/encrypted-open-sesame.pdf", import.meta.url)), join(root, "locked.pdf"));
writeFileSync(join(root, "zz-next.txt"), "the file below the PDF");

const PASSWORD = "open-sesame";
const results = [];
function check(label, pass, detail = "") {
	results.push({ label, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  (${detail})`}`);
}

async function poll(read, accept, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	let value = await read();
	while (!accept(value) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		value = await read();
	}
	return value;
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const app = await launchFinder({ env: { AUTORAG_QA_ROOT: root, AUTORAG_SKIP_DUPEY_CHECK: "1" }, language: process.env.QA_LANGUAGE ?? "en" });
try {
	const main = await finderWindow(app, 30_000);
	const preview = await poll(
		async () => (await app.windows()).find((candidate) => candidate.url().includes("quick-look.html")),
		(candidate) => candidate !== undefined,
		30_000,
	);
	if (preview === undefined) throw new Error("Quick Look window did not pre-warm");
	const state = () =>
		app.evaluate(({ BrowserWindow }) => {
			const all = BrowserWindow.getAllWindows();
			const ql = all.find((item) => item.webContents.getURL().includes("quick-look.html"));
			const finder = all.find((item) => item.webContents.getURL().includes("index.html") && !item.webContents.getURL().includes("quick-look"));
			const bounds = ql?.getBounds() ?? { width: 0, height: 0 };
			return { visible: ql?.isVisible() ?? false, focused: ql?.isFocused() ?? false, finderFocused: finder?.isFocused() ?? false, width: bounds.width, height: bounds.height };
		});
	/** One key through the same path as the keyboard: before-input-event first, then the page. */
	const native = (type, keyCode) =>
		app.evaluate(
			({ BrowserWindow }, arg) => {
				const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("quick-look.html"));
				if (window === undefined) throw new Error("Quick Look window is missing");
				window.webContents.sendInputEvent({ type: arg.type, keyCode: arg.keyCode });
			},
			{ type, keyCode },
		);
	const press = async (keyCode) => {
		await native("keyDown", keyCode);
		await native("keyUp", keyCode);
	};
	/** Enter submits a form on its `keypress`, which the OS sends as a char event after the key down. */
	const enter = async () => {
		await native("keyDown", "Return");
		await native("char", "\r");
		await native("keyUp", "Return");
	};
	async function typeNative(text) {
		for (const character of text) {
			const code = character === " " ? "Space" : character;
			await native("keyDown", code);
			await native("char", character);
			await native("keyUp", code);
		}
	}
	const field = preview.locator("input[type=password]");
	const value = () => field.inputValue();

	async function openLocked() {
		const row = main.getByRole("row", { name: /locked\.pdf/ }).first();
		await row.waitFor({ timeout: 30_000 });
		await row.click();
		await main.keyboard.press("Space");
		await field.waitFor({ timeout: 15_000 });
		await poll(async () => (await state()).visible, Boolean);
		await pause(500);
	}

	// 1. Space on the encrypted PDF asks for the password.
	await openLocked();
	await preview.screenshot({ path: join(EVIDENCE, "1-prompt.png") });
	let text = await preview.locator("body").innerText();
	check("an encrypted PDF shows a password prompt, not the cannot-open panel", (await field.count()) === 1 && !text.includes("Couldn’t open the PDF"));
	check("the prompt says the document is password protected and names the file", text.includes("password protected") && text.includes("locked.pdf"));
	check("the preview window takes focus so the field receives keys", (await state()).focused === true);
	check("the field is focused", await field.evaluate((element) => document.activeElement === element));

	// 2. Space and the arrows belong to the field while it has focus.
	await typeNative("no pe");
	check("a typed Space lands in the field and does not close the preview", (await value()) === "no pe" && (await state()).visible === true, JSON.stringify(await value()));
	await press("Down");
	await press("Up");
	await pause(300);
	text = await preview.locator("body").innerText();
	check("Up and Down do not walk the Finder selection away from the prompt", (await field.count()) === 1 && text.includes("locked.pdf"));

	// 3. A wrong password is refused in place.
	await enter();
	await preview.locator("[role=alert]").waitFor({ timeout: 10_000 });
	await preview.screenshot({ path: join(EVIDENCE, "2-wrong.png") });
	check("a wrong password says so and keeps the prompt", (await preview.locator("[role=alert]").innerText()).includes("incorrect") && (await field.count()) === 1);
	check("the refused password is cleared and the field is focused again", (await value()) === "" && (await field.evaluate((element) => document.activeElement === element)));

	// 4. The right password unlocks it in place.
	await typeNative(PASSWORD);
	await preview.screenshot({ path: join(EVIDENCE, "3-typed.png") });
	const promptSize = await state();
	await preview.getByRole("button", { name: "Unlock" }).click();
	const drawn = await poll(
		() =>
			preview
				.evaluate(() => {
					const canvas = document.querySelector("canvas");
					if (canvas === null || canvas.width === 0) return false;
					const data = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
					if (data === undefined) return false;
					for (let index = 0; index < data.length; index += 4) if (data[index] < 200) return true;
					return false;
				})
				.catch(() => false),
		Boolean,
		15_000,
	);
	await pause(500);
	await preview.screenshot({ path: join(EVIDENCE, "4-unlocked.png") });
	check("the right password renders the page (non-blank canvas)", drawn === true);
	check("the prompt is gone once unlocked", (await field.count()) === 0);
	await poll(async () => (await state()).height > promptSize.height, Boolean, 5000);
	const pageSize = await state();
	check("the window grows from the prompt to the page", pageSize.height > promptSize.height, `${promptSize.width}x${promptSize.height} -> ${pageSize.width}x${pageSize.height}`);

	// 5. The page owns its keys again: Space closes, and Finder gets focus back.
	await press("Space");
	await poll(async () => (await state()).visible === false, Boolean);
	check("Space closes the unlocked preview", (await state()).visible === false);
	check("focus returns to the Finder", (await poll(async () => (await state()).finderFocused, Boolean, 3000)) === true);

	// 6. Nothing is remembered: the next preview asks again. Escape closes even from the field.
	await openLocked();
	check("reopening asks for the password again", (await field.count()) === 1);
	await typeNative("x");
	await press("Escape");
	await poll(async () => (await state()).visible === false, Boolean);
	check("Escape closes the prompt while typing", (await state()).visible === false);
} finally {
	await app.close();
	rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
