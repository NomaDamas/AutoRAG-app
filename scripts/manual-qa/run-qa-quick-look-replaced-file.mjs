/**
 * Manual QA — Quick Look shows a file's current content after it is replaced
 * in place (same path and name, new bytes).
 *
 * The Quick Look window is one long-lived page, and Chromium keeps decoded
 * pictures by URL for the life of a page: with a URL that only named the path,
 * Space showed the old picture while the Finder's thumbnail and the Inspector
 * already showed the new one. Drives the production build (`bun run build`
 * first). Every scenario starts on its own red 320x240 PNG, rewrites it as a
 * blue 200x150 one, and reads what the panel decoded (size) and drew (pixels).
 * Before the fix each scenario showed the red picture.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

const EVIDENCE = process.env.QA_OUT ?? process.argv[2] ?? "/tmp/autorag-quicklook-replaced-file";
mkdirSync(EVIDENCE, { recursive: true });

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let value = n;
		for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		table[n] = value >>> 0;
	}
	return table;
})();

function crc32(bytes) {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
	return Buffer.concat([head, data, crc]);
}

/** A PNG of one solid colour. */
function solidPng(width, height, [r, g, b]) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const row = Buffer.alloc(1 + width * 3);
	for (let x = 0; x < width; x += 1) row.set([r, g, b], 1 + x * 3);
	const raw = Buffer.concat(Array.from({ length: height }, () => row));
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

const RED = { width: 320, height: 240, rgb: [230, 20, 20], name: "red 320x240" };
const BLUE = { width: 200, height: 150, rgb: [20, 20, 230], name: "blue 200x150" };
const SCENARIOS = ["s1", "s2", "s3", "s4", "s5", "s6"];

const results = [];
function check(label, pass, detail = "") {
	results.push({ label, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  (${detail})`}`);
}

async function poll(read, accept, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let value = await read();
	while (!accept(value) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		value = await read();
	}
	return value;
}

const root = mkdtempSync(join(tmpdir(), "autorag-ql-replaced-"));
const home = mkdtempSync(join(tmpdir(), "autorag-ql-replaced-home-"));
for (const name of SCENARIOS) writeFileSync(join(root, `${name}.png`), solidPng(RED.width, RED.height, RED.rgb));

/** Rewrites `<name>.png` in place as the blue version. */
function replace(name) {
	writeFileSync(join(root, `${name}.png`), solidPng(BLUE.width, BLUE.height, BLUE.rgb));
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What the panel shows: the decoded size of its picture and the colour at the
 * centre of the visible window. The colour is read from a capture in main; the
 * page cannot read it back, because the picture comes from another origin
 * (`autorag-preview://`) and taints a canvas. Null while no picture is decoded.
 */
async function shown(app, preview) {
	const size = await preview
		.evaluate(() => {
			const image = document.querySelector(".ql__image");
			return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 ? [image.naturalWidth, image.naturalHeight] : null;
		})
		.catch(() => null);
	if (size === null) return null;
	const rgb = await app.evaluate(async ({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("quick-look.html") && item.isVisible());
		if (window === undefined) return null;
		const image = await window.webContents.capturePage();
		const { width, height } = image.getSize();
		const pixel = image.crop({ x: width >> 1, y: Math.round(height * 0.6), width: 1, height: 1 }).toBitmap();
		// toBitmap is BGRA.
		return [pixel[2], pixel[1], pixel[0]];
	});
	return { size, rgb };
}

function matches(view, version) {
	if (view === null || view.rgb === null) return false;
	const [w, h] = view.size;
	const close = view.rgb.every((channel, index) => Math.abs(channel - version.rgb[index]) < 60);
	return w === version.width && h === version.height && close;
}

const describe = (view) => (view === null ? "nothing decoded" : `${view.size.join("x")} rgb(${view.rgb?.join(",") ?? "?"})`);

const app = await launchFinder({ env: { AUTORAG_QA_ROOT: root, AUTORAG_SKIP_DUPEY_CHECK: "1", HOME: home } });
try {
	const main = await finderWindow(app, 30_000);
	const preview = await poll(
		async () => (await app.windows()).find((candidate) => candidate.url().includes("quick-look.html")),
		(candidate) => candidate !== undefined,
		30_000,
	);
	if (preview === undefined) throw new Error("Quick Look window did not pre-warm");
	const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((item) => item.webContents.getURL().includes("quick-look.html") && item.isVisible()));

	const row = (name) => main.getByRole("row", { name: new RegExp(`${name}\\.png`) }).first();
	await row("s1").waitFor({ timeout: 60_000 });
	const open = async (name) => {
		await row(name).click();
		await main.keyboard.press("Space");
		const view = await poll(() => shown(app, preview), (value) => matches(value, RED), 8000);
		if (!matches(view, RED)) throw new Error(`${name}: the first open showed ${describe(view)}`);
	};
	const close = async () => {
		await main.keyboard.press("Space");
		await poll(visible, (value) => value === false, 5000);
		await sleep(300);
	};
	const expectFresh = async (label, shot) => {
		const view = await poll(() => shown(app, preview), (value) => matches(value, BLUE), 5000);
		check(label, matches(view, BLUE), `want ${BLUE.name}, got ${describe(view)}`);
		await preview.screenshot({ path: join(EVIDENCE, shot) });
	};
	const reopen = async (name, label, shot) => {
		await row(name).click();
		await main.keyboard.press("Space");
		await expectFresh(label, shot);
		await close();
	};

	// The reported case: the panel has focus while the file is rewritten; close it from the panel, Space again.
	await open("s1");
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("quick-look.html"))?.focus());
	await sleep(300);
	replace("s1");
	await sleep(2000);
	await main.screenshot({ path: join(EVIDENCE, "s1-finder-after-replace.png") });
	await preview.keyboard.press("Escape");
	await poll(visible, (value) => value === false, 5000);
	if (await visible()) await close();
	await sleep(300);
	await reopen("s1", "panel focused, file replaced, closed, Space again", "s1-reopened.png");

	await open("s2");
	replace("s2");
	await sleep(2000);
	await close();
	await reopen("s2", "replaced while open, closed, Space again", "s2-reopened.png");

	await open("s3");
	await close();
	replace("s3");
	await sleep(2000);
	await reopen("s3", "replaced while closed, Space again", "s3-reopened.png");

	await open("s4");
	replace("s4");
	await sleep(2000);
	await main.keyboard.press("ArrowDown");
	await sleep(800);
	await main.keyboard.press("ArrowUp");
	await expectFresh("replaced while open, arrow away and back", "s4-arrow-back.png");
	await close();

	await open("s5");
	await close();
	replace("s5");
	await open("s6");
	await close();
	await sleep(5000);
	await reopen("s5", "replaced, another file previewed, Space again later", "s5-reopened.png");
} finally {
	await app.close();
	rmSync(root, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
