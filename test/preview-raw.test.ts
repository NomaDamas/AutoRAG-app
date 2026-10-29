import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RAW_EXTENSIONS, readRawPreview, readRawPreviewFromReader } from "../src/preview/node/raw-preview";

/** A minimal marker stream: SOF and SOS with one entropy byte, followed by EOI. */
function jpeg(w: number, h: number, marker = 0xc0): Buffer {
	const sof = Buffer.from([0xff, marker, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]);
	return Buffer.concat([Buffer.from([255, 216]), sof, Buffer.from([255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 17, 255, 217])]);
}

type Entry = readonly [number, number, number, number];

/** An APP1 Exif segment whose IFD0 either omits Orientation or declares it, in either byte order. */
function exifApp1(le: boolean, orientation: number | null): Buffer {
	const b = Buffer.alloc(8 + (orientation === null ? 6 : 18));
	b.write(le ? "II" : "MM");
	const u16 = (v: number, p: number): void => { if (le) b.writeUInt16LE(v, p); else b.writeUInt16BE(v, p); };
	const u32 = (v: number, p: number): void => { if (le) b.writeUInt32LE(v, p); else b.writeUInt32BE(v, p); };
	u16(42, 2); u32(8, 4); u16(orientation === null ? 0 : 1, 8);
	if (orientation === null) u32(0, 10);
	else { u16(0x0112, 10); u16(3, 12); u32(1, 14); u16(orientation, 18); u32(0, 20); }
	const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), b]);
	const segment = Buffer.alloc(4); segment[0] = 255; segment[1] = 225; segment.writeUInt16BE(payload.length + 2, 2);
	return Buffer.concat([segment, payload]);
}

/** The Exif APP1 placed between SOI and the rest of a JPEG. */
function withExif(image: Buffer, app1: Buffer): Buffer {
	return Buffer.concat([image.subarray(0, 2), app1, image.subarray(2)]);
}

function tiff(images: readonly Buffer[], le = true, orientation = 1, magic = 42): Buffer {
	const b = Buffer.alloc(2048);
	b.write(le ? "II" : "MM");
	const u16 = (v: number, p: number): void => { if (le) b.writeUInt16LE(v, p); else b.writeUInt16BE(v, p); };
	const u32 = (v: number, p: number): void => { if (le) b.writeUInt32LE(v, p); else b.writeUInt32BE(v, p); };
	u16(magic, 2); u32(8, 4);
	let at = 1024;
	images.forEach((img, i) => {
		const p = 8 + i * 64;
		const entries: Entry[] = [[0x0201, 4, 1, at], [0x0202, 4, 1, img.length]];
		if (i === 0) entries.push([0x0112, 3, 1, orientation]);
		u16(entries.length, p);
		entries.forEach(([tag, type, count, value], j) => {
			const q = p + 2 + j * 12; u16(tag, q); u16(type, q + 2); u32(count, q + 4);
			if (type === 3) u16(value, q + 8); else u32(value, q + 8);
		});
		u32(i + 1 < images.length ? 8 + (i + 1) * 64 : 0, p + 2 + entries.length * 12);
		img.copy(b, at); at += img.length + 16;
	});
	return b;
}

function memory(bytes: Uint8Array): { size: number; read: (position: number, length: number) => Promise<Uint8Array> } {
	return { size: bytes.length, read: async (position, length) => bytes.subarray(position, position + length) };
}

function box(type: string, body: Buffer, large = false): Buffer {
	const h = Buffer.alloc(large ? 16 : 8); h.writeUInt32BE(large ? 1 : h.length + body.length); h.write(type, 4);
	if (large) h.writeBigUInt64BE(BigInt(h.length + body.length), 8);
	return Buffer.concat([h, body]);
}
function canonPreview(type: string, image: Buffer): Buffer {
	const h = Buffer.alloc(16); h.writeUInt32BE(image.length, type === "THMB" ? 8 : 12);
	return box(type, Buffer.concat([h, image]));
}

/** Write an IFD using the TIFF/MakerNote-relative values supplied by each fixture. */
function directory(b: Buffer, at: number, entries: readonly Entry[]): void {
	b.writeUInt16LE(entries.length, at);
	entries.forEach(([tag, type, count, value], i) => {
		const p = at + 2 + i * 12; b.writeUInt16LE(tag, p); b.writeUInt16LE(type, p + 2); b.writeUInt32LE(count, p + 4);
		if (type === 3 && count === 1) b.writeUInt16LE(value, p + 8); else b.writeUInt32LE(value, p + 8);
	});
	b.writeUInt32LE(0, at + 2 + entries.length * 12);
}

describe("camera RAW embedded previews", () => {
	it("exports all RAW extensions and sniffs generic .raw containers", async () => {
		expect([...RAW_EXTENSIONS]).toEqual(["cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "raw"]);
		const image = jpeg(800, 600);
		for (const le of [true, false]) for (const magic of [42, 0x4f52, 0x5352, 0x55]) {
			expect(await readRawPreviewFromReader(memory(tiff([image], le, 1, magic)), "raw")).toEqual({ bytes: image, mime: "image/jpeg" });
		}
		expect(await readRawPreviewFromReader(memory(tiff([image])), "txt")).toBeNull();
	});

	it("selects largest area, then bytes, and sizes tile/Inspector requests without decoding the largest", async () => {
		const small = jpeg(160, 120), medium = jpeg(800, 600), large = jpeg(4000, 3000);
		const raw = tiff([small, large, medium]);
		expect((await readRawPreviewFromReader(memory(raw), "nef"))?.bytes).toEqual(large);
		expect((await readRawPreviewFromReader(memory(raw), "nef", { want: 128 }))?.bytes).toEqual(small);
		expect((await readRawPreviewFromReader(memory(raw), "nef", { want: 640 }))?.bytes).toEqual(medium);
		expect((await readRawPreviewFromReader(memory(raw), "nef", { want: 9000 }))?.bytes).toEqual(large);
		const padded = Buffer.concat([large, Buffer.alloc(10)]);
		expect((await readRawPreviewFromReader(memory(tiff([large, padded])), "arw"))?.bytes).toEqual(padded);
		const longPadding = Buffer.concat([large, Buffer.alloc(5000)]);
		const paddedRaw = Buffer.concat([tiff([large]), Buffer.alloc(6000)]);
		paddedRaw.writeUInt32LE(longPadding.length, 30); longPadding.copy(paddedRaw, 1024);
		expect((await readRawPreviewFromReader(memory(paddedRaw), "arw"))?.bytes).toEqual(longPadding);
	});

	it("ignores lossless sensor JPEGs and invalid, oversized or truncated candidates", async () => {
		const image = jpeg(800, 600);
		for (const bad of [jpeg(6000, 4000, 0xc3), jpeg(6000, 4000).subarray(0, -2), jpeg(0, 4000), Buffer.from("not JPEG")]) {
			expect((await readRawPreviewFromReader(memory(tiff([bad, image])), "cr2"))?.bytes).toEqual(image);
		}
		const b = tiff([image]); b.writeUInt32LE(25 * 1024 * 1024, 8 + 2 + 12 + 8);
		expect(await readRawPreviewFromReader(memory(b), "cr2")).toBeNull();
	});

	it("inserts IFD0 orientation unless the JPEG's own Exif IFD0 already declares one", async () => {
		const image = jpeg(100, 200);
		const injected = (bytes: Uint8Array, base: Buffer, orientation: number): void => {
			expect([...bytes.subarray(0, 12)]).toEqual([255, 216, 255, 225, 0, 34, 69, 120, 105, 102, 0, 0]);
			expect(Buffer.from(bytes).readUInt16LE(30)).toBe(orientation);
			expect(Buffer.from(bytes.subarray(38))).toEqual(base.subarray(2));
		};
		// No Exif at all, and a sips-style Exif APP1 whose IFD0 has no Orientation tag.
		injected((await readRawPreviewFromReader(memory(tiff([image], true, 6)), "dng"))!.bytes, image, 6);
		for (const le of [true, false]) {
			const sips = withExif(image, exifApp1(le, null));
			injected((await readRawPreviewFromReader(memory(tiff([sips], true, 6)), "dng"))!.bytes, sips, 6);
		}
		// An Exif IFD0 that already carries Orientation (either byte order) is left untouched.
		for (const le of [true, false]) for (const orientation of [1, 6]) {
			const exif = withExif(image, exifApp1(le, orientation));
			expect((await readRawPreviewFromReader(memory(tiff([exif], le, 8)), "dng"))?.bytes).toEqual(exif);
		}
		// An unparsable Exif payload counts as carrying no orientation, so one is injected.
		const garbage = withExif(image, Buffer.from([255, 225, 0, 10, 69, 120, 105, 102, 0, 0, 88, 88]));
		const garbageResult = (await readRawPreviewFromReader(memory(tiff([garbage], true, 3)), "raw"))!.bytes;
		expect([...garbageResult.subarray(0, 4)]).toEqual([255, 216, 255, 225]);
		expect(Buffer.from(garbageResult).readUInt16LE(30)).toBe(3);
		// A non-Exif APP1 (XMP) is not an orientation source.
		const xmp = Buffer.concat([image.subarray(0, 2), Buffer.from([255, 225, 0, 5, 88, 77, 80]), image.subarray(2)]);
		expect(Buffer.from((await readRawPreviewFromReader(memory(tiff([xmp], true, 3)), "raw"))!.bytes).readUInt16LE(30)).toBe(3);
		// An Exif APP1 after the scan still suppresses injection.
		const late = Buffer.concat([image.subarray(0, -2), exifApp1(true, 1), Buffer.from([255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 17, 255, 217])]);
		expect((await readRawPreviewFromReader(memory(tiff([late], true, 6)), "raw"))?.bytes).toEqual(late);
	});

	it("walks SubIFDs and JPEG-compressed strips and RW2 JpgFromRaw", async () => {
		const image = jpeg(1200, 800);
		const b = tiff([image]);
		// IFD0 points to a DNG preview SubIFD, whose compression is JPEG.
		b.writeUInt16LE(1, 8); b.writeUInt16LE(0x14a, 10); b.writeUInt16LE(4, 12); b.writeUInt32LE(1, 14); b.writeUInt32LE(128, 18); b.writeUInt32LE(0, 22);
		b.writeUInt16LE(3, 128);
		for (const [i, [tag, type, value]] of [[0x103, 3, 7], [0x111, 4, 1024], [0x117, 4, image.length]].entries()) {
			const p = 130 + i * 12; b.writeUInt16LE(tag!, p); b.writeUInt16LE(type!, p + 2); b.writeUInt32LE(1, p + 4); b.writeUInt32LE(value!, p + 8);
		}
		expect((await readRawPreviewFromReader(memory(b), "dng"))?.bytes).toEqual(image);
		const rw = tiff([image], true, 1, 0x55); rw.writeUInt16LE(1, 8); rw.writeUInt16LE(0x2e, 10); rw.writeUInt16LE(7, 12); rw.writeUInt32LE(image.length, 14); rw.writeUInt32LE(1024, 18); rw.writeUInt32LE(0, 22);
		expect((await readRawPreviewFromReader(memory(rw), "rw2"))?.bytes).toEqual(image);
	});

	it("resolves Nikon embedded-TIFF, Olympus relative, and Sony absolute MakerNote offsets", async () => {
		const image = jpeg(1800, 1200);
		for (const maker of ["nikon", "olympus", "sony"]) {
			const b = tiff([]); directory(b, 8, [[0x8769, 4, 1, 128], ...(maker === "sony" ? [[0x010f, 2, 5, 96] as const] : [])]);
			b.write("SONY\0", 96); directory(b, 128, [[0x927c, 7, 1500, 256]]); image.copy(b, 1024);
			if (maker === "nikon") {
				b.write("Nikon\0", 256); b[262] = 2; b.write("II", 266); b.writeUInt16LE(42, 268); b.writeUInt32LE(8, 270);
				directory(b, 274, [[0x0011, 4, 1, 512 - 266]]);
				directory(b, 512, [[0x0201, 4, 1, 1024 - 266], [0x0202, 4, 1, image.length]]);
			} else if (maker === "olympus") {
				b.write("OLYMPUS\0II", 256); directory(b, 268, [[0x2020, 13, 1, 512 - 256]]);
				directory(b, 512, [[0x0101, 4, 1, 1024 - 256], [0x0102, 4, 1, image.length]]);
			} else {
				image.copy(b, 1056); b.fill(0, 1024, 1056);
				directory(b, 256, [[0x2001, 7, image.length + 32, 1024]]);
			}
			expect((await readRawPreviewFromReader(memory(b), maker === "olympus" ? "orf" : maker === "sony" ? "arw" : "nef"))?.bytes).toEqual(image);
		}
	});

	it("reads CR3 PRVW/THMB and large-size boxes", async () => {
		const small = jpeg(160, 120), large = jpeg(6000, 4000);
		const uuid = Buffer.from("eaf42b5e1c984b88b9fbb7dc406e4d16", "hex");
		const raw = Buffer.concat([box("ftyp", Buffer.from([99, 114, 120, 32, 0, 0, 0, 1])), box("uuid", Buffer.concat([uuid, Buffer.alloc(8), canonPreview("THMB", small), canonPreview("PRVW", large)]), true)]);
		expect((await readRawPreviewFromReader(memory(raw), "cr3"))?.bytes).toEqual(large);
		expect((await readRawPreviewFromReader(memory(raw), "cr3", { want: 128 }))?.bytes).toEqual(small);
	});

	it("locates a full-size CR3 JPEG track in mdat and retains CMT1 orientation", async () => {
		const image = jpeg(6000, 4000), small = jpeg(160, 120);
		const ftyp = box("ftyp", Buffer.from("crx "));
		const stsz = Buffer.alloc(16); stsz.writeUInt32BE(1, 8); stsz.writeUInt32BE(image.length, 12);
		const co64 = Buffer.alloc(16); co64.writeUInt32BE(1, 4);
		const uuid = Buffer.from("85c0b687820f11e08111f4ce462b6a48", "hex");
		const cmt = tiff([]); directory(cmt, 8, [[0x0112, 3, 1, 6]]);
		const metadata = box("uuid", Buffer.concat([uuid, box("CMT1", cmt.subarray(0, 26)), canonPreview("THMB", small)]));
		const track = (): Buffer => {
			const stbl = box("stbl", Buffer.concat([box("stsz", stsz), box("co64", co64)]));
			return box("moov", Buffer.concat([metadata, box("trak", box("mdia", box("minf", stbl)))]));
		};
		co64.writeBigUInt64BE(BigInt(ftyp.length + track().length + 8), 8);
		const raw = Buffer.concat([ftyp, track(), box("mdat", image)]);
		const result = await readRawPreviewFromReader(memory(raw), "cr3");
		expect(Buffer.from(result!.bytes).readUInt16LE(30)).toBe(6);
		expect(Buffer.from(result!.bytes.subarray(38))).toEqual(image.subarray(2));
	});

	it("returns null for garbage/truncation/cyclic IFDs and bounds metadata traversal", async () => {
		for (const b of [Buffer.alloc(0), Buffer.from("garbage"), tiff([]), tiff([jpeg(1, 1)]).subarray(0, 20)]) expect(await readRawPreviewFromReader(memory(b), "raw")).toBeNull();
		const b = tiff([]); b.writeUInt16LE(0, 8); b.writeUInt32LE(8, 10);
		expect(await readRawPreviewFromReader(memory(b), "raw")).toBeNull();
		const badBox = Buffer.alloc(24); badBox.writeUInt32BE(1); badBox.write("ftyp", 4); badBox.writeBigUInt64BE(2n ** 63n, 8);
		expect(await readRawPreviewFromReader(memory(badBox), "cr3")).toBeNull();
		// Each linked directory consumes 49 KiB; the metadata budget stops traversal before 256 IFDs.
		const bomb = Buffer.alloc(5 * 1024 * 1024); bomb.write("II"); bomb.writeUInt16LE(42, 2); bomb.writeUInt32LE(8, 4);
		for (let i = 0; i < 100; i++) { const p = 8 + i * 50000; bomb.writeUInt16LE(4096, p); bomb.writeUInt32LE(8 + (i + 1) * 50000, p + 2 + 4096 * 12); }
		let total = 0;
		expect(await readRawPreviewFromReader({ size: bomb.length, read: async (p, n) => { total += n; return bomb.subarray(p, p + n); } }, "raw")).toBeNull();
		expect(total).toBeLessThanOrEqual(4 * 1024 * 1024);
		expect(await readRawPreviewFromReader({ size: 100, read: async () => new Uint8Array() }, "raw")).toBeNull();
	});

	it("reads only metadata plus the selected JPEG from a 64 MiB sparse file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "autorag-raw-")); const path = join(dir, "large.raw");
		const image = jpeg(640, 480); const b = tiff([image]); const offset = 63 * 1024 * 1024; b.writeUInt32LE(offset, 18);
		await writeFile(path, b.subarray(0, 1024)); const handle = await open(path, "r+");
		try {
			await handle.truncate(64 * 1024 * 1024); await handle.write(image, 0, image.length, offset);
			let total = 0;
			const result = await readRawPreviewFromReader({ size: 64 * 1024 * 1024, read: async (position, length) => { total += length; const out = Buffer.alloc(length); const { bytesRead } = await handle.read(out, 0, length, position); return out.subarray(0, bytesRead); } }, "raw");
			expect(result?.bytes).toEqual(image); expect(total).toBeLessThan(16 * 1024);
			expect(Buffer.from((await readRawPreview(path, "raw"))!.bytes)).toEqual(image);
		} finally { await handle.close(); await rm(dir, { recursive: true, force: true }); }
	});
});
