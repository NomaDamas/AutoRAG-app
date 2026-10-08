import { type FileHandle, open } from "node:fs/promises";
import { inflateSync } from "fflate";
import { listZipEntries, locateZipDirectory, type ZipEntry } from "../shared/zip-list";

/** The end-of-central-directory record is 22 bytes plus a comment of at most 65535. */
const TAIL_BYTES = 22 + 65535;
/** A local file header is 30 bytes, then a name and an extra field of 16-bit lengths. */
const LOCAL_HEADER = 30;
const LOCAL_HEADER_MAX = LOCAL_HEADER + 2 * 0xffff;
/** The page images iWork stores, best first: the full-size first page, then the web-sized one. */
const PREVIEW_NAMES = ["preview.jpg", "preview-web.jpg"] as const;
/** A first-page image beyond this is not a preview; iWork writes a few hundred KB at most. */
const PREVIEW_BYTE_CAP = 16 * 1024 * 1024;

async function readRange(handle: FileHandle, position: number, length: number): Promise<Uint8Array> {
	const buffer = new Uint8Array(length);
	const { bytesRead } = await handle.read(buffer, 0, length, position);
	return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

function u16(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

async function extract(handle: FileHandle, entry: ZipEntry): Promise<Uint8Array | null> {
	if (entry.uncompressedSize > PREVIEW_BYTE_CAP || entry.compressedSize > PREVIEW_BYTE_CAP) return null;
	const header = await readRange(handle, entry.headerOffset, LOCAL_HEADER_MAX);
	if (header.length < LOCAL_HEADER || u16(header, 0) !== 0x4b50 || u16(header, 2) !== 0x0403) return null;
	const start = LOCAL_HEADER + u16(header, 26) + u16(header, 28);
	const data = await readRange(handle, entry.headerOffset + start, entry.compressedSize);
	if (data.length !== entry.compressedSize) return null;
	if (entry.method === 0) return data;
	if (entry.method === 8) return inflateSync(data, { out: new Uint8Array(entry.uncompressedSize) });
	return null;
}

/**
 * The page image an iWork package (`.numbers`, `.pages`, `.key`) carries: Apple
 * saves a ZIP whose `preview.jpg` is the first sheet, page, or slide exactly as
 * the app drew it, and the rest (`Index/*.iwa`) is protobuf nothing else can
 * render. Only the file's tail (the directory) and that one entry are read, so
 * a multi-gigabyte deck costs the same as a small one. Null when the package
 * is the older directory form, is not a ZIP, or has no image.
 */
export async function readIworkPreview(path: string): Promise<Uint8Array | null> {
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
		for (const name of PREVIEW_NAMES) {
			const entry = entries.find((candidate) => candidate.name === name);
			if (entry !== undefined) return await extract(handle, entry);
		}
		return null;
	} finally {
		await handle.close();
	}
}
