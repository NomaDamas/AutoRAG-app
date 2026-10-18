import { type FileHandle, open } from "node:fs/promises";
import { inflateSync } from "fflate";
import { listZipEntries, locateZipDirectory, type ZipEntry } from "../shared/zip-list";

/** The end-of-central-directory record is 22 bytes plus a comment of at most 65535. */
const TAIL_BYTES = 22 + 65535;
/** A local file header is 30 bytes, then a name and an extra field of 16-bit lengths. */
const LOCAL_HEADER = 30;
const LOCAL_HEADER_MAX = LOCAL_HEADER + 2 * 0xffff;

async function readRange(handle: FileHandle, position: number, length: number): Promise<Uint8Array> {
	const buffer = new Uint8Array(length);
	const { bytesRead } = await handle.read(buffer, 0, length, position);
	return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

function u16(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

/** The bytes of one entry, or null when it is over `cap`, damaged, or uses a method other than stored/deflate. */
export async function extractZipEntry(handle: FileHandle, entry: ZipEntry, cap: number): Promise<Uint8Array | null> {
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

/**
 * Opens a ZIP, reads only its tail (the directory), and hands `use` the entry
 * list plus the open handle for ranged `extractZipEntry` calls, so a
 * multi-gigabyte package costs the same as a small one. `use` is not called
 * (and null is returned) when the file is not a readable ZIP.
 */
export async function withZip<T>(path: string, use: (handle: FileHandle, entries: readonly ZipEntry[]) => Promise<T>): Promise<T | null> {
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
		return await use(handle, entries);
	} finally {
		await handle.close();
	}
}
