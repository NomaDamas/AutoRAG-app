import { extname } from "node:path";
import { readHeicPreview } from "../preview/node/heic";
import { readTiffPreview } from "../preview/node/tiff";

/** Picture formats Chromium cannot decode on its own; the PDF editor asks the main process for them. */
export const MAIN_DECODED_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["tif", "tiff", "heic", "heif"]);

export interface PdfDecodedImage {
	/**
	 * `image/png` or `image/jpeg` when the OS / Dazzi's native core already decoded the picture
	 * (PNG keeps the alpha channel), otherwise the raw `image/tiff` / `image/heic` bytes for the
	 * renderer's own decoder (UTIF / heic-to), exactly like Quick Look.
	 */
	readonly mime: "image/png" | "image/jpeg" | "image/tiff" | "image/heic";
	readonly bytes: Uint8Array;
}

export interface PdfImageDecodeDeps {
	readonly readTiff?: typeof readTiffPreview;
	readonly readHeic?: typeof readHeicPreview;
}

/**
 * Decodes a TIFF or HEIC picture for placement on a PDF page, reusing Quick Look's pipeline:
 * TIFF goes through Dazzi's native decoder (RGBA, transparency kept) or `sips`; HEIC through `sips`.
 * When neither can decode it, the raw bytes come back so the renderer can decode them itself.
 */
export async function decodeImageForPdf(path: string, deps: PdfImageDecodeDeps = {}): Promise<PdfDecodedImage> {
	const ext = extname(path).slice(1).toLowerCase();
	if (ext === "tif" || ext === "tiff") {
		const doc = await (deps.readTiff ?? readTiffPreview)(path);
		if (doc.bytes === null) throw new Error("This TIFF image is too large or could not be read.");
		return { mime: doc.mime === "image/png" ? "image/png" : "image/tiff", bytes: doc.bytes };
	}
	if (ext === "heic" || ext === "heif") {
		const doc = await (deps.readHeic ?? readHeicPreview)(path);
		if (doc.bytes === null) throw new Error("This HEIC image could not be read.");
		const mime = doc.mime === "image/png" || doc.mime === "image/jpeg" ? doc.mime : "image/heic";
		return { mime, bytes: doc.bytes };
	}
	throw new Error(`Unsupported image format for main-process decoding: .${ext}`);
}
