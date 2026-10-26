/**
 * Manual QA — paged Keynote (`.key`) Quick Look.
 *
 * A Keynote deck must show every slide in show order in the PDF panel's paged
 * layout: paper cards in one column, a page rail, a `N / M` pill, and zoom.
 * Builds a five-slide fixture whose file names sort out of show order, plus a
 * real multi-slide deck, drives the production build (`bun run build` first),
 * opens each with Space, and checks the DOM and the rendered pixels.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { deflateSync } from "node:zlib";
import { zipSync } from "fflate";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { convertImage } from "./platform.mjs";

const EVIDENCE = process.argv[2] ?? "/tmp/autorag-quicklook-keynote";
mkdirSync(EVIDENCE, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "autorag-ql-keynote-"));

// --- five distinctly coloured, numbered slide JPEGs -------------------------

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

const FONT = {
	1: ["010", "110", "010", "010", "111"],
	2: ["111", "001", "111", "100", "111"],
	3: ["111", "001", "111", "001", "111"],
	4: ["101", "101", "111", "001", "001"],
	5: ["111", "100", "111", "001", "111"],
};

/** A 640×360 truecolour PNG: a white digit on a solid background. */
function slidePng(digit, background) {
	const width = 640;
	const height = 360;
	const rows = Buffer.alloc((width * 3 + 1) * height);
	const scale = 48;
	const originX = Math.floor((width - 3 * scale) / 2);
	const originY = Math.floor((height - 5 * scale) / 2);
	for (let y = 0; y < height; y += 1) {
		const start = y * (width * 3 + 1);
		for (let x = 0; x < width; x += 1) {
			const cellX = Math.floor((x - originX) / scale);
			const cellY = Math.floor((y - originY) / scale);
			const ink = cellX >= 0 && cellX < 3 && cellY >= 0 && cellY < 5 && FONT[digit][cellY][cellX] === "1";
			const offset = start + 1 + x * 3;
			rows[offset] = ink ? 255 : background[0];
			rows[offset + 1] = ink ? 255 : background[1];
			rows[offset + 2] = ink ? 255 : background[2];
		}
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(rows)), pngChunk("IEND", Buffer.alloc(0))]);
}

const SLIDES = [
	{ digit: "1", background: [192, 57, 43] },
	{ digit: "2", background: [41, 128, 185] },
	{ digit: "3", background: [39, 174, 96] },
	{ digit: "4", background: [142, 68, 173] },
	{ digit: "5", background: [211, 84, 0] },
];
const jpegs = SLIDES.map(({ digit, background }, index) => {
	const pngPath = join(root, `slide${index + 1}.png`);
	const jpegPath = join(root, `slide${index + 1}.jpg`);
	writeFileSync(pngPath, slidePng(digit, background));
	convertImage(pngPath, jpegPath);
	rmSync(pngPath);
	return new Uint8Array(readFileSync(jpegPath));
});

// --- a hand-built Index/Document.iwa: five slides in scrambled order --------

function varint(value) {
	const out = [];
	let rest = value;
	while (rest > 0x7f) {
		out.push((rest & 0x7f) | 0x80);
		rest = Math.floor(rest / 128);
	}
	out.push(rest);
	return Buffer.from(out);
}

function pbVarint(field, value) {
	return Buffer.concat([varint((field << 3) | 0), varint(value)]);
}

function pbBytes(field, value) {
	return Buffer.concat([varint((field << 3) | 2), varint(value.length), value]);
}

/** A literal-only snappy block (the encoder side of the decoder under test). */
function snappyLiteral(data) {
	const parts = [];
	for (let offset = 0; offset < data.length; offset += 60) {
		const run = data.subarray(offset, Math.min(offset + 60, data.length));
		parts.push(Buffer.from([(run.length - 1) << 2]), run);
	}
	return Buffer.concat([varint(data.length), ...parts]);
}

function iwaObjectStream(identifier, type, payload) {
	const info = pbBytes(2, Buffer.concat([pbVarint(1, type), pbVarint(3, payload.length)]));
	const archive = Buffer.concat([pbVarint(1, identifier), info]);
	return Buffer.concat([varint(archive.length), archive, payload]);
}

/** A show object listing the slide nodes in order; node 16 names the thumbnail data id. */
function keyDocument(slides) {
	const nodes = slides.map((slide) => iwaObjectStream(slide.nodeId, 4, pbBytes(16, pbVarint(1, slide.dataId))));
	const references = slides.map((slide) => pbBytes(2, pbVarint(1, slide.nodeId)));
	const show = iwaObjectStream(1, 2, pbBytes(3, Buffer.concat(references)));
	const block = snappyLiteral(Buffer.concat([show, ...nodes]));
	return Buffer.concat([Buffer.from([0x00, block.length & 0xff, (block.length >> 8) & 0xff, (block.length >> 16) & 0xff]), block]);
}

// Show order 50050, 10010, 30030, 20020, 40040 maps to the numbered slides
// 1..5, while the file names sort A, B, C, D, E → slides 2, 4, 3, 5, 1.
const document = keyDocument([
	{ nodeId: 11, dataId: 50050 },
	{ nodeId: 12, dataId: 10010 },
	{ nodeId: 13, dataId: 30030 },
	{ nodeId: 14, dataId: 20020 },
	{ nodeId: 15, dataId: 40040 },
]);

writeFileSync(
	join(root, "Slides.key"),
	zipSync(
		{
			"preview.jpg": jpegs[0],
			"Data/st-EEEE-50050.jpg": jpegs[0],
			"Data/st-AAAA-10010.jpg": jpegs[1],
			"Data/st-CCCC-30030.jpg": jpegs[2],
			"Data/st-BBBB-20020.jpg": jpegs[3],
			"Data/st-DDDD-40040.jpg": jpegs[4],
			"Index/Document.iwa": new Uint8Array(document),
		},
		{ level: 0 },
	),
);

const REAL_DECK = "/Users/jeffrey/Documents/랩실 연구/rerank-alignment/연구 진행 사항 - 250724.key";
const realName = basename(REAL_DECK);
copyFileSync(REAL_DECK, join(root, realName));

const results = [];
function check(label, pass, detail = "") {
	results.push({ label, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  (${detail})`}`);
}

async function poll(read, accept, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	let value = await read();
	while (!accept(value) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		value = await read();
	}
	return value;
}

const app = await launchFinder({ env: { AUTORAG_QA_ROOT: root, AUTORAG_SKIP_DUPEY_CHECK: "1" } });
try {
	const main = await finderWindow(app, 30_000);
	const preview = await poll(
		async () => (await app.windows()).find((candidate) => candidate.url().includes("quick-look.html")),
		(candidate) => candidate !== undefined,
		30_000,
	);
	if (preview === undefined) throw new Error("Quick Look window did not pre-warm");
	const bounds = () =>
		app.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("quick-look.html"));
			return window === undefined ? null : { visible: window.isVisible(), bounds: window.getBounds() };
		});

	async function open(name, ready) {
		const row = main.getByRole("row", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first();
		await row.waitFor({ timeout: 30_000 });
		await row.click();
		await main.keyboard.press("Space");
		await poll(() => preview.evaluate(ready).catch(() => false), Boolean, 10_000);
		await poll(async () => (await bounds())?.visible === true, Boolean);
		await new Promise((resolve) => setTimeout(resolve, 600));
	}
	async function close() {
		await main.keyboard.press("Space");
		await poll(async () => (await bounds())?.visible === false, Boolean);
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	const pill = () => preview.locator(".ql-pages__pill").textContent();
	const railCount = () => preview.locator(".ql__rail .ql__rail-item").count();

	// Five-slide fixture: the order is scrambled, so wrong order fails visibly.
	await open("Slides.key", () => document.querySelectorAll(".ql-pages [data-page]").length > 0);
	check("key shows the paged layout", (await preview.locator(".ql-pages").count()) === 1);
	check("key draws one paper card per slide", (await preview.locator(".ql-pages [data-page]").count()) === 5);
	check("key rail lists every slide", (await railCount()) === 5, String(await railCount()));
	check("pill shows the first slide of five", ((await pill()) ?? "").endsWith("1 / 5"), (await pill()) ?? "");
	await preview.screenshot({ path: join(EVIDENCE, "slides-open.png") });

	// A rail click jumps to that slide, and the pill follows the scroll.
	await preview.locator(".ql__rail .ql__rail-item").nth(4).click();
	const jumped = await poll(pill, (text) => (text ?? "").endsWith("5 / 5"));
	check("clicking the last rail item shows the last slide", (jumped ?? "").endsWith("5 / 5"), jumped ?? "");
	await preview.screenshot({ path: join(EVIDENCE, "slides-page5.png") });

	await preview.locator(".ql__rail .ql__rail-item").first().click();
	const back = await poll(pill, (text) => !(text ?? "").endsWith("5 / 5"));
	check("clicking the first rail item leaves the last slide", !(back ?? "").endsWith("5 / 5"), back ?? "");

	// Let the rail's smooth scroll settle before driving the column itself.
	await new Promise((resolve) => setTimeout(resolve, 900));
	await preview.locator(".ql-pages__scroll").evaluate((node) => {
		node.scrollTo({ top: node.scrollHeight, behavior: "auto" });
		node.dispatchEvent(new Event("scroll"));
	});
	const scrolled = await poll(pill, (text) => (text ?? "").endsWith("5 / 5"));
	check("scrolling the column moves the pill", (scrolled ?? "").endsWith("5 / 5"), scrolled ?? "");
	await preview.screenshot({ path: join(EVIDENCE, "slides-scrolled.png") });
	await close();

	// Real deck: 13 slides in the order Keynote wrote them.
	await open(realName, () => document.querySelectorAll(".ql-pages [data-page]").length > 0);
	check("real deck rail lists 13 slides", (await railCount()) === 13, String(await railCount()));
	check("real deck pill shows 13 pages", ((await pill()) ?? "").endsWith("1 / 13"), (await pill()) ?? "");
	await preview.screenshot({ path: join(EVIDENCE, "real-deck.png") });
	await close();
} finally {
	await app.close();
	rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
