import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import type { ChatAttachment } from "../shared/search-contract";

/**
 * Image files attached to a message (pasted, dropped, or picked from the Finder) go to the model as pictures, next to
 * the text context the attachment block already gives. A file that is not an image, is gone, or cannot be decoded is
 * skipped: the block still names it, and the question is asked without the picture.
 *
 * Speed: pi's resizer starts a worker and decodes the picture even when nothing needs resizing (about 0.6 s a picture),
 * so a picture whose header says it already fits is sent as the file's own bytes, a scaled one is remembered for as
 * long as the file is unchanged (a chat re-sends its attachments, and a paste prepares its picture at once with
 * {@link prepareAttachmentImage}), and a message's pictures are prepared side by side.
 */

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

/** Pictures sent with one message; the rest stay as paths in the attachment block. */
export const MAX_MESSAGE_IMAGES = 8;
/** Larger source files are not decoded for the model. */
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
/** What pi's resizer leaves alone (its defaults): the longest edge, and the encoded (base64) size. */
const FITS_EDGE = 2000;
const FITS_BASE64_BYTES = 4.5 * 1024 * 1024;
/** Prepared pictures kept, newest last. */
const CACHE_ENTRIES = 12;

export interface ImageDimensions {
	readonly width: number;
	readonly height: number;
}

/** The pixel size a PNG, GIF, JPEG or WebP file's header states; null for anything else. Reads no pixels. */
export function imageSize(bytes: Uint8Array): ImageDimensions | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ascii = (at: number, length: number): string => String.fromCharCode(...bytes.subarray(at, at + length));
	if (bytes.length >= 24 && ascii(1, 3) === "PNG") return { width: view.getUint32(16), height: view.getUint32(20) };
	if (bytes.length >= 10 && ascii(0, 3) === "GIF") return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
	if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
		const kind = ascii(12, 4);
		if (kind === "VP8X") return { width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)), height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) };
		if (kind === "VP8L") {
			const bits = view.getUint32(21, true);
			return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
		}
		if (kind === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
		return null;
	}
	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		let at = 2;
		while (at + 9 < bytes.length) {
			if (bytes[at] !== 0xff) return null;
			const marker = bytes[at + 1]!;
			if (marker === 0xff) {
				at += 1;
				continue;
			}
			// Start-of-frame markers (not the DHT/JPG/DAC ones in the same range) carry the size.
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
			at += 2 + view.getUint16(at + 2);
		}
	}
	return null;
}

const prepared = new Map<string, Promise<ImageContent | null>>();

function remember(key: string, picture: Promise<ImageContent | null>): Promise<ImageContent | null> {
	prepared.set(key, picture);
	// A picture that could not be prepared is not remembered: the file may be fixed, or the resizer may recover.
	void picture.then((result) => {
		if (result === null && prepared.get(key) === picture) prepared.delete(key);
	});
	while (prepared.size > CACHE_ENTRIES) prepared.delete(prepared.keys().next().value as string);
	return picture;
}

async function prepare(path: string, mimeType: string): Promise<ImageContent | null> {
	try {
		const bytes = await readFile(path);
		const size = imageSize(bytes);
		if (size !== null && size.width <= FITS_EDGE && size.height <= FITS_EDGE && Math.ceil((bytes.length * 4) / 3) < FITS_BASE64_BYTES) {
			return { type: "image", data: bytes.toString("base64"), mimeType };
		}
		const resized = await resizeImage(bytes, mimeType);
		return resized === null ? null : { type: "image", data: resized.data, mimeType: resized.mimeType };
	} catch {
		// Unreadable or undecodable: the question goes without this picture.
		return null;
	}
}

/** The model picture for an attachment, or null when it is not an image file the model can take. */
export async function prepareAttachmentImage(attachment: ChatAttachment): Promise<ImageContent | null> {
	if (attachment.kind !== "file" || !isAbsolute(attachment.id)) return null;
	const mimeType = MIME_BY_EXTENSION[extname(attachment.id).toLowerCase()];
	if (mimeType === undefined) return null;
	let info;
	try {
		info = await stat(attachment.id);
	} catch {
		return null;
	}
	if (!info.isFile() || info.size > MAX_SOURCE_BYTES) return null;
	const key = `${attachment.id}\0${info.mtimeMs}\0${info.size}`;
	return prepared.get(key) ?? remember(key, prepare(attachment.id, mimeType));
}

export async function loadAttachmentImages(attachments: readonly ChatAttachment[]): Promise<readonly ImageContent[]> {
	const candidates = attachments.filter((attachment) => attachment.kind === "file" && MIME_BY_EXTENSION[extname(attachment.id).toLowerCase()] !== undefined);
	const pictures = await Promise.all(candidates.map(prepareAttachmentImage));
	return pictures.filter((picture): picture is ImageContent => picture !== null).slice(0, MAX_MESSAGE_IMAGES);
}
