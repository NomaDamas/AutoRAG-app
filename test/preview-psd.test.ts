import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzlibSync } from "fflate";
import { describe, expect, it } from "vitest";
import { encodePng } from "../src/preview/node/png-encode";
import { readPsdComposite, readPsdThumbnail } from "../src/preview/node/psd-preview";

/** The JPEG Photoshop writes into resource 1036: start of image, APP0, end of image. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0xff, 0xd9]);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface Picture {
	readonly width: number;
	readonly height: number;
	readonly pixels: readonly number[];
}

/** CRC-32 over one chunk's type and data, bit by bit: PNG's own check on the encoder. */
function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Reads back a PNG this suite built: signature, IHDR, one zlib IDAT of unfiltered
 * scanlines, IEND, with every chunk's CRC checked the way a decoder does.
 */
function decodePng(png: Uint8Array): Picture {
	expect(Array.from(png.subarray(0, 8))).toEqual(PNG_SIGNATURE);
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	const width = view.getUint32(16);
	const height = view.getUint32(20);
	expect([png[24], png[25], png[26], png[27], png[28]]).toEqual([8, 6, 0, 0, 0]);
	const parts: Uint8Array[] = [];
	const types: string[] = [];
	for (let offset = 8; offset < png.length; ) {
		const length = view.getUint32(offset);
		const type = String.fromCharCode(...Array.from(png.subarray(offset + 4, offset + 8)));
		expect(view.getUint32(offset + 8 + length)).toBe(crc32(png.subarray(offset + 4, offset + 8 + length)));
		types.push(type);
		if (type === "IDAT") parts.push(png.subarray(offset + 8, offset + 8 + length));
		offset += 12 + length;
	}
	expect(types).toEqual(["IHDR", "IDAT", "IEND"]);
	const scanlines = unzlibSync(Buffer.concat(parts));
	const stride = width * 4;
	expect(scanlines.length).toBe((stride + 1) * height);
	const pixels: number[] = [];
	for (let row = 0; row < height; row += 1) {
		expect(scanlines[row * (stride + 1)]).toBe(0);
		for (let i = 1; i <= stride; i += 1) pixels.push(scanlines[row * (stride + 1) + i] ?? 0);
	}
	return { width, height, pixels };
}

async function withFile<T>(bytes: Uint8Array, body: (path: string) => Promise<T>, name = "scan.psd"): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "autorag-psd-"));
	try {
		const path = join(dir, name);
		await writeFile(path, bytes);
		return await body(path);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** A section length: four bytes, or eight bytes in a PSB. */
function section(length: number, large: boolean): Buffer {
	const bytes = Buffer.alloc(large ? 8 : 4);
	if (large) bytes.writeBigUInt64BE(BigInt(length));
	else bytes.writeUInt32BE(length);
	return bytes;
}

/** An `8BIM` image-resource block: id, Pascal name, length-prefixed data, even padding. */
function resource(id: number, data: Buffer, name = ""): Buffer {
	const header = Buffer.alloc(10 + name.length + 1 + ((name.length + 1) % 2));
	header.write("8BIM", 0, "latin1");
	header.writeUInt16BE(id, 4);
	header.writeUInt8(name.length, 6);
	header.write(name, 7, "latin1");
	header.writeUInt32BE(data.length, 7 + name.length + ((name.length + 1) % 2));
	return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
}

/** Resource 1036's 28-byte preamble (`format`, size, compression) in front of the JPEG. */
function thumbnailResource(jpeg: Uint8Array = JPEG, format = 1): Buffer {
	const preamble = Buffer.alloc(28);
	preamble.writeUInt32BE(format, 0);
	preamble.writeUInt32BE(48, 4);
	preamble.writeUInt32BE(40, 8);
	preamble.writeUInt32BE(144, 12);
	preamble.writeUInt32BE(5760, 16);
	preamble.writeUInt32BE(jpeg.length, 20);
	preamble.writeUInt16BE(24, 24);
	preamble.writeUInt16BE(1, 26);
	return resource(1036, Buffer.concat([preamble, Buffer.from(jpeg)]));
}

interface PsdParts {
	readonly version?: 1 | 2;
	readonly channels?: number;
	readonly width?: number;
	readonly height?: number;
	readonly depth?: number;
	readonly mode?: number;
	readonly colorModeData?: Buffer;
	readonly resources?: Buffer;
	readonly layer?: Buffer;
	readonly imageData?: Buffer;
}

/**
 * A PSD/PSB: the 26-byte header, then colour mode data, image resources, the
 * layer-and-mask section, and image data, each with its own length prefix.
 */
function psd(parts: PsdParts = {}): Buffer {
	const version = parts.version ?? 1;
	const large = version === 2;
	const colorModeData = parts.colorModeData ?? Buffer.alloc(0);
	const resources = parts.resources ?? Buffer.alloc(0);
	const layer = parts.layer ?? Buffer.alloc(0);
	const header = Buffer.alloc(26);
	header.write("8BPS", 0, "latin1");
	header.writeUInt16BE(version, 4);
	header.writeUInt16BE(parts.channels ?? 3, 12);
	header.writeUInt32BE(parts.height ?? 4, 14);
	header.writeUInt32BE(parts.width ?? 4, 18);
	header.writeUInt16BE(parts.depth ?? 8, 22);
	header.writeUInt16BE(parts.mode ?? 3, 24);
	// Colour mode data and image resources carry four-byte lengths in a PSB too; only the
	// layer-and-mask section's length is eight bytes there.
	return Buffer.concat([
		header,
		section(colorModeData.length, false),
		colorModeData,
		section(resources.length, false),
		resources,
		section(layer.length, large),
		layer,
		parts.imageData ?? Buffer.alloc(0),
	]);
}

/** The image-data section: raw (uncompressed) samples, one plane per channel. */
function rawImageData(planes: readonly (readonly number[])[]): Buffer {
	return Buffer.concat([Buffer.alloc(2), ...planes.map((plane) => Buffer.from(plane))]);
}

/** Raw 16-bit planes, big endian. */
function rawImageData16(planes: readonly (readonly number[])[]): Buffer {
	const encoded = planes.map((plane) => {
		const bytes = Buffer.alloc(plane.length * 2);
		plane.forEach((value, index) => bytes.writeUInt16BE(value, index * 2));
		return bytes;
	});
	return Buffer.concat([Buffer.alloc(2), ...encoded]);
}

/** One channel plane: `count` copies of a sample value. */
function plane(count: number, value: number): number[] {
	return Array.from({ length: count }, () => value);
}

/** An RLE-compressed composite: the per-row lengths first, then each row's packets. */
function rleImageData(rows: readonly (readonly number[])[]): Buffer {
	const table = Buffer.alloc(rows.length * 2);
	rows.forEach((row, index) => table.writeUInt16BE(row.length, index * 2));
	return Buffer.concat([Buffer.from([0, 1]), table, ...rows.map((row) => Buffer.from(row))]);
}

function total(bytes: readonly number[]): number {
	return bytes.reduce((sum, value) => sum + value, 0);
}

describe("encodePng", () => {
	it("writes a PNG a decoder reads back as the same pixels", () => {
		const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 9, 9, 9, 255]);
		expect(decodePng(encodePng(rgba, 2, 2))).toEqual({ width: 2, height: 2, pixels: Array.from(rgba) });
	});

	it("takes a Uint8ClampedArray, the type a decoded bitmap arrives in", () => {
		const rgba = new Uint8ClampedArray([1, 2, 3, 4]);
		expect(decodePng(encodePng(rgba, 1, 1))).toEqual({ width: 1, height: 1, pixels: [1, 2, 3, 4] });
	});

	it("rejects a size no image can have and a buffer of the wrong length", () => {
		expect(() => encodePng(new Uint8Array(4), 0, 1)).toThrow(RangeError);
		expect(() => encodePng(new Uint8Array(4), 1.5, 1)).toThrow(RangeError);
		expect(() => encodePng(new Uint8Array(7), 1, 2)).toThrow(RangeError);
	});
});

describe("readPsdThumbnail", () => {
	it("returns the JPEG resource 1036 carries", async () => {
		await withFile(psd({ resources: thumbnailResource() }), async (path) => {
			expect(await readPsdThumbnail(path)).toEqual({ bytes: JPEG, mime: "image/jpeg", width: 48, height: 40 });
		});
	});

	it("reaches the resources through the four-byte lengths a PSB still uses there", async () => {
		await withFile(psd({ version: 2, resources: thumbnailResource() }), async (path) => {
			expect(await readPsdThumbnail(path)).toEqual({ bytes: JPEG, mime: "image/jpeg", width: 48, height: 40 });
		});
	});

	it("walks blocks behind a padded Pascal name and an odd-sized payload", async () => {
		const resources = Buffer.concat([
			resource(1005, Buffer.alloc(7, 3), "ab"),
			resource(1064, Buffer.alloc(5, 1), "x"),
			thumbnailResource(),
		]);
		await withFile(psd({ resources }), async (path) => {
			expect(await readPsdThumbnail(path)).toEqual({ bytes: JPEG, mime: "image/jpeg", width: 48, height: 40 });
		});
	});

	it("ignores the raw-pixel resource 1033 and a 1036 that is not a JPEG", async () => {
		const raw = resource(1033, Buffer.alloc(28 + 16, 0x40));
		await withFile(psd({ resources: raw }), async (path) => {
			expect(await readPsdThumbnail(path)).toBeNull();
		});
		const notJpeg = thumbnailResource(new Uint8Array(PNG_SIGNATURE));
		await withFile(psd({ resources: notJpeg }), async (path) => {
			expect(await readPsdThumbnail(path)).toBeNull();
		});
		const rawPixels = thumbnailResource(JPEG, 0);
		await withFile(psd({ resources: rawPixels }), async (path) => {
			expect(await readPsdThumbnail(path)).toBeNull();
		});
	});

	it("is null for a file that is not a PSD, a header-only file, and a damaged resource", async () => {
		await withFile(new TextEncoder().encode("%PDF-1.5 not a photoshop file at all"), async (path) => {
			expect(await readPsdThumbnail(path)).toBeNull();
		});
		await withFile(psd({ resources: thumbnailResource() }).subarray(0, 26), async (path) => {
			expect(await readPsdThumbnail(path)).toBeNull();
		});
		await withFile(psd({ version: 2, resources: thumbnailResource() }).subarray(0, 40), async (path) => {
			expect(await readPsdThumbnail(path)).toBeNull();
		});
		// A block whose length reaches past the end of the resources section.
		const damaged = Buffer.concat([resource(1005, Buffer.alloc(4)), Buffer.from([0x38, 0x42, 0x49, 0x4d, 0x04, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00])]);
		await withFile(psd({ resources: damaged }), async (path) => {
			expect(await readPsdThumbnail(path)).toBeNull();
		});
		// Resources the header claims but the file does not hold.
		const lying = psd({ resources: thumbnailResource() });
		lying.writeUInt32BE(1 << 24, 30);
		await withFile(lying, async (path) => {
			expect(await readPsdThumbnail(path)).toBeNull();
		});
	});

	it("never reads the layer-and-mask or the pixel data, however large they are", async () => {
		const layer = Buffer.alloc(8 * 1024 * 1024, 0x7f);
		await withFile(psd({ resources: thumbnailResource(), layer }), async (path) => {
			const reads: number[] = [];
			expect(await readPsdThumbnail(path, { onRead: (bytes) => reads.push(bytes) })).toEqual({ bytes: JPEG, mime: "image/jpeg", width: 48, height: 40 });
			expect(total(reads)).toBeLessThan(64 * 1024);
		});
	});

	it("does not read a resources section past its cap", async () => {
		const resources = Buffer.alloc(17 * 1024 * 1024, 0x11);
		await withFile(psd({ resources }), async (path) => {
			const reads: number[] = [];
			expect(await readPsdThumbnail(path, { onRead: (bytes) => reads.push(bytes) })).toBeNull();
			expect(total(reads)).toBeLessThan(1024 * 1024);
		});
	});
});

describe("readPsdComposite", () => {
	it("decodes the raw RGB composite and encodes it as a PNG with the same pixels", async () => {
		const red = [10, 20, 30, 40, 50, 60, 70, 80];
		const blue = [1, 2, 3, 4, 5, 6, 7, 8];
		const imageData = rawImageData([red, blue.map(() => 100), blue]);
		await withFile(psd({ width: 4, height: 2, imageData }), async (path) => {
			const composite = await readPsdComposite(path);
			expect(composite?.mime).toBe("image/png");
			expect(decodePng(composite?.bytes ?? new Uint8Array())).toEqual({
				width: 4,
				height: 2,
				pixels: red.flatMap((value, index) => [value, 100, blue[index] ?? 0, 255]),
			});
		});
	});

	it("decodes a PSB composite through the eight-byte layer length", async () => {
		await withFile(psd({ version: 2, width: 2, height: 1, imageData: rawImageData([[1, 2], [3, 4], [5, 6]]) }), async (path) => {
			const composite = await readPsdComposite(path);
			expect(decodePng(composite?.bytes ?? new Uint8Array())).toEqual({ width: 2, height: 1, pixels: [1, 3, 5, 255, 2, 4, 6, 255] });
		});
	});

	it("decodes 16-bit RGB samples and an 8-bit grayscale composite", async () => {
		await withFile(psd({ width: 2, height: 1, depth: 16, imageData: rawImageData16([[0xffff, 0], [0xffff, 0xffff], [0, 0x8000]]) }), async (path) => {
			const composite = await readPsdComposite(path);
			expect(decodePng(composite?.bytes ?? new Uint8Array())).toEqual({ width: 2, height: 1, pixels: [255, 255, 0, 255, 0, 255, 128, 255] });
		});
		await withFile(psd({ width: 2, height: 1, channels: 1, mode: 1, imageData: rawImageData([[0, 128]]) }), async (path) => {
			const composite = await readPsdComposite(path);
			expect(decodePng(composite?.bytes ?? new Uint8Array())).toEqual({ width: 2, height: 1, pixels: [0, 0, 0, 255, 128, 128, 128, 255] });
		});
	});

	it("downscales so the longest side is at most maxSide, averaging whole blocks", async () => {
		const red: number[] = [];
		const blue: number[] = [];
		for (let y = 0; y < 4; y += 1) {
			for (let x = 0; x < 8; x += 1) {
				red.push(Math.floor(x / 2) * 40);
				blue.push(Math.floor(y / 2) * 60);
			}
		}
		const imageData = rawImageData([red, blue.map(() => 0), blue]);
		await withFile(psd({ width: 8, height: 4, imageData }), async (path) => {
			const composite = await readPsdComposite(path, { maxSide: 4 });
			const pixels: number[] = [];
			for (let y = 0; y < 2; y += 1) {
				for (let x = 0; x < 4; x += 1) pixels.push(x * 40, 0, y * 60, 255);
			}
			expect(decodePng(composite?.bytes ?? new Uint8Array())).toEqual({ width: 4, height: 2, pixels });
		});
	});

	it("is null for a blank composite so the caller can fall back to the thumbnail resource", async () => {
		const imageData = rawImageData([plane(16, 255), plane(16, 255), plane(16, 255)]);
		await withFile(psd({ width: 4, height: 4, imageData }), async (path) => {
			expect(await readPsdComposite(path)).toBeNull();
		});
	});

	it("is null without reading image data past maxImageDataBytes", async () => {
		const imageData = rawImageData([plane(256 * 64, 1), plane(256 * 64, 2), plane(256 * 64, 3)]);
		await withFile(psd({ width: 256, height: 64, imageData }), async (path) => {
			const reads: number[] = [];
			expect(await readPsdComposite(path, { maxImageDataBytes: 4096, onRead: (bytes) => reads.push(bytes) })).toBeNull();
			expect(total(reads)).toBeLessThan(4096);
		});
	});

	it("skips a layer-and-mask section of megabytes without reading it", async () => {
		const layer = Buffer.alloc(8 * 1024 * 1024, 0x33);
		const imageData = rawImageData([[9, 1], [8, 2], [7, 3]]);
		await withFile(psd({ width: 2, height: 1, layer, imageData }), async (path) => {
			const reads: number[] = [];
			const composite = await readPsdComposite(path, { onRead: (bytes) => reads.push(bytes) });
			expect(decodePng(composite?.bytes ?? new Uint8Array())).toEqual({ width: 2, height: 1, pixels: [9, 8, 7, 255, 1, 2, 3, 255] });
			expect(total(reads)).toBeLessThan(64 * 1024);
		});
	});

	it("decodes the run-length encoded composite Photoshop actually writes, and refuses a cut one", async () => {
		// Each row is one channel of the two pixels: a packet of two literal samples.
		const imageData = rleImageData([[1, 0x11, 0x22], [1, 0x33, 0x44], [1, 0x55, 0x66]]);
		await withFile(psd({ width: 2, height: 1, imageData }), async (path) => {
			const composite = await readPsdComposite(path);
			expect(decodePng(composite?.bytes ?? new Uint8Array())).toEqual({ width: 2, height: 1, pixels: [0x11, 0x33, 0x55, 255, 0x22, 0x44, 0x66, 255] });
		});
		await withFile(psd({ width: 2, height: 1, imageData: imageData.subarray(0, imageData.length - 3) }), async (path) => {
			expect(await readPsdComposite(path)).toBeNull();
		});
	});

	it("is null, never throws, for a file it cannot decode", async () => {
		await withFile(new Uint8Array(4096), async (path) => {
			expect(await readPsdComposite(path)).toBeNull();
		});
		await withFile(Buffer.from("%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 1 1\n"), async (path) => {
			expect(await readPsdComposite(path)).toBeNull();
		});
		// A layer-and-mask length that reaches past the end of the file.
		const lying = psd({ imageData: rawImageData([[1, 2], [3, 4], [5, 6]]) });
		lying.writeUInt32BE(1 << 20, 34);
		await withFile(lying, async (path) => {
			expect(await readPsdComposite(path)).toBeNull();
		});
		// A composite cut in the middle of its scanlines.
		const cut = psd({ width: 64, height: 64, imageData: rawImageData([plane(4096, 1), plane(2048, 2), plane(2048, 3)]) });
		await withFile(cut, async (path) => {
			expect(await readPsdComposite(path)).toBeNull();
		});
	});
});
