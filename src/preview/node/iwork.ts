import { type FileHandle, open } from "node:fs/promises";
import { extname } from "node:path";
import { inflateSync } from "fflate";
import { keynoteSlideImageNames } from "../shared/iwork-slides";
import { listZipEntries, locateZipDirectory, type ZipEntry } from "../shared/zip-list";

/** The end-of-central-directory record is 22 bytes plus a comment of at most 65535. */
const TAIL_BYTES = 22 + 65535;
/** A local file header is 30 bytes, then a name and an extra field of 16-bit lengths. */
const LOCAL_HEADER = 30;
const LOCAL_HEADER_MAX = LOCAL_HEADER + 2 * 0xffff;
/** The page images iWork stores, best first: the full-size first page, then the web-sized one. */
const PREVIEW_NAMES = ["preview.jpg", "preview-web.jpg"] as const;
/** The Keynote slide tree lives here; its name is the same in every `.key`. */
const DOCUMENT_NAME = "Index/Document.iwa";
/** A first-page image (or one slide) beyond this is not a preview; iWork writes a few hundred KB at most. */
const PREVIEW_BYTE_CAP = 16 * 1024 * 1024;
/** The decompressed slide tree of a normal deck is a few MB; this bounds a corrupt one. */
const DOCUMENT_BYTE_CAP = 64 * 1024 * 1024;
/** Every slide image together may not exceed this, so a huge deck degrades instead of filling memory. */
const SLIDES_BYTE_CAP = 64 * 1024 * 1024;
/** A deck this long is not something the rail can show; degrade to the first slide. */
const MAX_SLIDES = 500;

/** What an iWork package carries for the preview. */
export interface IworkPreview {
	/** The first sheet, page, or slide as the app drew it; null when the package carries no page image. */
	readonly firstPage: Uint8Array | null;
	/** Every Keynote slide's JPEG in order (the quality first-page image comes first); null for Numbers/Pages or an unreadable slide tree. */
	readonly pages: readonly Uint8Array[] | null;
}

async function readRange(handle: FileHandle, position: number, length: number): Promise<Uint8Array> {
	const buffer = new Uint8Array(length);
	const { bytesRead } = await handle.read(buffer, 0, length, position);
	return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

function u16(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

async function extract(handle: FileHandle, entry: ZipEntry, cap: number): Promise<Uint8Array | null> {
	if (entry.uncompressedSize > cap || entry.compressedSize > cap) return null;
	const header = await readRange(handle, entry.headerOffset, LOCAL_HEADER_MAX);
	if (header.length < LOCAL_HEADER || u16(header, 0) !== 0x4b50 || u16(header, 2) !== 0x0403) return null;
	const start = LOCAL_HEADER + u16(header, 26) + u16(header, 28);
	const data = await readRange(handle, entry.headerOffset + start, entry.compressedSize);
	if (data.length !== entry.compressedSize) return null;
	if (entry.method === 0) return data;
	if (entry.method === 8) return inflateSync(data, { out: new Uint8Array(entry.uncompressedSize) });
	return null;
}

/** The full-quality first-page image, or the web-sized one when the package omits it. */
async function readFirstPage(handle: FileHandle, entries: readonly ZipEntry[]): Promise<Uint8Array | null> {
	for (const name of PREVIEW_NAMES) {
		const entry = entries.find((candidate) => candidate.name === name);
		if (entry === undefined) continue;
		const image = await extract(handle, entry, PREVIEW_BYTE_CAP);
		if (image !== null) return image;
	}
	return null;
}

/**
 * Every slide's JPEG in show order, the quality first-page image first. Null
 * when the deck has no readable slide tree, one slide, or more slides than the
 * caps allow; the caller then shows only the first page.
 */
async function readKeySlides(handle: FileHandle, entries: readonly ZipEntry[], firstPage: Uint8Array): Promise<readonly Uint8Array[] | null> {
	const document = entries.find((candidate) => candidate.name === DOCUMENT_NAME);
	if (document === undefined) return null;
	const bytes = await extract(handle, document, DOCUMENT_BYTE_CAP);
	if (bytes === null) return null;
	const names = keynoteSlideImageNames(entries.map((entry) => entry.name), bytes);
	if (names.length === 0 || names.length > MAX_SLIDES) return null;
	if (names.length === 1) return [firstPage];
	let total = 0;
	const slides: Uint8Array[] = [firstPage];
	for (const name of names.slice(1)) {
		const entry = entries.find((candidate) => candidate.name === name);
		if (entry === undefined) return null;
		total += entry.uncompressedSize;
		if (total > SLIDES_BYTE_CAP) return null;
		const image = await extract(handle, entry, PREVIEW_BYTE_CAP);
		if (image === null) return null;
		slides.push(image);
	}
	return slides;
}

/**
 * What an iWork package (`.numbers`, `.pages`, `.key`) carries for the preview.
 * Apple saves a ZIP whose `preview.jpg` is the first sheet, page, or slide
 * exactly as the app drew it, and a Keynote deck also carries a 356px render
 * of every slide under `Data/st-*` plus the show's slide order in
 * `Index/Document.iwa`. Only the file's tail (the directory) and those entries
 * are read, so a multi-gigabyte deck costs the same as a small one. Null when
 * the package is the older directory form, is not a ZIP, or has no image.
 */
export async function readIworkPreview(path: string): Promise<IworkPreview | null> {
	const handle = await open(path, "r");
	try {
		const { size } = await handle.stat();
		const tailLength = Math.min(size, TAIL_BYTES);
		const base = size - tailLength;
		const tail = await readRange(handle, base, tailLength);
		const directory = locateZipDirectory(tail);
		if (directory === null) return null;
		// The directory normally sits inside the tail; a huge one is read on its own.
		const inTail = directory.offset >= base;
		const bytes = inTail ? tail : await readRange(handle, directory.offset, size - directory.offset);
		const entries = listZipEntries(bytes, inTail ? base : directory.offset);
		if (entries === null) return null;
		const firstPage = await readFirstPage(handle, entries);
		if (firstPage === null) return null;
		if (extname(path).toLowerCase() !== ".key") return { firstPage, pages: null };
		const slides = await readKeySlides(handle, entries, firstPage).catch((error: unknown) => {
			console.warn(`quick-look: Keynote slide list for ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		});
		if (slides === null) console.warn(`quick-look: no slide list for ${path}; showing the first slide only`);
		return { firstPage, pages: slides };
	} finally {
		await handle.close();
	}
}
