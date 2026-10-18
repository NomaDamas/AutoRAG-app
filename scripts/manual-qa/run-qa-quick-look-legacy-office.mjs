/**
 * Manual QA — legacy Office files (issue #139).
 *
 * Space on `.doc`/`.dot`/`.ppt`/`.pps`/`.pot` must show the page macOS's own
 * Office generator draws (fonts, tables, slides, pictures) in a sandboxed
 * frame, with a toolbar switch to the extracted text, instead of the "Other"
 * info panel, a password-protected or non-Word file must fall
 * back to that panel with a clear note, and `.doc`/`.ppt`/`.xls` tiles must
 * show the OS first-page thumbnail. Drives the production build (`bun run
 * build` first) with real Space presses and clicks on files built in-script
 * with the test fixture builders, plus real files named in `QA_LEGACY_DIR`
 * (any folder holding .doc/.ppt/.xls files).
 */

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPowerPoint, buildWordDocument } from "../../test/support/legacy-office-fixture.ts";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

const EVIDENCE = process.env.QA_OUT ?? process.argv[2] ?? "/tmp/autorag-quicklook-legacy-office";
mkdirSync(EVIDENCE, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "autorag-ql-legacy-"));

const write = (name, bytes) => writeFileSync(join(root, name), bytes);
write("Report.doc", buildWordDocument([{ text: "분기 보고서 Quarterly\r" }, { text: "caf\u00e9 \u201cquoted\u201d line\r", compressed: true }, { text: "A\u0007B\u0007\u0007row two\r\u000cSECOND-PAGE-MARKER\r" }]));
write("Template.dot", buildWordDocument([{ text: "TEMPLATE-BODY\r" }], { tableStream: "0Table" }));
write("Locked.doc", buildWordDocument([{ text: "secret\r" }], { encrypted: true }));
write("Actually Rich.doc", Buffer.from("{\\rtf1\\ansi RTF-INSIDE-DOC\\par}"));
write("Plan.ppt", buildPowerPoint([{ boxes: [{ text: "ALPHA-TITLE", title: true }, { text: "first bullet\rsecond bullet" }] }, { boxes: [{ text: "한국어 슬라이드", title: true }] }], { edits: [{ replace: { 1: { boxes: [{ text: "BRAVO-NEWEST", title: true }] } } }] }));
write("Show.pps", buildPowerPoint([{ boxes: [{ text: "SHOW-ONLY", title: true }] }]));
write("Locked.ppt", buildPowerPoint([{ boxes: [{ text: "x", title: true }] }], { encrypted: true }));

const realDir = process.env.QA_LEGACY_DIR;
const real = [];
if (realDir !== undefined) {
	for (const name of readdirSync(realDir)) {
		if (!/\.(doc|ppt|xls)$/i.test(name)) continue;
		copyFileSync(join(realDir, name), join(root, `real-${name}`));
		real.push(`real-${name}`);
	}
}

const results = [];
function check(label, pass, detail = "") {
	results.push({ label, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  (${detail})`}`);
}
async function poll(read, accept, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	let value = await read();
	while (!accept(value) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 60));
		value = await read();
	}
	return value;
}

const app = await launchFinder({ env: { AUTORAG_QA_ROOT: root, AUTORAG_SKIP_DUPEY_CHECK: "1" }, language: "en" });
try {
	const main = await finderWindow(app, 30_000);
	const preview = await poll(
		async () => (await app.windows()).find((candidate) => candidate.url().includes("quick-look.html")),
		(candidate) => candidate !== undefined,
		30_000,
	);
	if (preview === undefined) throw new Error("Quick Look window did not pre-warm");
	const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((item) => item.webContents.getURL().includes("quick-look.html") && item.isVisible()));
	const rowFor = (name) => main.getByRole("row", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first();

	async function open(name) {
		const row = rowFor(name);
		await row.waitFor({ timeout: 30_000 });
		await row.click();
		await main.keyboard.press("Space");
		await poll(visible, Boolean, 10_000);
		await new Promise((resolve) => setTimeout(resolve, 700));
		return poll(() => preview.evaluate(() => document.querySelector(".ql__stage")?.textContent ?? "").catch(() => ""), (text) => text.length > 0, 8000);
	}
	async function close() {
		await main.keyboard.press("Space");
		await poll(async () => (await visible()) === false, Boolean, 5000);
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	const cards = () => preview.locator(".ql__legacy section").count();
	/** The page frame's HTML, fetched from its blob URL (the frame is sandboxed, so the page cannot be reached from inside). */
	const frame = () =>
		preview
			.evaluate(async () => {
				const src = document.querySelector("iframe.ql__frame")?.getAttribute("src");
				return src === null || src === undefined ? "" : await (await fetch(src)).text();
			})
			.catch(() => "");
	const frameState = async () => {
		const info = await preview
			.evaluate(() => {
				const el = document.querySelector("iframe.ql__frame");
				return el === null ? null : { sandbox: el.getAttribute("sandbox"), src: el.getAttribute("src") ?? "" };
			})
			.catch(() => null);
		if (info === null) return null;
		const html = await frame();
		return { sandbox: info.sandbox, blob: info.src.startsWith("blob:"), imgs: html.match(/<img\b[^>]*src="data:image/g)?.length ?? 0, remote: /src="https?:/i.test(html), csp: /Content-Security-Policy/.test(html) };
	};
	const toText = async () => {
		await preview.getByRole("button", { name: "Text", exact: true }).click();
		await new Promise((resolve) => setTimeout(resolve, 400));
		return preview.evaluate(() => document.querySelector(".ql__stage")?.textContent ?? "");
	};
	const shot = (name) => preview.screenshot({ path: join(EVIDENCE, `${name.replace(/[^\w.-]/g, "_")}.png`) });

	// The built fixtures are minimal Word/PowerPoint streams that macOS's own
	// generator refuses to draw; the panel must fall back to the extracted text
	// (no frame, no mode switch) rather than show nothing.
	let text = await open("Report.doc");
	check("a file the OS cannot draw falls back to extracted text, with no frame", (await frameState()) === null && text.includes("분기 보고서 Quarterly"), text.slice(0, 60));
	check("the fallback text keeps both pieces", text.includes("분기 보고서 Quarterly") && text.includes("café “quoted” line"), text.slice(0, 80));
	check("table cells arrive as one tab-separated row", /A\s+B/.test(text) && text.includes("row two"), "");
	check("a page break makes a second card", (await cards()) === 2 && text.includes("SECOND-PAGE-MARKER"), String(await cards()));
	check("the panel says it is text only", text.includes("Showing text only"), "");
	await shot("Report.doc");
	await close();

	text = await open("Template.dot");
	check("Template.dot (0Table) shows its text", text.includes("TEMPLATE-BODY"), text.slice(0, 60));
	await close();

	text = await open("Locked.doc");
	check("an encrypted .doc falls back with a clear note", text.includes("password-protected"), text.slice(0, 120));
	await shot("Locked.doc");
	await close();

	text = await open("Actually Rich.doc");
	check("an RTF saved as .doc is rendered by the RTF viewer", text.includes("RTF-INSIDE-DOC") && (await frameState()) === null, text.slice(0, 60));
	await close();

	text = await open("Plan.ppt");
	check("Plan.ppt (not drawable by the OS) falls back to extracted text", (await frameState()) === null, "");
	check("Plan.ppt lists the slides with their titles", text.includes("ALPHA-TITLE") && text.includes("first bullet") && text.includes("second bullet"), text.slice(0, 100));
	check("a fast-saved slide shows its newest text", text.includes("BRAVO-NEWEST") && !text.includes("한국어 슬라이드"), "");
	check("two slide cards", (await cards()) === 2, String(await cards()));
	await shot("Plan.ppt");
	await close();

	text = await open("Show.pps");
	check("Show.pps shows its slide", text.includes("SHOW-ONLY"), text.slice(0, 60));
	await close();

	text = await open("Locked.ppt");
	check("an encrypted .ppt falls back with a clear note", text.includes("password-protected"), text.slice(0, 120));
	await close();

	for (const name of real) {
		text = await open(name);
		const state = await frameState();
		if (/\.xls$/i.test(name)) {
			check(`${name}: real file previews`, !/can’t be previewed|damaged|no text/i.test(text) && text.length > 40, text.replace(/\s+/g, " ").slice(0, 100));
		} else {
			check(`${name}: real file opens as the OS-drawn page`, state !== null && state.sandbox === "" && state.csp && !state.remote, JSON.stringify(state));
			if (/\.ppt$/i.test(name)) {
				check(`${name}: slide pictures are inlined`, state !== null && state.imgs > 0, String(state?.imgs));
				// The slides must actually paint: a collapsed slide leaves only the grey page background.
				const png = await preview.locator("iframe.ql__frame").screenshot();
				const paint = await app.evaluate(({ nativeImage }, base64) => {
					const bitmap = nativeImage.createFromBuffer(Buffer.from(base64, "base64")).getBitmap();
					const colors = new Set();
					for (let index = 0; index + 2 < bitmap.length; index += 4 * 97) colors.add((bitmap[index] >> 4) * 256 + (bitmap[index + 1] >> 4) * 16 + (bitmap[index + 2] >> 4));
					return colors.size;
				}, png.toString("base64"));
				check(`${name}: the slides paint real content, not an empty page`, paint > 12, `${paint} distinct colours`);
			}
			await shot(name);
			const extracted = await toText();
			check(`${name}: the Text switch shows extracted text`, extracted.length > 100 && /Showing text only/.test(extracted), extracted.replace(/\s+/g, " ").slice(0, 80));
		}
		await shot(`${name}-last`);
		await close();
	}

	// Tile thumbnails: first-page image from the OS, not the letter tile.
	for (const name of real) {
		const row = rowFor(name);
		await row.scrollIntoViewIfNeeded().catch(() => undefined);
		const tile = await row
			.locator("img.tile--image")
			.waitFor({ timeout: 30_000 })
			.then(() => true)
			.catch(() => false);
		check(`${name}: Finder tile shows the OS thumbnail`, tile, "");
	}
} finally {
	await app.close();
	rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
