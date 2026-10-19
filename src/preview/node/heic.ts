import type { PreviewDocument } from "../shared/contract";
import { PREVIEW_BYTE_CAP, readPreviewFile } from "./read-file";
import { convertWithSips, type SipsConversion, type SipsRun } from "./sips";

/** The MIME type the converted bytes carry; the viewer keys on it to skip its own decoder. */
export const HEIC_PREVIEW_MIME = "image/jpeg";
/** sips `formatOptions`: JPEG quality 0-100. */
const JPEG_QUALITY = "85";

export type HeicRun = SipsRun;
export type HeicDeps = SipsConversion;

/**
 * The HEIC preview document. The in-renderer wasm decoder takes tens of
 * seconds on a camera-size photo and never finished on a 24MP iPhone HEIC;
 * the system's own ImageIO (`sips`) does the same file in about 0.2s and
 * applies the HEIF rotation itself. Where the OS can decode it, `bytes` is the
 * decoded JPEG (`mime` says so) and the HEIC itself is never read into
 * memory; otherwise it is the raw file, for the viewer's own wasm decoder.
 */
export async function readHeicPreview(path: string, deps: HeicDeps = {}): Promise<PreviewDocument> {
	const info = await readPreviewFile(path, 0);
	const jpeg = await convertWithSips(path, "preview.jpg", ["-s", "format", "jpeg", "-s", "formatOptions", JPEG_QUALITY], deps);
	if (jpeg !== null) return { ...info, mime: HEIC_PREVIEW_MIME, bytes: jpeg };
	return readPreviewFile(path, PREVIEW_BYTE_CAP, true);
}
