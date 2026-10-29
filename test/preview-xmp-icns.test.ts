import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readIcnsPreview } from "../src/preview/node/icns-preview";
import { readXmpThumbnail } from "../src/preview/node/xmp-thumbnail";

/** What an Adobe app writes into `xmpGImg:image`: a small JPEG, whole. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0xff, 0xd9]);
const PNG_SIGNATURE_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const FILLER = Buffer.alloc(1024 * 1024, 0x20);
const PACKET_OPEN = '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>';
const PACKET_CLOSE = '<?xpacket end="w"?>';
const BASE64 = Buffer.from(JPEG).toString("base64");

async function withFile<T>(bytes: Uint8Array, body: (path: string) => Promise<T>, name = "sample.ai"): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "autorag-preview-"));
	try {
		const path = join(dir, name);
		await writeFile(path, bytes);
		return await body(path);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function total(bytes: readonly number[]): number {
	return bytes.reduce((sum, value) => sum + value, 0);
}

/** An XMP packet holding `body` inside an rdf:Description, the way Illustrator writes it. */
function packet(body: string): string {
	return `${PACKET_OPEN}<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description>${body}</rdf:Description></rdf:RDF></x:xmpmeta>${PACKET_CLOSE}`;
}

function element(image = BASE64): string {
	return `<xmpGImg:image>${image}</xmpGImg:image>`;
}

/** A PNG entry payload: the signature and an IHDR, then marker bytes to tell entries apart. */
function pngPayload(width: number, height: number, marker: number): Buffer {
	const bytes = Buffer.alloc(24 + 16, marker);
	Buffer.from(PNG_SIGNATURE_BYTES).copy(bytes, 0);
	bytes.writeUInt32BE(13, 8);
	bytes.write("IHDR", 12, "latin1");
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return bytes;
}

/** A JPEG2000 signature box, the head of an `ic09`-style entry on modern macOS. */
function jp2Payload(marker: number, body = 0): Buffer {
	return Buffer.concat([Buffer.from([0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a]), Buffer.alloc(body, marker)]);
}

function entry(type: string, payload: Uint8Array): Buffer {
	const header = Buffer.alloc(8);
	header.write(type, 0, "latin1");
	header.writeUInt32BE(payload.length + 8, 4);
	return Buffer.concat([header, Buffer.from(payload)]);
}

function icnsFile(entries: readonly Uint8Array[], declared?: number): Buffer {
	const body = Buffer.concat(entries.map((part) => Buffer.from(part)));
	const header = Buffer.alloc(8);
	header.write("icns", 0, "latin1");
	header.writeUInt32BE(declared ?? body.length + 8, 4);
	return Buffer.concat([header, body]);
}

/** The chosen entry's bytes as plain numbers: the fixture is a Buffer and the result a Uint8Array. */
async function chosen(path: string, want?: number): Promise<number[]> {
	const thumbnail = await readIcnsPreview(path, want === undefined ? {} : { want });
	return Array.from(thumbnail?.bytes ?? []);
}

const SMALL = pngPayload(128, 128, 7);
const MEDIUM = pngPayload(256, 256, 8);
const LARGE = pngPayload(512, 512, 9);
const HUGE = pngPayload(1024, 1024, 10);
const ICON_SET = icnsFile([
	entry("TOC ", Buffer.alloc(96, 0x01)),
	entry("is32", Buffer.alloc(560, 0x91)),
	entry("s8mk", Buffer.alloc(256, 0x00)),
	entry("il32", Buffer.alloc(1588, 0x92)),
	entry("jp2 ", jp2Payload(0x93)),
	entry("ic07", SMALL),
	entry("ic08", MEDIUM),
	entry("ic09", LARGE),
	entry("ic13", MEDIUM),
	entry("ic10", HUGE),
]);

describe("readXmpThumbnail", () => {
	it("decodes the base64 JPEG inside xmpGImg:image", async () => {
		const text = `%PDF-1.5\n1 0 obj\n<</Metadata 2 0 R>>\nstream\n${packet(element())}\nendstream\n`;
		await withFile(Buffer.from(text, "latin1"), async (path) => {
			expect(await readXmpThumbnail(path)).toEqual({ bytes: JPEG, mime: "image/jpeg" });
		});
	});

	it("splices out the &#xA;/&#x20; entities and the newlines a writer wraps the base64 with", async () => {
		const wrapped = `${BASE64.slice(0, 8)}&#xA;${BASE64.slice(8, 12)}\r\n   &#x20;${BASE64.slice(12)}`;
		await withFile(Buffer.from(packet(element(wrapped)), "latin1"), async (path) => {
			expect(await readXmpThumbnail(path)).toEqual({ bytes: JPEG, mime: "image/jpeg" });
		});
	});

	it("takes the attribute form as well as the element form", async () => {
		const attributes = `<rdf:Description xmpGImg:format="JPEG" xmpGImg:width="256" xmpGImg:height="256" xmpGImg:image="${BASE64}"/>`;
		await withFile(Buffer.from(packet(attributes), "latin1"), async (path) => {
			expect(await readXmpThumbnail(path)).toEqual({ bytes: JPEG, mime: "image/jpeg" });
		});
	});

	it("finds the packet in the tail of a file too large to scan whole", async () => {
		const bytes = Buffer.concat([FILLER, FILLER, FILLER, FILLER, Buffer.from(packet(element()), "latin1"), FILLER]);
		await withFile(bytes, async (path) => {
			const reads: number[] = [];
			expect(await readXmpThumbnail(path, { onRead: (count) => reads.push(count) })).toEqual({ bytes: JPEG, mime: "image/jpeg" });
			expect(total(reads)).toBeLessThan(bytes.length);
		});
	});

	it("scans both ends and nothing else", async () => {
		// The packet sits in the middle, where a bounded scan never looks.
		const bytes = Buffer.concat([FILLER, FILLER, Buffer.from(packet(element()), "latin1"), FILLER, FILLER, FILLER]);
		await withFile(bytes, async (path) => {
			const reads: number[] = [];
			expect(await readXmpThumbnail(path, { onRead: (count) => reads.push(count) })).toBeNull();
			expect(total(reads)).toBe(4 * 1024 * 1024);
			expect(total(reads)).toBeLessThan(bytes.length);
		});
	});

	it("is null rather than guessing when a window cuts the packet", async () => {
		const inside = Buffer.concat([FILLER, Buffer.from(element(), "latin1"), FILLER, FILLER, FILLER, FILLER, FILLER]);
		await withFile(inside, async (path) => {
			expect(await readXmpThumbnail(path)).toEqual({ bytes: JPEG, mime: "image/jpeg" });
		});
		// The element opens just inside the first window and closes just outside it.
		const cut = Buffer.concat([Buffer.alloc(2 * 1024 * 1024 - 20, 0x20), Buffer.from(element(), "latin1"), FILLER, FILLER, FILLER]);
		await withFile(cut, async (path) => {
			expect(await readXmpThumbnail(path)).toBeNull();
		});
	});

	it("is null for a payload that is not a JPEG, an empty element, and a file with no XMP", async () => {
		await withFile(Buffer.from(packet(element(Buffer.from(PNG_SIGNATURE_BYTES).toString("base64"))), "latin1"), async (path) => {
			expect(await readXmpThumbnail(path)).toBeNull();
		});
		await withFile(Buffer.from(packet("<xmpGImg:image></xmpGImg:image>"), "latin1"), async (path) => {
			expect(await readXmpThumbnail(path)).toBeNull();
		});
		await withFile(Buffer.from(packet(element("not base64 at all!!")), "latin1"), async (path) => {
			expect(await readXmpThumbnail(path)).toBeNull();
		});
		await withFile(new TextEncoder().encode("%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 1 1\n%%EOF\n"), async (path) => {
			expect(await readXmpThumbnail(path)).toBeNull();
		});
	});
});

describe("readIcnsPreview", () => {
	it("returns the largest PNG entry when the caller does not say how big it needs", async () => {
		await withFile(ICON_SET, async (path) => {
			expect(await chosen(path)).toEqual(Array.from(HUGE));
			expect((await readIcnsPreview(path))?.mime).toBe("image/png");
		});
	});

	it("returns the smallest entry that is at least as big as `want`", async () => {
		await withFile(ICON_SET, async (path) => {
			expect(await chosen(path, 32)).toEqual(Array.from(SMALL));
			expect(await chosen(path, 128)).toEqual(Array.from(SMALL));
			expect(await chosen(path, 200)).toEqual(Array.from(MEDIUM));
			expect(await chosen(path, 256)).toEqual(Array.from(MEDIUM));
			expect(await chosen(path, 512)).toEqual(Array.from(LARGE));
			expect(await chosen(path, 600)).toEqual(Array.from(HUGE));
		});
	});

	it("falls back to the largest entry when no entry is that big", async () => {
		await withFile(ICON_SET, async (path) => {
			expect(await chosen(path, 4096)).toEqual(Array.from(HUGE));
		});
	});

	it("reads the entry headers and the chosen payload only, however large the others are", async () => {
		const set = icnsFile([entry("TOC ", Buffer.alloc(96, 0x01)), entry("jp2 ", jp2Payload(0x94, 4 * 1024 * 1024)), entry("ic07", SMALL)]);
		await withFile(set, async (path) => {
			const reads: number[] = [];
			expect(Array.from((await readIcnsPreview(path, { onRead: (count) => reads.push(count) }))?.bytes ?? [])).toEqual(Array.from(SMALL));
			expect(total(reads)).toBeLessThan(64 * 1024);
		});
	});

	it("skips a cut PNG head and stops at an entry that overruns the file", async () => {
		const cut = Buffer.concat([Buffer.from(PNG_SIGNATURE_BYTES), Buffer.alloc(4)]);
		await withFile(icnsFile([entry("ic09", cut), entry("ic10", HUGE)]), async (path) => {
			expect(await chosen(path)).toEqual(Array.from(HUGE));
		});
		// A last entry claiming a body the file does not hold: the entries before it still count.
		const overrun = Buffer.alloc(24);
		overrun.write("ic10", 0, "latin1");
		overrun.writeUInt32BE(4 * 1024 * 1024, 4);
		await withFile(icnsFile([entry("ic07", SMALL), overrun]), async (path) => {
			expect(await chosen(path)).toEqual(Array.from(SMALL));
		});
	});

	it("is null for a file that is not an icns, a truncated header, and a set with no PNG", async () => {
		await withFile(pngPayload(64, 64, 1), async (path) => {
			expect(await readIcnsPreview(path)).toBeNull();
		});
		await withFile(Buffer.from("icns\u0000\u0000", "latin1"), async (path) => {
			expect(await readIcnsPreview(path)).toBeNull();
		});
		await withFile(icnsFile([entry("TOC ", Buffer.alloc(96, 0x01)), entry("is32", Buffer.alloc(560, 0x91)), entry("jp2 ", jp2Payload(0x95))]), async (path) => {
			expect(await readIcnsPreview(path)).toBeNull();
		});
		await withFile(icnsFile([entry("ic07", SMALL)], 4), async (path) => {
			expect(await readIcnsPreview(path)).toBeNull();
		});
	});
});
