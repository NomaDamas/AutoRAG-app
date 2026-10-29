/**
 * Manual QA — Photoshop, camera RAW, EPS, icns, tga, JPEG XL, Sketch, Figma and
 * Illustrator files in the Finder tiles and in Space (issue #141).
 *
 * Builds one fixture per format (left half red, right half blue) with the
 * system `sips` and hand-written containers, drives the production build
 * (`bun run build` first) and checks, through real input and the live DOM:
 *
 *   - the tile of each file shows the picture (a canvas sample of the tile's own
 *     pixels), whichever source drew it: Quick Look (psd, tga, icns) or the
 *     image the file embeds (eps, sketch, fig);
 *   - Space opens each file as a picture with the right colours and size:
 *     a RAW shows its embedded JPEG turned upright from the RAW's orientation
 *     tag, an EPS the XMP thumbnail, a PSD and TGA the OS decode, a JPEG XL
 *     file the Chromium decode, an Illustrator PDF the PDF viewer;
 *   - the page is never frozen while it opens.
 *
 * Optional real files: `QA_RAW_DIR=/path/to/folder` with camera RAW / DNG files
 * (sample.cr2 .cr3 .nef .arw .orf .rw2 .dng ...) adds a tile and Space check per
 * file, and `QA_MAX_RAW_MS` bounds how long Space may take for each.
 *
 * macOS only for the OS-drawn formats; the other platforms run the embedded ones.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

if (process.platform !== "darwin") {
	console.log("SKIP  the fixtures are built with the system sips; the embedded readers are unit-tested on every platform");
	process.exit(0);
}

const EVIDENCE = process.argv[2] ?? "/tmp/autorag-quicklook-raster";
mkdirSync(EVIDENCE, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "autorag-ql-raster-"));
const MAX_MS = Number(process.env.QA_RASTER_MAX_MS ?? 3000);
const MAX_RAW_MS = Number(process.env.QA_MAX_RAW_MS ?? 1500);
const MAX_BLOCK_MS = Number(process.env.QA_RASTER_MAX_BLOCK_MS ?? 1500);

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

/** `sips` converts the red/blue BMP to `format` (png, jpeg, psd, tga, ...) and returns the bytes. */
function convert(format, w, h) {
	const seed = join(root, `seed-${format}-${w}x${h}.bmp`);
	writeFileSync(seed, bmp(w, h));
	const out = join(root, `seed-${format}-${w}x${h}.out`);
	execFileSync("sips", ["-s", "format", format, seed, "--out", out], { stdio: "ignore" });
	rmSync(seed);
	const bytes = readFileSync(out);
	rmSync(out);
	return bytes;
}

/** The 1000x1000 JPEG XL codestream the mimetype library tests with (117 bytes). */
const JXL = Buffer.from("/wo6HwGRCAYBAKQBC4ALbNQxslZLlFdAkOAPoAehB5BJcYD1Lo0WYXbZB4vCxGjuQc6x/4UgLq5cjpgHPfUXsGDCgv45dgEZBArgt1YI436HAHKD5uNY+OGH8BV0jPMRJGl0oiUXUAHBDV4eWQQw6vhLEg4A", "base64");

/** A camera-style TIFF whose IFD0 holds `jpeg` as JPEGInterchangeFormat and says the shot was taken in portrait (Orientation 6). */
function rawTiff(jpeg) {
	const entries = 3;
	const dataAt = 8 + 2 + entries * 12 + 4;
	const head = Buffer.alloc(dataAt);
	head.write("II", 0, "ascii");
	head.writeUInt16LE(42, 2);
	head.writeUInt32LE(8, 4);
	head.writeUInt16LE(entries, 8);
	const entry = (i, tag, type, value) => {
		const at = 10 + i * 12;
		head.writeUInt16LE(tag, at);
		head.writeUInt16LE(type, at + 2);
		head.writeUInt32LE(1, at + 4);
		if (type === 3) head.writeUInt16LE(value, at + 8);
		else head.writeUInt32LE(value, at + 8);
	};
	entry(0, 0x0112, 3, 6);
	entry(1, 0x0201, 4, dataAt);
	entry(2, 0x0202, 4, jpeg.length);
	return Buffer.concat([head, jpeg]);
}

/** An EPS whose XMP packet carries the thumbnail Adobe's apps write: base64 split with `&#xA;`. */
function epsWithXmpThumbnail(jpeg) {
	const base64 = jpeg.toString("base64").replace(/(.{76})/g, "$1&#xA;");
	const xmp =
		'<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
		'<rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpGImg="http://ns.adobe.com/xap/1.0/g/img/"><xmp:Thumbnails><rdf:Alt><rdf:li rdf:parseType="Resource">' +
		`<xmpGImg:width>240</xmpGImg:width><xmpGImg:height>160</xmpGImg:height><xmpGImg:format>JPEG</xmpGImg:format><xmpGImg:image>${base64}</xmpGImg:image>` +
		'</rdf:li></rdf:Alt></xmp:Thumbnails></rdf:Description></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>\n';
	return Buffer.concat([Buffer.from("%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 240 160\n"), Buffer.from(xmp), Buffer.from("showpage\n%%EOF\n")]);
}

/** icns holding one 128px PNG entry. */
function icns(png) {
	const entry = Buffer.alloc(8);
	entry.write("ic07", 0, "ascii");
	entry.writeUInt32BE(8 + png.length, 4);
	const header = Buffer.alloc(8);
	header.write("icns", 0, "ascii");
	header.writeUInt32BE(8 + entry.length + png.length, 4);
	return Buffer.concat([header, entry, png]);
}

/** A one-page PDF (what a current Illustrator file is): left half red, right half blue. */
function pdf() {
	const content = "1 0 0 rg 0 0 100 100 re f 0 0 1 rg 100 0 100 100 re f";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << >> >>",
		`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
	];
	let body = "%PDF-1.4\n";
	const offsets = [];
	objects.forEach((object, index) => {
		offsets.push(body.length);
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
	});
	const xref = body.length;
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(body);
}

const png = convert("png", 240, 160);

writeFileSync(join(root, "shot.nef"), rawTiff(convert("jpeg", 300, 200)));
writeFileSync(join(root, "logo.eps"), epsWithXmpThumbnail(convert("jpeg", 240, 160)));
writeFileSync(join(root, "ui.sketch"), zipSync({ "previews/preview.png": png, "meta.json": Buffer.from("{}") }));
writeFileSync(join(root, "design.fig"), zipSync({ "thumbnail.png": png, "canvas.fig": Buffer.from("fig-kiwi") }));
writeFileSync(join(root, "art.ai"), pdf());
// An Illustrator file from before the PDF era is PostScript: the PDF panel cannot open it and must say so, not hang.
writeFileSync(join(root, "old.ai"), "%!PS-Adobe-3.0 EPSF-3.0\n%%Creator: Adobe Illustrator(TM) 3.2\n%%BoundingBox: 0 0 10 10\n");
writeFileSync(join(root, "pic.jxl"), JXL);
writeFileSync(join(root, "app.icns"), icns(convert("png", 128, 128)));
writeFileSync(join(root, "poster.psd"), convert("psd", 240, 160));
writeFileSync(join(root, "texture.tga"), convert("tga", 240, 160));
const realRaw = process.env.QA_RAW_DIR === undefined ? [] : readdirSync(process.env.QA_RAW_DIR).filter((name) => /\.(cr2|cr3|nef|arw|orf|rw2|dng|raw)$/i.test(name));
for (const name of realRaw) copyFileSync(join(process.env.QA_RAW_DIR, name), join(root, `real-${name}`));

const results = [];
function check(label, pass, detail = "") {
	results.push({ label, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  (${detail})`}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reddish = ([r, g, b]) => r > 170 && g < 90 && b < 90;
const bluish = ([r, g, b]) => b > 170 && r < 90 && g < 90;

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

	/** Natural size and, where the canvas is not tainted (a picture streamed from the preview protocol is), the colour at the left/right and top/bottom quarter of an image element in `page`. */
	const probeImage = (page, selector) =>
		page.evaluate(async (query) => {
			const image = document.querySelector(query);
			if (!(image instanceof HTMLImageElement)) return null;
			if (!image.complete) await image.decode().catch(() => undefined);
			if (image.naturalWidth === 0) return null;
			const size = { w: image.naturalWidth, h: image.naturalHeight };
			try {
				const canvas = document.createElement("canvas");
				canvas.width = image.naturalWidth;
				canvas.height = image.naturalHeight;
				const context = canvas.getContext("2d");
				context.drawImage(image, 0, 0);
				const at = (fx, fy) => Array.from(context.getImageData(Math.floor(image.naturalWidth * fx), Math.floor(image.naturalHeight * fy), 1, 1).data.slice(0, 3));
				return { ...size, left: at(0.25, 0.5), right: at(0.75, 0.5), top: at(0.5, 0.25), bottom: at(0.5, 0.75) };
			} catch {
				return { ...size, left: null, right: null, top: null, bottom: null };
			}
		}, selector);

	async function selectRow(name) {
		const row = main.locator(`[data-path$="/${name}"]`).first();
		await row.waitFor({ timeout: 30_000 });
		await row.click();
		await sleep(250);
		return row;
	}

	/** The tile's own pixels, retried until `accept` likes them or the budget ends; the last sample comes back either way. */
	async function tile(name, accept = (found) => reddish(found.left) && bluish(found.right)) {
		const row = await selectRow(name);
		const deadline = Date.now() + 30_000;
		let sample = null;
		while (Date.now() < deadline) {
			const handle = await row.locator("img.tile--image").first().elementHandle({ timeout: 1000 }).catch(() => null);
			if (handle !== null) {
				sample = await handle.evaluate(async (image) => {
					if (!image.complete) await image.decode().catch(() => undefined);
					if (image.naturalWidth === 0) return null;
					const canvas = document.createElement("canvas");
					canvas.width = image.naturalWidth;
					canvas.height = image.naturalHeight;
					const context = canvas.getContext("2d");
					context.drawImage(image, 0, 0);
					const at = (fx) => Array.from(context.getImageData(Math.floor(image.naturalWidth * fx), Math.floor(image.naturalHeight / 2), 1, 1).data.slice(0, 3));
					return { w: image.naturalWidth, h: image.naturalHeight, left: at(0.25), right: at(0.75) };
				});
				if (sample !== null && accept(sample)) return sample;
			}
			await sleep(250);
		}
		return sample;
	}

	async function openSpace(name, ready) {
		await selectRow(name);
		await preview.evaluate(() => {
			window.__block = 0;
		});
		const started = Date.now();
		await main.keyboard.press("Space");
		for (let i = 0; i < 6000 && !(await ready().catch(() => false)); i += 1) await sleep(10);
		const elapsed = Date.now() - started;
		await sleep(400);
		return { elapsed, blocked: Math.round(await preview.evaluate(() => window.__block)) };
	}
	async function close() {
		await main.keyboard.press("Space");
		for (let i = 0; i < 200 && (await visible()); i += 1) await sleep(30);
		await sleep(250);
	}
	const imageReady = async () => (await probeImage(preview, "img.ql__image")) !== null;
	const pdfReady = () => preview.evaluate(() => document.querySelector(".ql__stage canvas") instanceof HTMLCanvasElement);
	const failureReady = () => preview.evaluate(() => document.querySelector(".ql-other") !== null);

	/** The Info panel's 640px paper for the selected row: its pixels, retried until `accept` likes them. */
	async function paper(accept) {
		const deadline = Date.now() + 20_000;
		let sample = null;
		while (Date.now() < deadline) {
			sample = await probeImage(main, '.preview-paper img[src*="size=640"]').catch(() => null);
			if (sample !== null && accept(sample)) return sample;
			await sleep(250);
		}
		return sample;
	}

	/** One format: its tile, the Info panel's paper, then Space. `expect` describes the picture Space must show. */
	async function format(name, { tile: tileExpected = true, tileAccept, ready = imageReady, size, upright, colors = "across", maxMs = MAX_MS } = {}) {
		if (tileExpected) {
			const sample = await tile(name, tileAccept);
			const pass = sample !== null && (tileAccept === undefined ? reddish(sample.left) && bluish(sample.right) : tileAccept(sample));
			check(`${name}: tile shows the picture${tileAccept === undefined ? " (left red, right blue)" : ""}`, pass, sample === null ? "no tile image" : `${sample.w}x${sample.h} ${sample.left} | ${sample.right}`);
			const accept = tileAccept ?? ((found) => found.left !== null && reddish(found.left) && bluish(found.right));
			const sheet = await paper(accept);
			check(`${name}: the Info panel's 640px paper shows the picture`, sheet !== null && accept(sheet), sheet === null ? "no paper image" : `${sheet.w}x${sheet.h} ${sheet.left} | ${sheet.right}`);
		}
		const timing = await openSpace(name, ready);
		check(`${name}: Space opens within the budget`, timing.elapsed < maxMs, `${timing.elapsed}ms`);
		check(`${name}: the page is not frozen while it opens`, timing.blocked < MAX_BLOCK_MS, `longest stall ${timing.blocked}ms`);
		if (ready === imageReady) {
			const shape = await probeImage(preview, "img.ql__image");
			if (colors === "across") check(`${name}: Space colours: left red, right blue`, shape !== null && shape.left !== null && reddish(shape.left) && bluish(shape.right), shape === null ? "no image" : `${shape.left} | ${shape.right}`);
			if (colors === "down") check(`${name}: Space colours after turning upright: top red, bottom blue`, shape !== null && shape.top !== null && reddish(shape.top) && bluish(shape.bottom), shape === null ? "no image" : `${shape.top} | ${shape.bottom}`);
			if (size !== undefined) check(`${name}: Space size is ${size.w}x${size.h}`, shape !== null && shape.w === size.w && shape.h === size.h, shape === null ? "no image" : `${shape.w}x${shape.h}`);
			if (upright === true) check(`${name}: shown upright, not sideways`, shape !== null && shape.h > shape.w, shape === null ? "no image" : `${shape.w}x${shape.h}`);
		}
		await preview.screenshot({ path: join(EVIDENCE, `${name.replace(/[^\w.-]/g, "_")}.png`) });
		await close();
	}

	await format("logo.eps", { size: { w: 240, h: 160 } });
	// A RAW's embedded JPEG is 300x200; Orientation 6 stands it up as 200x300.
	await format("shot.nef", { tile: false, size: { w: 200, h: 300 }, upright: true, colors: "down", maxMs: MAX_RAW_MS });
	await format("ui.sketch", { size: { w: 240, h: 160 } });
	await format("design.fig", { size: { w: 240, h: 160 } });
	// A colourful photograph, not the red/blue fixture; Chromium's own JPEG XL decoder draws it from the preview protocol.
	await format("pic.jxl", { tileAccept: (found) => found.w > 1 && found.left.some((value) => value < 255), size: { w: 1000, h: 1000 }, colors: false });
	await format("app.icns", { size: { w: 128, h: 128 } });
	await format("art.ai", { ready: pdfReady });
	await format("old.ai", { tile: false, ready: failureReady });
	await format("poster.psd", { size: { w: 240, h: 160 } });
	await format("texture.tga", { size: { w: 240, h: 160 } });
	for (const name of realRaw) {
		const drawn = (found) => found.w > 1 && found.h > 1 && found.left.some((value) => value > 0);
		const sample = await tile(`real-${name}`, drawn);
		check(`real-${name}: tile drawn, not blank`, sample !== null && drawn(sample), sample === null ? "no tile image" : `${sample.w}x${sample.h} ${sample.left}`);
		const sheet = await paper(drawn);
		check(`real-${name}: the Info panel's 640px paper is drawn, not blank`, sheet !== null && drawn(sheet), sheet === null ? "no paper image" : `${sheet.w}x${sheet.h} ${sheet.left}`);
		await selectRow(`real-${name}`);
		const timing = await openSpace(`real-${name}`, imageReady);
		const shape = await probeImage(preview, "img.ql__image");
		check(`real-${name}: Space shows a picture`, shape !== null, shape === null ? "no image" : `${shape.w}x${shape.h}`);
		// A DNG with no embedded preview (a Samsung phone's) is developed by the OS: 0.45s on the Mac, 4s in the VM.
		const budget = name.toLowerCase().endsWith(".dng") ? Math.max(MAX_RAW_MS, 6000) : MAX_RAW_MS;
		check(`real-${name}: Space within ${budget}ms`, timing.elapsed < budget, `${timing.elapsed}ms`);
		check(`real-${name}: the page is not frozen`, timing.blocked < MAX_BLOCK_MS, `longest stall ${timing.blocked}ms`);
		await preview.screenshot({ path: join(EVIDENCE, `real-${name}.png`) });
		await close();
	}
} finally {
	await app.close().catch(() => undefined);
	rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
