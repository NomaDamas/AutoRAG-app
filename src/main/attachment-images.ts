import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import type { ChatAttachment } from "../shared/search-contract";

/**
 * Image files attached to a message (pasted, dropped, or picked from the Finder) go to the model as pictures, next to
 * the text context the attachment block already gives. A file that is not an image, is gone, or cannot be decoded is
 * skipped: the block still names it, and the question is asked without the picture.
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

export async function loadAttachmentImages(attachments: readonly ChatAttachment[]): Promise<readonly ImageContent[]> {
	const images: ImageContent[] = [];
	for (const attachment of attachments) {
		if (images.length >= MAX_MESSAGE_IMAGES) break;
		if (attachment.kind !== "file" || !isAbsolute(attachment.id)) continue;
		const mimeType = MIME_BY_EXTENSION[extname(attachment.id).toLowerCase()];
		if (mimeType === undefined) continue;
		try {
			if ((await stat(attachment.id)).size > MAX_SOURCE_BYTES) continue;
			const resized = await resizeImage(await readFile(attachment.id), mimeType);
			if (resized !== null) images.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
		} catch {
			// Unreadable or undecodable: the question goes without this picture.
		}
	}
	return images;
}
