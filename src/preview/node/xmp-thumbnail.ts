import { type FileHandle, open } from "node:fs/promises";
import type { EmbeddedThumbnail } from "./odf";

/** How much of each end of the file is scanned: an XMP packet is written at one end of it. */
const WINDOW_BYTES = 2 * 1024 * 1024;
/** The element, and the attribute, Adobe apps write their base64 JPEG thumbnail into. */
const MARKER = "xmpGImg:image";
const MARKER_BYTES = Buffer.from(MARKER, "latin1");
/** `<xmpGImg:image>…</xmpGImg:image>`, closed. */
const ELEMENT_CLOSE = "</xmpGImg:image>";
/** The numeric character references a writer wraps a long base64 line with. */
const ENTITY = /&#(?:[xX][0-9a-fA-F]+|[0-9]+);/g;
/** What a base64 payload is, once its entities and whitespace are gone. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export interface XmpReadOptions {
	/** Called with the length of every range read, so a caller can see the scan stayed bounded. */
	readonly onRead?: (bytes: number) => void;
}

async function readRange(handle: FileHandle, position: number, length: number, onRead?: (bytes: number) => void): Promise<Uint8Array | null> {
	const bytes = new Uint8Array(length);
	const { bytesRead } = await handle.read(bytes, 0, length, position);
	onRead?.(bytesRead);
	return bytesRead === length ? bytes : null;
}

/**
 * The text of the element or attribute that follows a marker at the start of
 * `text`, or "cut" when the text ends before the payload does.
 */
function payloadFrom(text: string): string | null | "cut" {
	const rest = text.slice(MARKER.length);
	if (rest.startsWith("=")) {
		const quoted = /^=\s*(["'])([\s\S]*?)\1/.exec(rest);
		return quoted === null ? "cut" : (quoted[2] ?? "");
	}
	if (!rest.startsWith(">")) return "cut"; // the window ends inside the tag itself
	const end = rest.indexOf(ELEMENT_CLOSE);
	return end < 0 ? "cut" : rest.slice(1, end);
}

/** The decoded JPEG, or null when the payload is not base64 or does not start with FFD8. */
function decodeJpeg(payload: string): Uint8Array | null {
	const base64 = payload.replace(ENTITY, "").replace(/\s+/g, "");
	if (base64.length % 4 !== 0 || !BASE64.test(base64)) return null;
	const bytes = Buffer.from(base64, "base64");
	return bytes[0] === 0xff && bytes[1] === 0xd8 ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length) : null;
}

/** The thumbnail a window holds, "cut" when the window ends inside the packet, null when it holds none. */
function thumbnailIn(window: Uint8Array): EmbeddedThumbnail | null | "cut" {
	const buffer = Buffer.from(window.buffer, window.byteOffset, window.length);
	const marker = buffer.indexOf(MARKER_BYTES);
	if (marker < 0) return null;
	// Latin-1 from the marker on: the payload sits within a few kilobytes of it.
	const payload = payloadFrom(buffer.toString("latin1", marker));
	if (payload === "cut") return "cut";
	if (payload === null) return null;
	const bytes = decodeJpeg(payload);
	return bytes === null ? null : { bytes, mime: "image/jpeg" };
}

/**
 * The JPEG thumbnail in the XMP packet a document carries — Illustrator's .ai
 * and EPS, Photoshop, InDesign — or null when there is none or it is not
 * usable. Only the first and the last {@link WINDOW_BYTES} of the file are
 * scanned, since the packet is written at one end of it; a packet a window
 * cuts in half is refused rather than guessed at, so a caller with a truncated
 * file never gets half a JPEG.
 */
export async function readXmpThumbnail(path: string, options: XmpReadOptions = {}): Promise<EmbeddedThumbnail | null> {
	const handle = await open(path, "r");
	try {
		const { size } = await handle.stat();
		if (size === 0) return null;
		// A file with no more than both windows is scanned in one piece, so a packet
		// lying between them is still found.
		const single = size <= 2 * WINDOW_BYTES;
		const head = await readRange(handle, 0, single ? size : WINDOW_BYTES, options.onRead);
		if (head === null) return null;
		const found = thumbnailIn(head);
		if (found === "cut") return null;
		if (found !== null) return found;
		if (single) return null;
		const tail = await readRange(handle, size - WINDOW_BYTES, WINDOW_BYTES, options.onRead);
		if (tail === null) return null;
		const later = thumbnailIn(tail);
		return later === "cut" ? null : later;
	} finally {
		await handle.close();
	}
}
