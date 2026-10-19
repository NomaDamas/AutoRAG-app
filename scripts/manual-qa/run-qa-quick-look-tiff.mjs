/**
 * Manual QA — TIFF Quick Look.
 *
 * Space on a large scan must show the real picture quickly and must not
 * freeze the panel. The renderer's own TIFF decoder takes seconds on a camera-
 * size scan and blocks the page the whole time; the main process now has the
 * OS decode it (`sips`). Builds three TIFFs with the system sips from a BMP
 * this script writes (red left half, blue right half), drives the production
 * build (`bun run build` first), opens each with Space, and checks the time,
 * the page's responsiveness, the decoded size, and the pixels:
 *
 *   - a small TIFF is shown at its own size (sips would otherwise scale it up);
 *   - a 6000 px TIFF is shown shrunk to 2048 px on its long side;
 *   - the colours survive: the left half is red and the right half is blue.
 *
 * macOS only: other platforms keep the in-page decoder, which this lane does
 * not exercise.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

if (process.platform !== "darwin") {
	console.log("SKIP  TIFF decode through sips is macOS-only");
	process.exit(0);
}

const EVIDENCE = process.argv[2] ?? "/tmp/autorag-quicklook-tiff";
mkdirSync(EVIDENCE, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "autorag-ql-tiff-"));
const MAX_MS = Number(process.env.QA_TIFF_MAX_MS ?? 3000);
const MAX_BLOCK_MS = Number(process.env.QA_TIFF_MAX_BLOCK_MS ?? 1500);

/** A 24-bit BMP, `w` x `h`: the left half red, the right half blue. */
function bmp(w, h) {
	const rowSize = Math.ceil((w * 3) / 4) * 4;
	const row = Buffer.alloc(rowSize);
	for (let x = 0; x < w; x += 1) {
		const o = x * 3; // BGR
		if (x < w / 2) row[o + 2] = 0xff;
		else row[o] = 0xff;
	}
	const header = Buffer.alloc(54);
	header.write("BM", 0, "ascii");
	header.writeUInt32LE(54 + rowSize * h, 2);
	header.writeUInt32LE(54, 10);
	header.writeUInt32LE(40, 14);
	header.writeInt32LE(w, 18);
	header.writeInt32LE(h, 22);
	header.writeUInt16LE(1, 26);
	header.writeUInt16LE(24, 28);
	header.writeUInt32LE(rowSize * h, 34);
	return Buffer.concat([header, ...Array.from({ length: h }, () => row)]);
}

function tiff(name, w, h) {
	const seed = join(root, `${name}.bmp`);
	writeFileSync(seed, bmp(w, h));
	execFileSync("sips", ["-s", "format", "tiff", seed, "--out", join(root, `${name}.tif`)], { stdio: "ignore" });
	rmSync(seed);
}

tiff("small", 60, 40);
tiff("wide", 6000, 800);
tiff("scan", 5000, 4000);

const results = [];
function check(label, pass, detail = "") {
	results.push({ label, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  (${detail})`}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const app = await launchFinder({ env: { AUTORAG_QA_ROOT: root, AUTORAG_SKIP_DUPEY_CHECK: "1" }, language: "en" });
try {
	const main = await finderWindow(app, 30_000);
	let preview;
	for (let i = 0; i < 600 && preview === undefined; i += 1) {
		preview = (await app.windows()).find((page) => page.url().includes("quick-look.html"));
		if (preview === undefined) await sleep(50);
	}
	if (preview === undefined) throw new Error("Quick Look window did not pre-warm");
	await preview.evaluate(() => {
		window.__block = 0;
		let last = performance.now();
		setInterval(() => {
			const now = performance.now();
			window.__block = Math.max(window.__block, now - last - 8);
			last = now;
		}, 8);
	});
	const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("quick-look.html"))?.isVisible() ?? false);
	const shown = () =>
		preview.evaluate(() => {
			const image = document.querySelector("img.ql__image");
			return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
		});

	async function open(name) {
		const row = main.locator(`[data-path$="/${name}"]`).first();
		await row.waitFor({ timeout: 30_000 });
		await row.click();
		await sleep(250);
		await preview.evaluate(() => { window.__block = 0; });
		const started = Date.now();
		await main.keyboard.press("Space");
		for (let i = 0; i < 6000 && !(await shown().catch(() => false)); i += 1) await sleep(10);
		const elapsed = Date.now() - started;
		await sleep(400);
		return { elapsed, blocked: Math.round(await preview.evaluate(() => window.__block)) };
	}
	async function close() {
		await main.keyboard.press("Space");
		for (let i = 0; i < 200 && (await visible()); i += 1) await sleep(30);
		await sleep(250);
	}
	/** Natural size and the colour at the middle of the left and right quarter of the shown picture. */
	const probe = () =>
		preview.evaluate(() => {
			const image = document.querySelector("img.ql__image");
			const canvas = document.createElement("canvas");
			canvas.width = image.naturalWidth;
			canvas.height = image.naturalHeight;
			const context = canvas.getContext("2d");
			context.drawImage(image, 0, 0);
			const at = (fx) => Array.from(context.getImageData(Math.floor(image.naturalWidth * fx), Math.floor(image.naturalHeight / 2), 1, 1).data.slice(0, 3));
			return { w: image.naturalWidth, h: image.naturalHeight, left: at(0.25), right: at(0.75) };
		});
	const reddish = ([r, g, b]) => r > 200 && g < 60 && b < 60;
	const bluish = ([r, g, b]) => b > 200 && r < 60 && g < 60;

	let timing = await open("small.tif");
	let shape = await probe();
	check("small TIFF opens quickly", timing.elapsed < 1500, `${timing.elapsed}ms`);
	check("small TIFF keeps its own size (not scaled up)", shape.w === 60 && shape.h === 40, `${shape.w}x${shape.h}`);
	check("small TIFF colours: left red, right blue", reddish(shape.left) && bluish(shape.right), `${shape.left} | ${shape.right}`);
	await close();

	timing = await open("wide.tif");
	shape = await probe();
	check("6000x800 TIFF opens within the budget", timing.elapsed < MAX_MS, `${timing.elapsed}ms`);
	check("the page is not frozen while it opens", timing.blocked < MAX_BLOCK_MS, `longest stall ${timing.blocked}ms`);
	check("long side is shrunk to 2048", shape.w === 2048 && shape.h === Math.round((800 * 2048) / 6000), `${shape.w}x${shape.h}`);
	check("wide TIFF colours: left red, right blue", reddish(shape.left) && bluish(shape.right), `${shape.left} | ${shape.right}`);
	await preview.screenshot({ path: join(EVIDENCE, "wide.png") });
	await close();

	timing = await open("scan.tif");
	shape = await probe();
	check("5000x4000 TIFF opens within the budget", timing.elapsed < MAX_MS, `${timing.elapsed}ms`);
	check("the page is not frozen while it opens", timing.blocked < MAX_BLOCK_MS, `longest stall ${timing.blocked}ms`);
	check("scan is shrunk to 2048 on its long side", Math.max(shape.w, shape.h) === 2048 && Math.abs(shape.h - 1638) <= 1, `${shape.w}x${shape.h}`);
	check("scan colours: left red, right blue", reddish(shape.left) && bluish(shape.right), `${shape.left} | ${shape.right}`);
	await preview.screenshot({ path: join(EVIDENCE, "scan.png") });
	await close();
} finally {
	await app.close().catch(() => undefined);
	rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
