/**
 * Synthetic EXIF fixtures for the image-metadata tests and the manual-QA
 * script. They are built by hand (TIFF header + IFD0 + Exif IFD) so no binary
 * photograph has to live in the repository, and the tag values the tests assert
 * on are all visible here.
 */

const TYPE_SIZE = { ascii: 1, short: 2, long: 4, rational: 8 } as const;
type EntryType = keyof typeof TYPE_SIZE;

interface Entry {
	readonly tag: number;
	readonly type: EntryType;
	/** ASCII byte length, or 1 for scalar/rational values. */
	readonly count: number;
	/** Inline value for SHORT/LONG; null when the value lives in the data area. */
	readonly inline: number | null;
	/** Out-of-line bytes (ASCII/RATIONAL); null for inline values. */
	readonly bytes: Uint8Array | null;
	/** Marks the Exif-IFD pointer entry. */
	readonly pointer?: "exif";
}

const encoder = new TextEncoder();

function ascii(tag: number, text: string): Entry {
	const bytes = encoder.encode(`${text}\0`);
	return { tag, type: "ascii", count: bytes.length, inline: null, bytes };
}

function short(tag: number, value: number): Entry {
	return { tag, type: "short", count: 1, inline: value, bytes: null };
}

function long(tag: number, value: number): Entry {
	return { tag, type: "long", count: 1, inline: value, bytes: null };
}

function rational(tag: number, numerator: number, denominator: number): Entry {
	const bytes = new Uint8Array(8);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, numerator);
	view.setUint32(4, denominator);
	return { tag, type: "rational", count: 1, inline: null, bytes };
}

function ifdByteLength(count: number): number {
	return 2 + count * 12 + 4;
}

function align2(value: number): number {
	return value % 2 === 0 ? value : value + 1;
}

/** The little sample TIFF image the JPEG APP1 segment wraps. */
export function buildExifTiff(): Uint8Array {
	const ifd0: readonly Entry[] = [
		ascii(0x010f, "TestMake"), // Make
		ascii(0x0110, "TestModel"), // Model
		short(0x0112, 1), // Orientation: horizontal
		ascii(0x0131, "TestSoftware"), // Software
		ascii(0x0132, "2026:01:02 03:04:05"), // ModifyDate
		{ tag: 0x8769, type: "long", count: 1, inline: null, bytes: null, pointer: "exif" },
	];
	const exif: readonly Entry[] = [
		rational(0x829a, 1, 125), // ExposureTime
		rational(0x829d, 28, 10), // FNumber 2.8
		short(0x8827, 400), // ISO
		ascii(0x9003, "2026:01:02 03:04:05"), // DateTimeOriginal
		rational(0x920a, 35, 1), // FocalLength 35mm
		long(0xa002, 4000), // ExifImageWidth
		long(0xa003, 3000), // ExifImageHeight
		ascii(0xa434, "TestLens 24-70"), // LensModel
	];

	// Layout: header, IFD0, IFD0 out-of-line values, Exif IFD, Exif values.
	const headerSize = 8;
	const ifd0Offset = headerSize;
	const ifd0End = ifd0Offset + ifdByteLength(ifd0.length);
	let cursor = ifd0End;
	const placed = new Map<Entry, number>();
	for (const entry of ifd0) {
		if (entry.bytes === null) continue;
		placed.set(entry, cursor);
		cursor = align2(cursor + entry.bytes.length);
	}
	const exifOffset = cursor;
	cursor += ifdByteLength(exif.length);
	for (const entry of exif) {
		if (entry.bytes === null) continue;
		placed.set(entry, cursor);
		cursor = align2(cursor + entry.bytes.length);
	}

	const out = new Uint8Array(cursor);
	const view = new DataView(out.buffer);
	view.setUint16(0, 0x4d4d); // "MM" — big endian
	view.setUint16(2, 0x002a);
	view.setUint32(4, ifd0Offset);

	const writeIfd = (offset: number, entries: readonly Entry[], exifPointer: number): void => {
		view.setUint16(offset, entries.length);
		let at = offset + 2;
		for (const entry of entries) {
			view.setUint16(at, entry.tag);
			view.setUint16(at + 2, { ascii: 2, short: 3, long: 4, rational: 5 }[entry.type]);
			view.setUint32(at + 4, entry.count);
			if (entry.pointer === "exif") {
				view.setUint32(at + 8, exifPointer);
			} else if (entry.inline !== null) {
				if (entry.type === "short") view.setUint16(at + 8, entry.inline);
				else view.setUint32(at + 8, entry.inline);
			} else {
				view.setUint32(at + 8, placed.get(entry) ?? 0);
			}
			at += 12;
		}
		view.setUint32(at, 0);
	};
	writeIfd(ifd0Offset, ifd0, exifOffset);
	writeIfd(exifOffset, exif, 0);
	for (const [entry, offset] of placed) out.set(entry.bytes as Uint8Array, offset);
	return out;
}

/** A minimal JPEG whose only segment is the App1 EXIF block. */
export function buildExifJpeg(): Uint8Array {
	const tiff = buildExifTiff();
	const payload = new Uint8Array(6 + tiff.length);
	payload.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0); // "Exif\0\0"
	payload.set(tiff, 6);
	const segmentLength = payload.length + 2;
	const app1 = new Uint8Array(4 + payload.length);
	app1[0] = 0xff;
	app1[1] = 0xe1;
	app1[2] = (segmentLength >> 8) & 0xff;
	app1[3] = segmentLength & 0xff;
	app1.set(payload, 4);

	const out = new Uint8Array(2 + app1.length + 2);
	out[0] = 0xff;
	out[1] = 0xd8; // SOI
	out.set(app1, 2);
	out[out.length - 2] = 0xff;
	out[out.length - 1] = 0xd9; // EOI
	return out;
}

/** A plain JPEG with no EXIF segment. */
export function buildPlainJpeg(): Uint8Array {
	return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
}
