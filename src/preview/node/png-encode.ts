import { zlibSync } from "fflate";

/** The eight bytes that start every PNG. */
const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Colour type 6 is truecolour with alpha: four 8-bit samples per pixel. */
const RGBA_COLOUR_TYPE = 6;
/** The IDAT is deflated as one block; a preview has nothing to gain from splitting it. */
const DEFLATE_LEVEL = 6;

/** The CRC-32 (IEEE 802.3) table every PNG chunk's checksum is built from. */
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		table[index] = value >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: its length, type, data, and the CRC over type and data. */
function chunk(type: string, data: Uint8Array): Uint8Array {
	const body = new Uint8Array(4 + data.length);
	for (let index = 0; index < 4; index += 1) body[index] = type.charCodeAt(index);
	body.set(data, 4);
	const bytes = new Uint8Array(12 + data.length);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, data.length);
	bytes.set(body, 4);
	view.setUint32(8 + data.length, crc32(body));
	return bytes;
}

/**
 * A PNG of `rgba` — four bytes per pixel, row by row — at `width` x `height`.
 * The samples go out straight (no filtering, no palette); the caller's buffer
 * is only read. Throws a `RangeError` for a size or a length no image can
 * have, since that is a programming error rather than a broken file.
 */
export function encodePng(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
	if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
		throw new RangeError(`invalid picture size ${width}x${height}`);
	}
	const expected = width * height * 4;
	if (rgba.length !== expected) throw new RangeError(`expected ${expected} bytes of RGBA, got ${rgba.length}`);
	const stride = width * 4;
	const scanlines = new Uint8Array((stride + 1) * height);
	for (let row = 0; row < height; row += 1) {
		const from = row * stride;
		scanlines.set(rgba.subarray(from, from + stride), row * (stride + 1) + 1);
	}
	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	header[8] = 8; // bit depth
	header[9] = RGBA_COLOUR_TYPE;
	// The last three bytes stay zero: deflate, then the unfiltered row filter, then no interlace.
	const parts = [SIGNATURE, chunk("IHDR", header), chunk("IDAT", zlibSync(scanlines, { level: DEFLATE_LEVEL })), chunk("IEND", new Uint8Array(0))];
	const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		png.set(part, offset);
		offset += part.length;
	}
	return png;
}
