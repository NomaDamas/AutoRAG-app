import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
/**
 * Manual QA — thumbnails keep loading as the user scrolls (viewport-driven).
 *
 * Regression for the reported bug: a folder with more files than the icon
 * provider's per-call cap showed thumbnails only down to the cap, and scrolling
 * past it left every later row on its letter tile because enrichment ran once
 * per listing. Both views are virtualized, so mounted rows now report themselves
 * and the controller fills the visible ones in.
 *
 * Fixture: 300 images, zero-padded names so lexical order is 000..299 and the
 * bottom rows are exactly the ones outside the first 240 the background pass
 * covers. The gate: `img-299.png` (never in the initial batch) shows an image
 * tile after scrolling to the bottom.
 *
 * Run from the repo root: `bun run build && bun scripts/manual-qa/run-qa-finder-thumbnail-scroll.mjs`
 */

import { mkdirSync, rmSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { qlmanageCount, reapQlmanageOrphans } from "./platform.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const EVIDENCE = `${ROOT}/.omo/evidence/ai-finder-app/qa-thumbnail-scroll/`;
mkdirSync(EVIDENCE, { recursive: true });

const stamp = Date.now();
const documents = `${homedir()}/Documents`;
const folderName = `ulw-thumb-scroll-${stamp}`;
const dir = `${documents}/${folderName}`;
const COUNT = 300;
const FIRST_BATCH = 240;
const LAST = `img-${String(COUNT - 1).padStart(3, "0")}.png`;

function crc32(buf) {
	let crc = 0xffffffff;
	for (const byte of buf) {
		crc ^= byte;
		for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}
function solidPng(width, height, [r, g, b]) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const raw = Buffer.alloc(height * (1 + width * 3));
	for (let y = 0; y < height; y++) {
		const off = y * (1 + width * 3);
		for (let x = 0; x < width; x++) {
			raw[off + 1 + x * 3] = r;
			raw[off + 2 + x * 3] = g;
			raw[off + 3 + x * 3] = b;
		}
	}
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

mkdirSync(dir, { recursive: true });
for (let index = 0; index < COUNT; index += 1) {
	await Bun.write(`${dir}/img-${String(index).padStart(3, "0")}.png`, solidPng(64, 64, [(index * 7) % 255, 90, 200]));
}

const results = [];
const check = (label, actual, expected) => {
	const pass = actual === expected;
	results.push({ label, actual, expected, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}: ${JSON.stringify(actual)}`);
};

let app;
try {
	app = await launchFinder();
	const page = await finderWindow(app);
	await page.waitForSelector('[role="row"]', { timeout: 30000 });
	await page.locator('.seg__button[aria-label="List"]').click();
	await page.getByLabel("Places").getByRole("button", { name: "Documents", exact: true }).click();

	const rowFor = (name) => page.locator(`[role="row"]:has-text("${name}")`).first();
	const scrollBy = (fraction) =>
		page.locator(".list").evaluate((node, value) => {
			node.scrollTop = node.scrollTop + node.clientHeight * value;
			return node.scrollTop >= node.scrollHeight - node.clientHeight - 1;
		}, fraction);
	const mountRow = async (name) => {
		await page.locator(".list").evaluate((node) => {
			node.scrollTop = 0;
		});
		for (let attempt = 0; attempt < 200; attempt += 1) {
			if ((await rowFor(name).count()) > 0) return;
			if (await scrollBy(0.9)) break;
			await page.waitForTimeout(20);
		}
		await rowFor(name).waitFor({ timeout: 30000 });
	};

	// Open the fixture folder by double-clicking its row.
	await mountRow(folderName);
	await rowFor(folderName).dblclick();
	await page.waitForSelector('[role="row"]', { timeout: 30000 });
	await page.waitForTimeout(1500);

	// Before scrolling, the bottom file is far outside the mounted window.
	check(`${LAST} is not mounted before scrolling`, await rowFor(LAST).count(), 0);

	// Scroll to the bottom; the tail rows are past the background pass's cap.
	const reaped = reapQlmanageOrphans();
	if (reaped > 0) console.log(`INFO  reaped ${reaped} orphaned qlmanage before the gate`);
	await new Promise((resolve) => setTimeout(resolve, 500));
	let qlMax = 0;
	const sampler = setInterval(() => {
		qlMax = Math.max(qlMax, qlmanageCount());
	}, 100);
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if ((await rowFor(LAST).count()) > 0) break;
		if (await scrollBy(0.9)) break;
		await page.waitForTimeout(20);
	}
	await rowFor(LAST).waitFor({ timeout: 30000 });
	const lastHasImage = await rowFor(LAST)
		.locator("img.tile--image")
		.waitFor({ timeout: 30000 })
		.then(() => true)
		.catch(() => false);
	clearInterval(sampler);

	check(`${LAST} (row ${COUNT}, past the ${FIRST_BATCH} cap) loads a thumbnail on scroll`, lastHasImage, true);
	check("no qlmanage spawned while scrolling to the tail", qlMax, 0);

	await page.screenshot({ path: `${EVIDENCE}/tail.png` });
	await Bun.write(`${EVIDENCE}/result.json`, JSON.stringify({ checks: results }, null, 2));
} finally {
	if (app !== undefined) await app.close();
	rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
