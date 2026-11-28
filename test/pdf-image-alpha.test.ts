import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode as decodePng, toRGBA8 } from "@pdf-lib/upng";
import { PDFDocument, PDFName, PDFRawStream, rgb } from "pdf-lib";
import { afterEach, describe, expect, it } from "vitest";
import { createPdfEditorIo } from "../src/main/pdf-editor-io";
import { decodeImageForPdf } from "../src/main/pdf-image-decode";
import { encodePng } from "../src/preview/node/png-encode";

const W = 40;
const H = 40;
const RED: readonly [number, number, number] = [220, 38, 38];
const BLUE = rgb(0.1, 0.4, 0.9);

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "dazzi-pdf-alpha-"));
	dirs.push(dir);
	return dir;
}

/** Left half fully transparent, right half opaque red: the shape of a logo on a transparent background. */
function halfTransparentRgba(): Uint8Array {
	const rgba = new Uint8Array(W * H * 4);
	for (let y = 0; y < H; y += 1) {
		for (let x = W / 2; x < W; x += 1) {
			const p = (y * W + x) * 4;
			rgba[p] = RED[0];
			rgba[p + 1] = RED[1];
			rgba[p + 2] = RED[2];
			rgba[p + 3] = 255;
		}
	}
	return rgba;
}

/**
 * A minimal uncompressed little-endian RGBA TIFF with *unassociated* alpha (ExtraSamples = 2),
 * the way Photoshop / Preview save a transparent TIFF.
 */
function encodeRgbaTiff(rgba: Uint8Array, width: number, height: number): Uint8Array {
	const entries: Array<[tag: number, type: number, count: number, value: number]> = [];
	const bitsOffset = 8;
	const pixelOffset = 16;
	const ifdOffset = pixelOffset + rgba.length;
	entries.push([256, 3, 1, width]); // ImageWidth
	entries.push([257, 3, 1, height]); // ImageLength
	entries.push([258, 3, 4, bitsOffset]); // BitsPerSample -> [8,8,8,8]
	entries.push([259, 3, 1, 1]); // Compression: none
	entries.push([262, 3, 1, 2]); // Photometric: RGB
	entries.push([273, 4, 1, pixelOffset]); // StripOffsets
	entries.push([277, 3, 1, 4]); // SamplesPerPixel
	entries.push([278, 3, 1, height]); // RowsPerStrip
	entries.push([279, 4, 1, rgba.length]); // StripByteCounts
	entries.push([284, 3, 1, 1]); // PlanarConfiguration: chunky
	entries.push([338, 3, 1, 2]); // ExtraSamples: unassociated alpha
	const out = Buffer.alloc(ifdOffset + 2 + entries.length * 12 + 4);
	out.write("II", 0, "ascii");
	out.writeUInt16LE(42, 2);
	out.writeUInt32LE(ifdOffset, 4);
	for (let i = 0; i < 4; i += 1) out.writeUInt16LE(8, bitsOffset + i * 2);
	out.set(rgba, pixelOffset);
	out.writeUInt16LE(entries.length, ifdOffset);
	entries.forEach(([tag, type, count, value], i) => {
		const at = ifdOffset + 2 + i * 12;
		out.writeUInt16LE(tag, at);
		out.writeUInt16LE(type, at + 2);
		out.writeUInt32LE(count, at + 4);
		if (type === 3 && count === 1) out.writeUInt16LE(value, at + 8);
		else out.writeUInt32LE(value, at + 8);
	});
	out.writeUInt32LE(0, ifdOffset + 2 + entries.length * 12);
	return out;
}

function pngPixels(png: Uint8Array): { readonly width: number; readonly height: number; readonly rgba: Uint8Array } {
	const buffer = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
	const image = decodePng(buffer);
	return { width: image.width, height: image.height, rgba: new Uint8Array(toRGBA8(image)[0]!) };
}

function pixelAt(image: ReturnType<typeof pngPixels>, fx: number, fy: number): readonly number[] {
	const x = Math.min(image.width - 1, Math.floor(image.width * fx));
	const y = Math.min(image.height - 1, Math.floor(image.height * fy));
	const p = (y * image.width + x) * 4;
	return [...image.rgba.subarray(p, p + 4)];
}

const isBlue = ([r, g, b]: readonly number[]): boolean => b! > 180 && r! < 80 && g! > 70 && g! < 140;
const isRed = ([r, g, b]: readonly number[]): boolean => r! > 190 && g! < 80 && b! < 80;

function pngDataUrl(png: Uint8Array): string {
	return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
}

/** True when the PDF holds an image XObject carrying a soft mask (its alpha channel). */
function hasImageWithSoftMask(doc: PDFDocument): boolean {
	return doc.context.enumerateIndirectObjects().some(([, object]) => {
		if (!(object instanceof PDFRawStream)) return false;
		return object.dict.get(PDFName.of("Subtype")) === PDFName.of("Image") && object.dict.has(PDFName.of("SMask"));
	});
}

async function bluePagePdf(path: string, pages: number): Promise<void> {
	const doc = await PDFDocument.create();
	for (let i = 0; i < pages; i += 1) {
		const page = doc.addPage([300, 300]);
		page.drawRectangle({ x: 0, y: 0, width: 300, height: 300, color: BLUE });
	}
	writeFileSync(path, await doc.save());
}

describe("PDF image insertion keeps transparency", () => {
	it("decodes an RGBA TIFF in the main process with its alpha channel intact", async () => {
		const dir = workDir();
		const tiffPath = join(dir, "logo.tiff");
		writeFileSync(tiffPath, encodeRgbaTiff(halfTransparentRgba(), W, H));

		const decoded = await decodeImageForPdf(tiffPath);
		// macOS always has a decoder (Dazzi's native core, then sips), so the picture must arrive decoded there.
		if (process.platform === "darwin") expect(decoded.mime).toBe("image/png");
		if (decoded.mime === "image/tiff") {
			// No native/OS decoder on this machine: the raw TIFF goes to the renderer's UTIF decoder unchanged.
			expect(Buffer.from(decoded.bytes).equals(await readFile(tiffPath))).toBe(true);
			return;
		}
		expect(decoded.mime).toBe("image/png");
		const image = pngPixels(decoded.bytes);
		expect([image.width, image.height]).toEqual([W, H]);
		expect(pixelAt(image, 0.25, 0.5)[3]).toBe(0);
		const opaque = pixelAt(image, 0.75, 0.5);
		expect(opaque[3]).toBe(255);
		expect(isRed(opaque)).toBe(true);
	});

	it("refuses formats Chromium decodes itself", async () => {
		await expect(decodeImageForPdf("/tmp/photo.png")).rejects.toThrow(/Unsupported/);
	});

	it("stamps transparent PNG and TIFF images so the page shows through their transparent pixels", async () => {
		const dir = workDir();
		const pdfPath = join(dir, "page.pdf");
		await bluePagePdf(pdfPath, 2);
		const io = createPdfEditorIo(join(dir, "backups"));

		const transparentPng = encodePng(halfTransparentRgba(), W, H);
		const tiffPath = join(dir, "logo.tiff");
		writeFileSync(tiffPath, encodeRgbaTiff(halfTransparentRgba(), W, H));
		const decodedTiff = await decodeImageForPdf(tiffPath);
		const tiffPng = decodedTiff.mime === "image/png" ? decodedTiff.bytes : transparentPng;

		const result = await io.apply({
			path: pdfPath,
			operations: [
				{ kind: "stampImage", pageIndex: 0, pngDataUrl: pngDataUrl(transparentPng), x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
				{ kind: "stampImage", pageIndex: 1, pngDataUrl: pngDataUrl(tiffPng), x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
			],
		});
		expect(result.ok).toBe(true);

		// The alpha channel is stored as an SMask on the embedded image (not flattened onto white or black).
		expect(hasImageWithSoftMask(await PDFDocument.load(await readFile(pdfPath)))).toBe(true);

		// Rendered pixels: blue page through the transparent half, red where the image is opaque.
		for (const pageNumber of [1, 2]) {
			const rendered = pngPixels((await io.renderPageToPng(pdfPath, pageNumber, { dpi: 72 })).png);
			expect(isBlue(pixelAt(rendered, 0.35, 0.5)), `page ${pageNumber} transparent half`).toBe(true);
			expect(isRed(pixelAt(rendered, 0.65, 0.5)), `page ${pageNumber} opaque half`).toBe(true);
			expect(isBlue(pixelAt(rendered, 0.05, 0.05)), `page ${pageNumber} outside the image`).toBe(true);
		}
	});
});
