/**
 * Manual QA — HEIC Quick Look (issue #175).
 *
 * Space on a camera-size HEIC must show the real picture within seconds. The
 * renderer's wasm decoder never finished a 24MP iPhone photo; the main process
 * now has the OS decode it (`sips`). Builds a 4000x3000 two-colour HEIC with
 * the system sips, drives the production build (`bun run build` first), opens
 * it with Space, and checks the decoded size and the pixels (the time is only
 * bounded by a hang ceiling).
 *
 * `QA_HEIC_DIR=<folder>` runs the same check against the first HEIC files of a
 * real folder instead (e.g. a photo library on a spinning disk).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

if (process.platform !== "darwin") {
	console.log("SKIP  HEIC decode through sips is macOS-only");
	process.exit(0);
}

const EVIDENCE = process.argv[2] ?? "/tmp/autorag-quicklook-heic";
mkdirSync(EVIDENCE, { recursive: true });
/** Hang ceiling, not a speed gate: a camera HEIC decodes in about a second through sips. */
const MAX_MS = 60_000;

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

/** A 2x1 PNG: red left pixel, blue right pixel. */
function redBluePng() {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(2, 0);
	header.writeUInt32BE(1, 4);
	header[8] = 8;
	header[9] = 2;
	const row = Buffer.from([0, 255, 0, 0, 0, 0, 255]);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(row)), pngChunk("IEND", Buffer.alloc(0))]);
}

const results = [];
function check(label, pass, detail = "") {
	results.push({ label, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  (${detail})`}`);
}

async function poll(read, accept, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let value = await read();
	while (!accept(value) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		value = await read();
	}
	return value;
}

const realDir = process.env.QA_HEIC_DIR;
const root = realDir ?? mkdtempSync(join(tmpdir(), "autorag-ql-heic-"));
let names;
if (realDir === undefined) {
	const seed = join(root, "seed.png");
	const big = join(root, "big.png");
	writeFileSync(seed, redBluePng());
	execFileSync("sips", ["-z", "3000", "4000", seed, "--out", big], { stdio: "ignore" });
	execFileSync("sips", ["-s", "format", "heic", big, "--out", join(root, "IMG_0001.HEIC")], { stdio: "ignore" });
	rmSync(seed);
	rmSync(big);
	names = ["IMG_0001.HEIC"];
} else {
	names = readdirSync(realDir)
		.filter((name) => /\.heic$/i.test(name))
		.slice(0, 3);
	if (names.length === 0) throw new Error(`no HEIC files in ${realDir}`);
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

	for (const name of names) {
		const row = main.getByRole("row", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first();
		await row.waitFor({ timeout: 60_000 });
		await row.click();
		const started = Date.now();
		await main.keyboard.press("Space");
		const size = await poll(
			() =>
				preview
					.evaluate(() => {
						const image = document.querySelector(".ql__image");
						return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 ? [image.naturalWidth, image.naturalHeight] : null;
					})
					.catch(() => null),
			Boolean,
			MAX_MS,
		);
		const elapsed = Date.now() - started;
		check(`${name}: the real picture appears`, size !== null, size === null ? "still loading" : size.join("x"));
		check(`${name}: within the ${MAX_MS} ms hang ceiling`, size !== null && elapsed <= MAX_MS, `${elapsed} ms`);
		await preview.screenshot({ path: join(EVIDENCE, `${name}.png`) });

		if (realDir === undefined && size !== null) {
			check("decoded at full 4000x3000", size[0] === 4000 && size[1] === 3000, size.join("x"));
			const colours = await preview.evaluate(() => {
				const image = document.querySelector(".ql__image");
				if (!(image instanceof HTMLImageElement)) return null;
				const canvas = document.createElement("canvas");
				canvas.width = image.naturalWidth;
				canvas.height = image.naturalHeight;
				const context = canvas.getContext("2d");
				if (context === null) return null;
				context.drawImage(image, 0, 0);
				const at = (x, y) => Array.from(context.getImageData(x, y, 1, 1).data.slice(0, 3));
				return { left: at(500, 1500), right: at(3500, 1500) };
			});
			check("left half is red, right half is blue", colours !== null && colours.left[0] > 180 && colours.left[2] < 80 && colours.right[2] > 180 && colours.right[0] < 80, JSON.stringify(colours));
		}
		await main.keyboard.press("Space");
		await poll(async () => (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((item) => item.webContents.getURL().includes("quick-look.html") && item.isVisible()))) === false, Boolean, 5000);
	}
} finally {
	await app.close();
	if (realDir === undefined) rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
