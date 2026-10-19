/**
 * Manual QA — time to first content for a legacy Office file (issue #139).
 *
 * Space on a `.ppt`/`.doc` must show something real, even when the OS preview
 * service has gone idle (it takes 2-5s to wake). The only time limit is a hang
 * ceiling (`QA_FIRST_BUDGET_MS`); the timings are printed for a human. The lane
 * drives the production build (`bun run build` first): it selects the file with
 * a real click, waits like a person (`QA_DWELL_MS`, default 800ms), presses
 * Space, and measures from the key press to the first painted content of each
 * kind: the OS first-page image, then the whole drawn page. A second pass opens
 * the file with no selection dwell and after an idle gap, which is the case a
 * prefetch cannot help.
 *
 *   QA_OFFICE_DIR=<folder with real-*.doc / real-*.ppt> bun scripts/manual-qa/run-qa-quick-look-office-latency.mjs
 */

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

const SOURCE = process.env.QA_OFFICE_DIR;
if (SOURCE === undefined) throw new Error("set QA_OFFICE_DIR to a folder holding real-*.doc / real-*.ppt files");
const EVIDENCE = process.env.QA_OUT ?? process.argv[2] ?? "/tmp/autorag-quicklook-office-latency";
const DWELL_MS = Number(process.env.QA_DWELL_MS ?? 800);
const FIRST_CONTENT_BUDGET_MS = Number(process.env.QA_FIRST_BUDGET_MS ?? 30_000);
const BLANK_COLOURS = 4;
const IDLE_MS = Number(process.env.QA_IDLE_MS ?? 25_000);
mkdirSync(EVIDENCE, { recursive: true });

const root = mkdtempSync(join(tmpdir(), "autorag-ql-latency-"));
const names = readdirSync(SOURCE).filter((name) => /^real-.*\.(doc|ppt)$/i.test(name));
if (names.length === 0) throw new Error(`no real-*.doc/ppt files in ${SOURCE}`);
for (const name of names) copyFileSync(join(SOURCE, name), join(root, name));
// Never-opened copies for the cold pass: the app caches every page it has drawn, so reopening a file would not be cold.
const coldNames = names.map((name) => `cold-${name}`);
for (const name of names) copyFileSync(join(SOURCE, name), join(root, `cold-${name}`));

const results = [];
function check(label, pass, detail = "") {
	results.push({ label, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  (${detail})`}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const app = await launchFinder({ env: { AUTORAG_QA_ROOT: root, AUTORAG_SKIP_DUPEY_CHECK: "1" } });
try {
	const main = await finderWindow(app, 30_000);
	let preview;
	for (let i = 0; i < 300 && preview === undefined; i += 1) {
		preview = (await app.windows()).find((candidate) => candidate.url().includes("quick-look.html"));
		if (preview === undefined) await sleep(100);
	}
	if (preview === undefined) throw new Error("Quick Look window did not pre-warm");
	const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((item) => item.webContents.getURL().includes("quick-look.html") && item.isVisible()));

	/** What the panel shows right now: the OS first-page image, the drawn page, or the extracted text. */
	const shape = () =>
		preview
			.evaluate(() => {
				const image = document.querySelector(".ql__office img.ql__image");
				const frame = document.querySelector("iframe.ql__frame");
				const text = document.querySelector(".ql__legacy");
				return {
					image: image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
					frame: frame instanceof HTMLIFrameElement && getComputedStyle(frame).opacity === "1",
					text: text !== null && (text.textContent ?? "").length > 20,
				};
			})
			.catch(() => ({ image: false, frame: false, text: false }));
	/** Distinct colours in the panel body. A blank panel has one or two; a white page of text has about ten (white, black, anti-aliasing greys). */
	const paint = async () => {
		const png = await preview.screenshot({ clip: { x: 0, y: 60, width: 300, height: 300 } });
		return app.evaluate(({ nativeImage }, base64) => {
			const bitmap = nativeImage.createFromBuffer(Buffer.from(base64, "base64")).getBitmap();
			const colours = new Set();
			for (let index = 0; index + 2 < bitmap.length; index += 4 * 53) colours.add((bitmap[index] >> 4) * 256 + (bitmap[index + 1] >> 4) * 16 + (bitmap[index + 2] >> 4));
			return colours.size;
		}, png.toString("base64"));
	};

	/** Presses Space and records, from that key press, when each kind of content first stands on screen. */
	async function openAndMeasure(name, { dwell, watchBlank }) {
		const row = main.getByRole("row", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first();
		await row.waitFor({ timeout: 30_000 });
		await row.click();
		if (dwell > 0) await sleep(dwell);
		const pressed = Date.now();
		await main.keyboard.press("Space");
		const at = { shown: null, image: null, frame: null, text: null };
		const blanks = [];
		let last = "";
		while (Date.now() - pressed < 30_000 && at.frame === null) {
			const elapsed = Date.now() - pressed;
			if (at.shown === null && (await visible())) at.shown = elapsed;
			const now = await shape();
			if (at.image === null && now.image) at.image = elapsed;
			if (at.text === null && now.text) at.text = elapsed;
			if (now.frame) at.frame = elapsed;
			const key = `${now.image}/${now.frame}/${now.text}`;
			if (watchBlank && key !== last && at.shown !== null && (now.image || now.frame || now.text)) {
				last = key;
				blanks.push({ state: key, colours: await paint() });
			}
			await sleep(15);
		}
		return { at, blanks };
	}
	async function close() {
		await main.keyboard.press("Space");
		for (let i = 0; i < 100 && (await visible()); i += 1) await sleep(50);
		await sleep(300);
	}

	for (const name of names) {
		const { at, blanks } = await openAndMeasure(name, { dwell: DWELL_MS, watchBlank: true });
		const early = [at.image, at.frame].filter((value) => value !== null);
		const firstPage = early.length === 0 ? null : Math.min(...early);
		console.log(`      ${name}: window ${at.shown} ms, text ${at.text} ms, first-page image ${at.image} ms, full page ${at.frame} ms (all from Space)`);
		check(`${name}: a real page image is on screen within the ${FIRST_CONTENT_BUDGET_MS} ms hang ceiling of Space (selected ${DWELL_MS} ms earlier)`, firstPage !== null && firstPage <= FIRST_CONTENT_BUDGET_MS, `${firstPage} ms`);
		check(`${name}: the full drawn page replaces it`, at.frame !== null, `${at.frame} ms`);
		check(`${name}: the panel never goes blank while it changes`, blanks.length > 0 && blanks.every((entry) => entry.colours > BLANK_COLOURS), JSON.stringify(blanks));
		await preview.screenshot({ path: join(EVIDENCE, `${name}-after-open.png`) });
		await close();
	}

	// The case a prefetch cannot help: no selection dwell, and the OS service idle.
	console.log(`      idling ${IDLE_MS} ms so the OS preview service goes cold`);
	await sleep(IDLE_MS);
	for (const name of coldNames) {
		const { at, blanks } = await openAndMeasure(name, { dwell: 0, watchBlank: true });
		console.log(`      ${name}, cold OS service, no dwell: window ${at.shown} ms, text ${at.text} ms, image ${at.image} ms, full page ${at.frame} ms`);
		check(`${name}: cold service, no dwell: the window is up within the ${FIRST_CONTENT_BUDGET_MS} ms hang ceiling of Space`, at.shown !== null && at.shown <= FIRST_CONTENT_BUDGET_MS, `${at.shown} ms`);
		check(`${name}: cold service, no dwell: the full page still arrives`, at.frame !== null, `${at.frame} ms`);
		check(`${name}: cold service, no dwell: never blank`, blanks.every((entry) => entry.colours > BLANK_COLOURS), JSON.stringify(blanks));
		await close();
		await sleep(IDLE_MS);
	}
} finally {
	await app.close();
	rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
