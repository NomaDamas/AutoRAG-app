export interface ZipEntry {
	readonly name: string;
	readonly compressedSize: number;
	readonly uncompressedSize: number;
	/** Local-time modification stamp in ms since the epoch; null when the DOS fields are not a real date. */
	readonly modified: number | null;
	/** 0 stored, 8 deflate. */
	readonly method: number;
	/** Where the entry's local header starts, from the beginning of the archive. */
	readonly headerOffset: number;
}

/** A ZIP's central directory stores at most this many entries (the 16-bit count in the end record). */
const MAX_ENTRIES = 0xffff;

/** MS-DOS date/time pair as ZIP stores it; null for the zeroed or out-of-range stamps some tools write. */
function dosTime(date: number, time: number): number | null {
	const month = (date >> 5) & 15;
	const day = date & 31;
	if (month < 1 || month > 12 || day < 1) return null;
	const stamp = new Date(((date >> 9) & 127) + 1980, month - 1, day, time >> 11, (time >> 5) & 63, (time & 31) * 2).getTime();
	return Number.isNaN(stamp) ? null : stamp;
}

function u16(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
	return u16(bytes, offset) | (u16(bytes, offset + 2) << 16);
}

function findEocd(bytes: Uint8Array): number {
	const min = Math.max(0, bytes.length - 22 - 65535);
	for (let index = bytes.length - 22; index >= min; index -= 1) {
		if (bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x05 && bytes[index + 3] === 0x06) {
			return index;
		}
	}
	return -1;
}

/** Where the central directory sits in the archive: enough to read just that range of a large file. */
export function locateZipDirectory(bytes: Uint8Array): { readonly offset: number; readonly size: number } | null {
	const eocd = findEocd(bytes);
	if (eocd < 0) return null;
	const size = u32(bytes, eocd + 12);
	const offset = u32(bytes, eocd + 16);
	// 0xffffffff means the real values live in a ZIP64 record this reader does not parse.
	return size === 0xffffffff || offset === 0xffffffff ? null : { offset, size };
}

/**
 * The archive's entries, directories included. `base` is the archive offset
 * `bytes` starts at, so a slice holding only the central directory and the end
 * record can be listed without reading the rest of the file.
 */
export function listZipEntries(bytes: Uint8Array, base = 0): readonly ZipEntry[] | null {
	const eocd = findEocd(bytes);
	if (eocd < 0) return null;
	const count = Math.min(u16(bytes, eocd + 10), MAX_ENTRIES);
	let offset = u32(bytes, eocd + 16) - base;
	const entries: ZipEntry[] = [];
	for (let index = 0; index < count; index += 1) {
		if (offset < 0 || offset + 46 > bytes.length || u32(bytes, offset) !== 0x02014b50) break;
		const method = u16(bytes, offset + 10);
		const modified = dosTime(u16(bytes, offset + 14), u16(bytes, offset + 12));
		const compressedSize = u32(bytes, offset + 20);
		const uncompressedSize = u32(bytes, offset + 24);
		const nameLength = u16(bytes, offset + 28);
		const extraLength = u16(bytes, offset + 30);
		const commentLength = u16(bytes, offset + 32);
		const headerOffset = u32(bytes, offset + 42);
		const nameStart = offset + 46;
		const name = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(nameStart, nameStart + nameLength));
		entries.push({ name, compressedSize, uncompressedSize, modified, method, headerOffset });
		offset = nameStart + nameLength + extraLength + commentLength;
	}
	return entries;
}
