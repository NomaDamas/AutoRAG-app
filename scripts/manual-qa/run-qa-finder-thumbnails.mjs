import { copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
/**
 * Manual QA — the row tile shows the OS thumbnail (Finder-style), not a letter.
 *
 * Drives the real production app (app/out) with Playwright and samples the
 * PIXELS of each rendered tile through a canvas. Two same-type fixtures with
 * different content (red vs blue) prove the tile is content-true rather than a
 * generic type icon, and the sample is taken from the live DOM, not from a file
 * the script generated itself. Evidence goes to
 * .omo/evidence/ai-finder-app/qa-thumbnails/.
 *
 * Run from the repo root: `bun scripts/manual-qa/run-qa-finder-thumbnails.mjs`
 */

import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { qlmanageCount, reapQlmanageOrphans } from "./platform.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const EVIDENCE = `${ROOT}/.omo/evidence/ai-finder-app/qa-thumbnails/`;
mkdirSync(EVIDENCE, { recursive: true });

const stamp = Date.now();
const documents = `${homedir()}/Documents`;
const folderName = `ulw-thumb-${stamp}-dir`;
const probeDir = `${documents}/ulw-thumb-${stamp}-latency`;
const qlDir = `${documents}/ulw-thumb-${stamp}-ql`;
const RED = [220, 40, 40];
const BLUE = [40, 60, 220];
const fixtures = [
	{ name: `ulw-thumb-${stamp}-red.png`, expect: "red" },
	{ name: `ulw-thumb-${stamp}-blue.png`, expect: "blue" },
	{ name: `ulw-thumb-${stamp}-red.mp4`, expect: "red" },
	{ name: `ulw-thumb-${stamp}-blue.mp4`, expect: "blue" },
];

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

mkdirSync(`${documents}/${folderName}`, { recursive: true });
await Bun.write(`${documents}/${fixtures[0].name}`, solidPng(64, 64, RED));
await Bun.write(`${documents}/${fixtures[1].name}`, solidPng(64, 64, BLUE));
const video = (color) =>
	execSync(
		`ffmpeg -y -loglevel error -f lavfi -i color=c=${color}:s=64x64:d=1:r=10 -pix_fmt yuv420p -c:v libx264 "${documents}/${color === "red" ? fixtures[2].name : fixtures[3].name}"`,
	);
video("red");
video("blue");

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
	await page.getByLabel("Places").getByRole("button", { name: "Documents", exact: true }).click();
	const rowFor = (name) => page.locator(`[role="row"]:has-text("${name}")`).first();
	const mountRow = async (name) => {
		await page.locator(".list").evaluate((node) => {
			node.scrollTop = 0;
		});
		for (let attempt = 0; attempt < 160; attempt += 1) {
			if ((await rowFor(name).count()) > 0) return rowFor(name);
			const atEnd = await page.locator(".list").evaluate((node) => {
				node.scrollTop = node.scrollTop + node.clientHeight * 0.9;
				return node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
			});
			if (atEnd) break;
			await page.waitForTimeout(25);
		}
		return rowFor(name).waitFor({ timeout: 30000 }).then(() => rowFor(name));
	};
	// Enrichment lands asynchronously now; mount each row and wait for its icon.
	for (const fixture of fixtures) {
		const row = await mountRow(fixture.name);
		await row.locator("img.tile--image").waitFor({ timeout: 30000 });
	}

	const sampleTile = (rowName) =>
		page.evaluate(async (name) => {
			const row = [...document.querySelectorAll('[role="row"]')].find((candidate) =>
				(candidate.textContent ?? "").includes(name),
			);
			if (row === undefined) return { error: "row not found" };
			const image = row.querySelector("img.tile--image");
			if (image === null) {
				return { error: "no image tile", tileText: row.querySelector(".tile")?.textContent ?? null };
			}
			if (!image.complete) await image.decode();
			const canvas = document.createElement("canvas");
			canvas.width = image.naturalWidth || 1;
			canvas.height = image.naturalHeight || 1;
			const context = canvas.getContext("2d");
			context.drawImage(image, 0, 0);
			const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
			let r = 0;
			let g = 0;
			let b = 0;
			const pixels = data.length / 4;
			for (let i = 0; i < data.length; i += 4) {
				r += data[i];
				g += data[i + 1];
				b += data[i + 2];
			}
			return {
				src: image.getAttribute("src")?.slice(0, 30) ?? null,
				size: [canvas.width, canvas.height],
				avg: [Math.round(r / pixels), Math.round(g / pixels), Math.round(b / pixels)],
			};
		}, rowName);

	const dominant = (avg) => (avg[0] > avg[1] && avg[0] > avg[2] ? "red" : avg[2] > avg[1] ? "blue" : "other");
	const observed = [];
	const sampleMounted = async (name, expectIcon) => {
		for (let attempt = 0; attempt < 30; attempt += 1) {
			await mountRow(name);
			const sample = await sampleTile(name);
			if (sample.error !== undefined && expectIcon) {
				await page.waitForTimeout(100);
				continue;
			}
			return sample;
		}
		return sampleTile(name);
	};
	for (const fixture of fixtures) {
		const sample = await sampleMounted(fixture.name, true);
		observed.push({ name: fixture.name, sample });
		if (sample.error !== undefined) {
			check(fixture.name, sample.error, fixture.expect);
			continue;
		}
		check(
			`${fixture.name} tile is a custom-protocol URL`,
			sample.src.startsWith("autorag-thumb://") ? "thumb-protocol" : sample.src,
			"thumb-protocol",
		);
		check(`${fixture.name} tile is ${fixture.expect}-true`, dominant(sample.avg), fixture.expect);
	}

	const folderSample = await sampleMounted(folderName, false);
	observed.push({ name: folderName, sample: folderSample });
	check("folder renders no image tile", folderSample.error ?? "has image tile", "no image tile");

	// Informational: what the icon work costs a real listing (cold = icons generated now).
	mkdirSync(probeDir, { recursive: true });
	for (const fixture of fixtures) copyFileSync(`${documents}/${fixture.name}`, `${probeDir}/${fixture.name}`);
	const timeList = (dir) =>
		page.evaluate(async (target) => {
			const start = performance.now();
			await window.autorag.fs.listDir(target);
			return Math.round(performance.now() - start);
		}, dir);
	const coldMs = await timeList(probeDir);
	const warmMs = await timeList(probeDir);
	console.log(`INFO  listDir(${probeDir}): cold=${coldMs}ms warm=${warmMs}ms`);

	// Issue #24: the native Quick Look path must never fork the qlmanage CLI.
	// Start from a clean slate by reaping orphans leaked by the pre-change build.
	const reaped = reapQlmanageOrphans();
	if (reaped > 0) console.log(`INFO  reaped ${reaped} orphaned qlmanage before the gate`);
	await new Promise((resolve) => setTimeout(resolve, 700));
	mkdirSync(qlDir, { recursive: true });
	const qlImages = 40;
	for (let index = 0; index < qlImages; index += 1) {
		await Bun.write(`${qlDir}/q-${index}.png`, solidPng(64, 64, [(index * 17) % 255, 90, 200]));
	}
	let qlMax = 0;
	const sampler = setInterval(() => {
		qlMax = Math.max(qlMax, qlmanageCount());
	}, 100);
	const qlIcons = await page.evaluate(async (target) => {
		const listing = await window.autorag.fs.listDir(target);
		const targets = listing.entries
			.filter((entry) => entry.kind === "file")
			.map((entry) => ({ path: entry.path, kind: entry.kind, ext: entry.ext, modifiedAt: entry.modifiedAt }));
		const enriched = await window.autorag.fs.enrichEntries(targets, true);
		return enriched.filter((entry) => entry.iconUrl !== null && entry.iconUrl !== undefined).length;
	}, qlDir);
	clearInterval(sampler);
	check("no qlmanage spawned while generating 40 thumbnails", qlMax, 0);
	check("every image produced a thumbnail", qlIcons, qlImages);

	await page.screenshot({ path: `${EVIDENCE}/documents-list.png` });
	const row = await mountRow(fixtures[0].name);
	await row.screenshot({ path: `${EVIDENCE}/red-png-row.png` });
	await Bun.write(`${EVIDENCE}/result.json`, JSON.stringify({ checks: results, observed, latency: { coldMs, warmMs } }, null, 2));
} finally {
	if (app !== undefined) await app.close();
	for (const fixture of fixtures) await rm(`${documents}/${fixture.name}`, { force: true });
	await rm(`${documents}/${folderName}`, { recursive: true, force: true });
	await rm(probeDir, { recursive: true, force: true });
	await rm(qlDir, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
