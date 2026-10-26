import { open } from "node:fs/promises";
import { RAW_PHOTO_EXTENSIONS } from "../shared/raster-formats";
import type { EmbeddedThumbnail } from "./odf";

/** Camera containers whose embedded JPEGs can be shown without a RAW decoder. */
export const RAW_EXTENSIONS: ReadonlySet<string> = new Set(RAW_PHOTO_EXTENSIONS);
const JPEG_CAP = 24 * 1024 * 1024;
const METADATA_CAP = 4 * 1024 * 1024;
const ITEM_CAP = 256;
const damaged = Symbol("damaged RAW metadata");

/** Ranges must be exact; this seam also lets callers account for all bytes read. */
export interface RawPreviewReader {
	readonly size: number;
	read(position: number, length: number): Promise<Uint8Array>;
}
export interface RawPreviewOptions {
	/** Required longest side; omitted/Infinity means the best available preview. */
	readonly want?: number;
}
interface Candidate { readonly offset: number; readonly length: number }
interface Jpeg extends Candidate { readonly width: number; readonly height: number }
interface TiffContext { readonly base: number; readonly end: number; readonly le: boolean; readonly maker: string }
interface Entry { readonly type: number; readonly count: number; readonly at: number; readonly length: number }

function number(bytes: Uint8Array, at: number, width: 2 | 4, le: boolean): number {
	let value = 0;
	for (let i = 0; i < width; i++) value = value * 256 + bytes[at + (le ? width - 1 - i : i)]!;
	return value;
}
function ascii(bytes: Uint8Array): string { return String.fromCharCode(...bytes); }
function inRange(position: number, length: number, end: number): boolean {
	return Number.isSafeInteger(position) && Number.isSafeInteger(length) && position >= 0 && length >= 0 && position <= end && length <= end - position;
}

class RawReader {
	private metadata = 0;
	private readonly candidates: Candidate[] = [];
	private readonly candidateKeys = new Set<string>();
	private readonly visited = new Set<string>();
	private ifds = 0;
	private boxes = 0;
	private orientation = 1;
	constructor(private readonly reader: RawPreviewReader) {}

	private async read(at: number, length: number, metadata = true): Promise<Uint8Array> {
		if (!inRange(at, length, this.reader.size)) throw damaged;
		if (metadata && (this.metadata += length) > METADATA_CAP) throw damaged;
		const bytes = await this.reader.read(at, length);
		if (bytes.length !== length) throw damaged;
		return bytes;
	}
	private add(offset: number, length: number): void {
		if (length < 16 || length > JPEG_CAP || !inRange(offset, length, this.reader.size)) return;
		const key = `${offset}:${length}`;
		if (this.candidates.length >= ITEM_CAP || this.candidateKeys.has(key)) return;
		this.candidateKeys.add(key); this.candidates.push({ offset, length });
	}

	private async values(entry: Entry | undefined, ctx: TiffContext, cap = ITEM_CAP): Promise<number[]> {
		if (entry === undefined || entry.count > cap || ![1, 3, 4, 13].includes(entry.type) || !inRange(entry.at, entry.length, ctx.end)) return [];
		const b = await this.read(entry.at, entry.length);
		const width = entry.type === 3 ? 2 : entry.type === 1 ? 1 : 4;
		return Array.from({ length: entry.count }, (_, i) => width === 1 ? b[i]! : number(b, i * width, width, ctx.le));
	}

	private async ifd(at: number, ctx: TiffContext, root = false): Promise<void> {
		const key = `${ctx.base}:${at}:${ctx.le}:${ctx.maker}`;
		if (this.visited.has(key)) return;
		this.visited.add(key);
		if (++this.ifds > ITEM_CAP || !inRange(at, 2, ctx.end)) throw damaged;
		const n = number(await this.read(at, 2), 0, 2, ctx.le);
		if (n > 4096 || !inRange(at + 2, n * 12 + 4, ctx.end)) throw damaged;
		const table = await this.read(at + 2, n * 12 + 4);
		const entries = new Map<number, Entry>();
		const sizes: Readonly<Record<number, number>> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
		for (let i = 0; i < n; i++) {
			const p = i * 12, tag = number(table, p, 2, ctx.le), type = number(table, p + 2, 2, ctx.le), count = number(table, p + 4, 4, ctx.le);
			const unit = sizes[type]; if (unit === undefined) continue;
			const length = count * unit;
			const location = length <= 4 ? at + 2 + p + 8 : ctx.base + number(table, p + 8, 4, ctx.le);
			if (inRange(location, length, ctx.end)) entries.set(tag, { type, count, at: location, length });
		}
		const get = async (tag: number): Promise<number[]> => this.values(entries.get(tag), ctx);
		if (root) this.orientation = (await get(0x0112))[0] ?? 1;
		if (root) {
			const make = entries.get(0x010f);
			if (make?.type === 2 && make.length <= 256) {
				const name = ascii(await this.read(make.at, make.length));
				if (name.startsWith("SONY")) ctx = { ...ctx, maker: "sony" };
			}
		}
		const starts = await get(0x0201), lengths = await get(0x0202);
		if (starts.length === 1 && lengths.length === 1) this.add(ctx.base + starts[0]!, lengths[0]!);
		const compression = (await get(0x0103))[0];
		if (compression === 6 || compression === 7) {
			const offsets = await get(0x0111), counts = await get(0x0117);
			if (offsets.length === counts.length) {
				// Only contiguous strips form one self-contained JPEG; independent strips remain candidates.
				let contiguous = offsets.length > 0;
				for (let i = 1; i < offsets.length; i++) if (offsets[i] !== offsets[i - 1]! + counts[i - 1]!) contiguous = false;
				if (contiguous) this.add(ctx.base + offsets[0]!, counts.reduce((sum, v) => sum + v, 0));
				for (let i = 0; i < offsets.length; i++) this.add(ctx.base + offsets[i]!, counts[i]!);
			}
		}
		if (ctx.maker === "panasonic") {
			const jpg = entries.get(0x002e); if (jpg?.type === 7) this.add(jpg.at, jpg.length);
		}
		if (ctx.maker === "sony") {
			const jpg = entries.get(0x2001);
			// Sony PreviewImage starts with a 32-byte proprietary header, not the JPEG SOI.
			if (jpg?.type === 7 && jpg.length > 32) this.add(jpg.at + 32, jpg.length - 32);
		}
		if (ctx.maker === "olympus") {
			const jpg = entries.get(0x0100); if (jpg?.type === 7) this.add(jpg.at, jpg.length);
		}
		if (ctx.maker === "olympus-camera") {
			const start = (await get(0x0101))[0], length = (await get(0x0102))[0];
			if (start !== undefined && length !== undefined) this.add(ctx.base + start, length);
		}
		for (const tag of [0x014a, 0x8769, ...(ctx.maker === "nikon" ? [0x0011] : []), ...(ctx.maker === "olympus" ? [0x2020] : [])]) {
			for (const offset of await get(tag)) if (offset > 0) await this.ifd(ctx.base + offset, tag === 0x2020 ? { ...ctx, maker: "olympus-camera" } : ctx);
		}
		const note = entries.get(0x927c);
		if (note !== undefined && note.length >= 12) await this.makerNote(note, ctx);
		const next = number(table, n * 12, 4, ctx.le);
		if (next !== 0) await this.ifd(ctx.base + next, ctx);
	}

	private async makerNote(note: Entry, ctx: TiffContext): Promise<void> {
		const head = await this.read(note.at, Math.min(20, note.length));
		const text = ascii(head.subarray(0, 10));
		if (text.startsWith("Nikon\0")) {
			if (head[6] === 2 && head.length >= 18) {
				const base = note.at + 10, le = head[10] === 0x49;
				if (head[10] !== head[11] || ![0x49, 0x4d].includes(head[10]!)) return;
				if (number(head, 12, 2, le) !== 42) return;
				await this.ifd(base + number(head, 14, 4, le), { base, le, end: ctx.end, maker: "nikon" });
			} else if (head[6] === 1) await this.ifd(note.at + 8, { ...ctx, maker: "nikon" });
		} else if (text.startsWith("OLYMPUS\0")) {
			const le = head[8] === 0x49;
			if (head[8] === head[9] && [0x49, 0x4d].includes(head[8]!)) await this.ifd(note.at + 12, { base: note.at, le, end: ctx.end, maker: "olympus" });
		} else if (text.startsWith("OLYMP\0")) {
			await this.ifd(note.at + 8, { ...ctx, maker: "olympus" });
		} else {
			// Sony notes can be a bare IFD (ARW) or carry a twelve-byte SONY DSC header.
			if (ctx.maker === "sony" || text.startsWith("SONY DSC ")) await this.ifd(note.at + (text.startsWith("SONY DSC ") ? 12 : 0), { ...ctx, maker: "sony" });
		}
	}

	private async tiff(header: Uint8Array, base = 0, end = this.reader.size): Promise<void> {
		const le = header[0] === 0x49;
		if (header[0] !== header[1] || ![0x49, 0x4d].includes(header[0]!)) return;
		const magic = number(header, 2, 2, le);
		if (![42, 0x4f52, 0x5352, 0x55].includes(magic)) return;
		const start = base + number(header, 4, 4, le);
		await this.ifd(start, { base, end, le, maker: magic === 0x55 ? "panasonic" : "" }, true);
	}

	private async bmff(start: number, end: number, depth = 0): Promise<void> {
		if (depth > 12) throw damaged;
		let sampleSize: number | undefined, sampleOffset: number | undefined;
		for (let at = start; at + 8 <= end;) {
			if (++this.boxes > 4096) throw damaged;
			const h = await this.read(at, 8); let length = number(h, 0, 4, false), headerSize = 8;
			const type = ascii(h.subarray(4));
			if (length === 1) { const ext = await this.read(at + 8, 8); length = number(ext, 0, 4, false) * 0x100000000 + number(ext, 4, 4, false); headerSize = 16; }
			if (length === 0) length = end - at;
			if (length < headerSize || !inRange(at, length, end)) throw damaged;
			const body = at + headerSize, bodyLength = length - headerSize;
			if (["moov", "trak", "mdia", "minf", "stbl"].includes(type)) await this.bmff(body, at + length, depth + 1);
			else if (type === "uuid" && bodyLength >= 16) {
				const uuid = Array.from(await this.read(body, 16), (v) => v.toString(16).padStart(2, "0")).join("");
				if (uuid === "eaf42b5e1c984b88b9fbb7dc406e4d16" && bodyLength >= 24) await this.bmff(body + 24, at + length, depth + 1);
				else if (uuid === "85c0b687820f11e08111f4ce462b6a48") await this.bmff(body + 16, at + length, depth + 1);
			} else if (type === "CMT1" && bodyLength >= 8) {
				await this.tiff(await this.read(body, 8), body, at + length);
			} else if ((type === "PRVW" || type === "THMB") && bodyLength >= 16) {
				const info = await this.read(body, 16);
				// PRVW: version/flags, version, width/height, flags, length. THMB: flags, width/height, length, flags.
				const jpegLength = number(info, type === "PRVW" ? 12 : 8, 4, false);
				if (jpegLength <= bodyLength - 16) this.add(body + 16, jpegLength);
			} else if (type === "stsz" && bodyLength >= 12) {
				const info = await this.read(body, 12), count = number(info, 8, 4, false), fixed = number(info, 4, 4, false);
				// Still-photo tracks carry one sample/chunk. Raw CRAW samples are rejected by JPEG SOF inspection.
				if (count === 1) sampleSize = fixed || (bodyLength >= 16 ? number(await this.read(body + 12, 4), 0, 4, false) : undefined);
			} else if ((type === "co64" || type === "stco") && bodyLength >= 8) {
				const info = await this.read(body, 8);
				if (number(info, 4, 4, false) === 1) {
					const width = type === "co64" ? 8 : 4;
					if (bodyLength >= 8 + width) {
						const offset = await this.read(body + 8, width);
						sampleOffset = width === 8 ? number(offset, 0, 4, false) * 0x100000000 + number(offset, 4, 4, false) : number(offset, 0, 4, false);
					}
				}
			}
			at += length;
		}
		if (sampleSize !== undefined && sampleOffset !== undefined) this.add(sampleOffset, sampleSize);
	}

	private async inspect(candidate: Candidate): Promise<Jpeg | null> {
		const start = candidate.offset, end = start + candidate.length;
		const soi = await this.read(start, 2);
		if (soi[0] !== 255 || soi[1] !== 216) return null;
		let at = start + 2, width = 0, height = 0;
		for (let count = 0; count < 1024 && at + 4 <= end; count++) {
			const h = await this.read(at, 4);
			if (h[0] !== 255) return null;
			if (h[1] === 255) { at++; continue; }
			const marker = h[1]!, length = number(h, 2, 2, false);
			if (length < 2 || !inRange(at + 2, length, end)) return null;
			if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
				if (![0xc0, 0xc1, 0xc2].includes(marker) || length < 11) return null;
				const sof = await this.read(at + 4, 6);
				height = number(sof, 1, 2, false); width = number(sof, 3, 2, false);
				if (sof[0] !== 8 || ![1, 3, 4].includes(sof[5]!) || length !== 8 + sof[5]! * 3 || width === 0 || height === 0 || width * height > 200_000_000) return null;
			}
			if (marker === 0xda) {
				if (!width || !height) return null;
				return { ...candidate, width, height };
			}
			at += length + 2;
		}
		return null;
	}

	async preview(ext: string, options: RawPreviewOptions): Promise<EmbeddedThumbnail | null> {
		if (!RAW_EXTENSIONS.has(ext.toLowerCase()) || this.reader.size < 8) return null;
		const header = await this.read(0, Math.min(16, this.reader.size));
		if ((header[0] === 0x49 && header[1] === 0x49) || (header[0] === 0x4d && header[1] === 0x4d)) await this.tiff(header);
		else if (ascii(header.subarray(4, 8)) === "ftyp") await this.bmff(0, this.reader.size);
		else return null;
		const images: Jpeg[] = [];
		for (const candidate of this.candidates) { const image = await this.inspect(candidate); if (image !== null) images.push(image); }
		const want = options.want ?? Infinity;
		images.sort((a, b) => {
			const af = Number.isFinite(want) && Math.max(a.width, a.height) >= want, bf = Number.isFinite(want) && Math.max(b.width, b.height) >= want;
			if (af !== bf) return af ? -1 : 1;
			return af ? a.width * a.height - b.width * b.height || a.length - b.length : b.width * b.height - a.width * a.height || b.length - a.length;
		});
		for (const image of images) {
			const bytes = await this.read(image.offset, image.length, false);
			const valid = validateJpeg(bytes);
			if (valid === null) continue;
			return { bytes: this.orientation >= 2 && this.orientation <= 8 && !valid.exif ? orient(bytes, this.orientation) : bytes, mime: "image/jpeg" };
		}
		return null;
	}
}

/** Whether an Exif APP1 payload (starting at its TIFF header) declares an IFD0 Orientation. */
function exifOrientation(bytes: Uint8Array, at: number, end: number): boolean {
	const order = bytes[at] ?? 0;
	const le = order === 0x49;
	if (order !== bytes[at + 1] || (order !== 0x49 && order !== 0x4d)) return false;
	if (!inRange(at, 8, end) || number(bytes, at + 2, 2, le) !== 42) return false;
	const ifd = at + number(bytes, at + 4, 4, le);
	if (!inRange(ifd, 2, end)) return false;
	const n = number(bytes, ifd, 2, le);
	if (n > 4096 || !inRange(ifd + 2, n * 12, end)) return false;
	for (let i = 0; i < n; i++) if (number(bytes, ifd + 2 + i * 12, 2, le) === 0x0112) return true;
	return false;
}

/** Verify marker boundaries/entropy escapes; `exif` means an Exif APP1 already declares Orientation. */
function validateJpeg(bytes: Uint8Array): { readonly exif: boolean } | null {
	let at = 2, entropy = false, exif = false;
	for (let count = 0; at + 1 < bytes.length && count < bytes.length; count++) {
		if (entropy && bytes[at] !== 255) { at++; continue; }
		if (bytes[at] !== 255) return null;
		const marker = bytes[at + 1]!;
		if (marker === 255) { at++; continue; }
		if (entropy && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) { at += 2; continue; }
		if (marker === 217) return entropy ? { exif } : null;
		if (at + 4 > bytes.length) return null;
		const length = number(bytes, at + 2, 2, false);
		if (length < 2 || !inRange(at + 2, length, bytes.length)) return null;
		if (marker === 0xe1 && length >= 8 && ascii(bytes.subarray(at + 4, at + 10)) === "Exif\0\0") exif ||= exifOrientation(bytes, at + 10, at + 2 + length);
		entropy = marker === 0xda;
		at += length + 2;
	}
	return null;
}

function orient(bytes: Uint8Array, orientation: number): Uint8Array {
	const out = new Uint8Array(bytes.length + 36);
	out.set(bytes.subarray(0, 2));
	out.set([255, 225, 0, 34, 69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0, 1, 0, 18, 1, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0], 2);
	out.set(bytes.subarray(2), 38);
	return out;
}

/** No unbounded scans: metadata is capped at 4 MiB; individual previews at 24 MiB. */
export async function readRawPreviewFromReader(reader: RawPreviewReader, ext: string, options: RawPreviewOptions = {}): Promise<EmbeddedThumbnail | null> {
	try { return await new RawReader(reader).preview(ext, options); }
	catch (error) {
		if (error === damaged || (error instanceof Error && "code" in error && ["EIO", "EINVAL", "EISDIR"].includes(String(error.code)))) return null;
		throw error;
	}
}

/** Read only directory/box ranges and the selected displayable JPEG, never the RAW sensor payload. */
export async function readRawPreview(path: string, ext: string, options: RawPreviewOptions = {}): Promise<EmbeddedThumbnail | null> {
	if (!RAW_EXTENSIONS.has(ext.toLowerCase())) return null;
	const handle = await open(path, "r");
	try {
		const { size } = await handle.stat();
		return await readRawPreviewFromReader({ size, read: async (position, length) => {
			const bytes = new Uint8Array(length);
			const { bytesRead } = await handle.read(bytes, 0, length, position);
			return bytesRead === length ? bytes : bytes.subarray(0, bytesRead);
		} }, ext, options);
	} finally { await handle.close(); }
}
