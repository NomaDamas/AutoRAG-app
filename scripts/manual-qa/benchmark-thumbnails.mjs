import { fileURLToPath } from "node:url";
/**
 * Before/after benchmark — thumbnail enrichment cost and qlmanage spawns.
 *
 * Drives the built production app (`bun run build` first) over three fixture
 * dirs of 48 images + 8 PDFs and times the real pipeline the renderer uses:
 * `fs.listDir` then `fs.enrichEntries(targets, true)` (the call that actually
 * generates tile thumbnails). Cold = first enrichment of a dir (cache miss,
 * icons generated); warm = the same dir again. While each cold enrichment runs
 * it samples `pgrep -x qlmanage`, so the same run proves the native path never
 * forks the Quick Look CLI.
 *
 * Version-agnostic: it exercises only the renderer bridge, so the same script
 * runs against the pre-change (`qlmanage`) and post-change (`nativeImage`)
 * builds for a like-for-like before/after comparison.
 *
 * Run from the repo root:
 *   BENCH_OUT=/tmp/after.json bun scripts/manual-qa/benchmark-thumbnails.mjs
 */

import { mkdirSync, rmSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { baseName, qlmanageCount, reapQlmanageOrphans } from "./platform.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const OUT = process.env.BENCH_OUT ?? `${ROOT}/.omo/evidence/ai-finder-app/thumbnail-benchmark/result.json`;
const IMAGES = 24;
const PDFS = 8;
const DIRS = 3;
const stamp = Date.now();
const base = `${process.env.TMPDIR ?? "/tmp"}/ulw-thumb-bench-${stamp}`;

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
/** Deterministic noisy PNG — realistic decode/render cost (not a trivially compressing solid). */
function noisyPng(width, height, seed) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const raw = Buffer.alloc(height * (1 + width * 3));
	let state = seed >>> 0;
	for (let y = 0; y < height; y++) {
		const off = y * (1 + width * 3);
		for (let x = 0; x < width; x++) {
			state = (state * 1664525 + 1013904223) >>> 0;
			raw[off + 1 + x * 3] = state & 0xff;
			raw[off + 2 + x * 3] = (state >>> 8) & 0xff;
			raw[off + 3 + x * 3] = (state >>> 16) & 0xff;
		}
	}
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
/** Minimal single-page PDF with a correct xref, so Quick Look can thumbnail it. */
function minimalPdf(text) {
	const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let body = "%PDF-1.4\n";
	const offsets = [];
	for (const [index, object] of objects.entries()) {
		offsets.push(body.length);
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = body.length;
	let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) tail += `${String(offset).padStart(10, "0")} 00000 n \n`;
	tail += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(body + tail, "latin1");
}

const dirs = [];
for (let d = 0; d < DIRS; d++) {
	const dir = `${base}/dir-${d}`;
	mkdirSync(dir, { recursive: true });
	for (let i = 0; i < IMAGES; i++) {
		await Bun.write(`${dir}/img-${i}.png`, noisyPng(1024, 768, d * 1000 + i + 1));
	}
	for (let i = 0; i < PDFS; i++) await Bun.write(`${dir}/doc-${i}.pdf`, minimalPdf(`AutoRAG ${d}-${i}`));
	dirs.push(dir);
}

const enrich = (page, dir) =>
	page.evaluate(async (target) => {
		const listing = await window.autorag.fs.listDir(target);
		const targets = listing.entries
			.filter((entry) => entry.kind === "file")
			.map((entry) => ({ path: entry.path, kind: entry.kind, ext: entry.ext, mtimeMs: entry.mtimeMs }));
		const start = performance.now();
		const enriched = await window.autorag.fs.enrichEntries(targets, true);
		return {
			ms: Math.round(performance.now() - start),
			total: targets.length,
			icons: enriched.filter((entry) => entry.iconUrl !== null && entry.iconUrl !== undefined).length,
		};
	}, dir);

const reaped = reapQlmanageOrphans();
await new Promise((resolve) => setTimeout(resolve, 700));
const report = {
	stamp,
	filesPerDir: IMAGES + PDFS,
	dirs: [],
	qlmanage: { reaped, before: qlmanageCount(), maxDuringCold: 0, after: 0 },
};
let app;
try {
	app = await launchFinder();
	const page = await finderWindow(app);
	await page.waitForSelector('[role="row"]', { timeout: 30000 });

	for (const dir of dirs) {
		let max = 0;
		const sampler = setInterval(() => {
			max = Math.max(max, qlmanageCount());
		}, 100);
		const cold = await enrich(page, dir);
		clearInterval(sampler);
		const warm = await enrich(page, dir);
		report.qlmanage.maxDuringCold = Math.max(report.qlmanage.maxDuringCold, max);
		report.dirs.push({ dir, cold, warm });
		console.log(
			`${baseName(dir)}: cold=${cold.ms}ms warm=${warm.ms}ms icons=${cold.icons}/${cold.total}`,
		);
	}
	report.qlmanage.after = qlmanageCount();
} finally {
	if (app !== undefined) await app.close();
	rmSync(base, { recursive: true, force: true });
}

mkdirSync(OUT.slice(0, OUT.lastIndexOf("/")), { recursive: true });
await Bun.write(OUT, JSON.stringify(report, null, 2));
const coldMs = report.dirs.map((entry) => entry.cold.ms);
const warmMs = report.dirs.map((entry) => entry.warm.ms);
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(
	JSON.stringify(
		{ out: OUT, coldMs, coldMedianMs: median(coldMs), warmMedianMs: median(warmMs), qlmanage: report.qlmanage },
		null,
		2,
	),
);
