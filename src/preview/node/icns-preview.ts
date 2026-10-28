import { type FileHandle, open } from "node:fs/promises";
import type { EmbeddedThumbnail } from "./odf";

/** `icns`, the four bytes that start every icon set. */
const SIGNATURE = [0x69, 0x63, 0x6e, 0x73] as const;
/** An entry starts with its four-character type and its length, both big endian. */
const ENTRY_HEADER_BYTES = 8;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
/** A PNG head: signature, IHDR chunk length, `IHDR`, width, height. */
const PNG_HEAD_BYTES = 24;
const IHDR_WIDTH = 16;
const IHDR_HEIGHT = 20;
/** No icon entry is this big; a larger claim is a corrupt table. */
const ENTRY_BYTE_CAP = 32 * 1024 * 1024;
/** A corrupt table cannot make the walk spin either. */
const MAX_ENTRIES = 1024;

export interface IcnsReadOptions {
	/** Longest-side pixel size the caller needs; omitted means the largest entry the set holds. */
	readonly want?: number;
	/** Called with the length of every range read, so a caller can see only headers and the chosen payload were read. */
	readonly onRead?: (bytes: number) => void;
}

interface Candidate {
	readonly offset: number;
	readonly length: number;
	/** Longest side of the icon, from its IHDR. */
	readonly side: number;
	readonly area: number;
}

function uint32(bytes: Uint8Array, offset: number): number {
	return (((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)) >>> 0;
}

function matches(bytes: Uint8Array, signature: readonly number[]): boolean {
	return signature.every((byte, index) => byte === bytes[index]);
}

async function readRange(handle: FileHandle, position: number, length: number, onRead?: (bytes: number) => void): Promise<Uint8Array | null> {
	const bytes = new Uint8Array(length);
	const { bytesRead } = await handle.read(bytes, 0, length, position);
	onRead?.(bytesRead);
	return bytesRead === length ? bytes : null;
}

/**
 * The PNG entry an icon set should be shown with, or null when it holds none
 * (or is damaged, or is not an `icns`). Only entry headers and the IHDR of each
 * PNG entry are read while choosing, plus the bytes of the winner: a set that
 * carries an uncompressed 4MB JPEG2000 entry costs nothing extra.
 *
 * Size decides. With `want` the smallest entry whose longest side is at least
 * that big wins, so a Finder tile does not decode a 1024px icon for a 32px
 * slot; the largest wins when `want` is omitted, and when no entry reaches it.
 */
export async function readIcnsPreview(path: string, options: IcnsReadOptions = {}): Promise<EmbeddedThumbnail | null> {
	const want = options.want ?? Number.POSITIVE_INFINITY;
	const handle = await open(path, "r");
	try {
		const { size } = await handle.stat();
		const header = await readRange(handle, 0, ENTRY_HEADER_BYTES, options.onRead);
		if (header === null || !matches(header, SIGNATURE)) return null;
		const declared = uint32(header, 4);
		if (declared < ENTRY_HEADER_BYTES) return null;
		// A length past the end of the file is a truncated download, not a licence to read past it.
		const end = Math.min(declared, size);
		let offset = ENTRY_HEADER_BYTES;
		// Two entries can win: the largest, and the smallest one that still covers `want`.
		let largest: Candidate | null = null;
		let covering: Candidate | null = null;
		for (let seen = 0; offset + ENTRY_HEADER_BYTES <= end && seen < MAX_ENTRIES; seen += 1) {
			const entry = await readRange(handle, offset, ENTRY_HEADER_BYTES, options.onRead);
			if (entry === null) break;
			const length = uint32(entry, 4);
			// An entry claiming a body the file does not hold ends the table; what was read stands.
			if (length < ENTRY_HEADER_BYTES || offset + length > end) break;
			const payload = length - ENTRY_HEADER_BYTES;
			if (payload >= PNG_HEAD_BYTES && payload <= ENTRY_BYTE_CAP) {
				const head = await readRange(handle, offset + ENTRY_HEADER_BYTES, PNG_HEAD_BYTES, options.onRead);
				if (head !== null && matches(head, PNG_SIGNATURE)) {
					const side = Math.max(uint32(head, IHDR_WIDTH), uint32(head, IHDR_HEIGHT));
					const area = uint32(head, IHDR_WIDTH) * uint32(head, IHDR_HEIGHT);
					const candidate = { offset: offset + ENTRY_HEADER_BYTES, length: payload, side, area };
					// Equal sizes keep the first entry, so the same set always draws the same icon.
					if (largest === null || area > largest.area) largest = candidate;
					if (side >= want && (covering === null || area < covering.area)) covering = candidate;
				}
			}
			offset += length;
		}
		const chosen = covering ?? largest;
		if (chosen === null) return null;
		const bytes = await readRange(handle, chosen.offset, chosen.length, options.onRead);
		return bytes === null ? null : { bytes, mime: "image/png" };
	} finally {
		await handle.close();
	}
}
