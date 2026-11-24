import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatAttachment } from "../shared/search-contract";

/**
 * Images pasted into an AI Agent composer (a screenshot on the clipboard has no file on disk). They are written under
 * the app's data folder and from then on are ordinary file attachments, so a chat keeps showing and re-reading them,
 * and "clear history" deletes exactly these files.
 */
export interface PastedImageStore {
	/** Writes the image and returns the file attachment that stands for it. Throws for anything that is not a supported image. */
	save(mimeType: string, base64: string): Promise<ChatAttachment>;
	/** Deletes every pasted image. */
	clear(): Promise<void>;
}

/** The image types a model takes; the value is the file extension the pasted file gets. */
const EXTENSIONS: Readonly<Record<string, string>> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
};

/** Largest pasted image, as decoded bytes. Larger ones are refused instead of filling the profile. */
export const PASTED_IMAGE_MAX_BYTES = 25 * 1024 * 1024;

export function createPastedImageStore(deps: { readonly directory: string }): PastedImageStore {
	return {
		save: async (mimeType, base64) => {
			const extension = EXTENSIONS[mimeType];
			if (extension === undefined) throw new TypeError(`Unsupported image type: ${mimeType}`);
			if (base64.length > Math.ceil((PASTED_IMAGE_MAX_BYTES * 4) / 3) + 4) throw new RangeError("The pasted image is too large.");
			const bytes = Buffer.from(base64, "base64");
			if (bytes.length === 0) throw new TypeError("The pasted image is empty.");
			if (bytes.length > PASTED_IMAGE_MAX_BYTES) throw new RangeError("The pasted image is too large.");
			await mkdir(deps.directory, { recursive: true });
			const name = `pasted-image-${randomUUID().slice(0, 8)}.${extension}`;
			const path = join(deps.directory, name);
			await writeFile(path, bytes);
			return { kind: "file", id: path, name };
		},
		clear: () => rm(deps.directory, { recursive: true, force: true }),
	};
}
