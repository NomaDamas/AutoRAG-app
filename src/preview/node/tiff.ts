import type { PreviewDocument } from "../shared/contract";
import { readPreviewFile } from "./read-file";
import { convertWithSips, pixelSize, type PixelSize, type SipsConversion } from "./sips";

/** The MIME type the converted bytes carry; the viewer keys on it to skip its own decoder. */
export const TIFF_PREVIEW_MIME = "image/png";
/**
 * Longest side of the decoded picture. Quick Look shows a panel that fits the
 * screen, so a 6000px scan gains nothing from being sent whole.
 */
export const TIFF_DECODE_MAX_SIDE = 2048;
/**
 * Largest TIFF the in-page decoder (UTIF) is given. It decodes synchronously
 * on the page's only thread: 0.9-7s for a 22MB scan, with the panel frozen.
 * Where macOS can decode instead, there is no such limit.
 */
export const TIFF_DECODE_BYTE_CAP = 8 * 1024 * 1024;

export interface TiffDeps extends SipsConversion {
	/** Largest TIFF handed to the in-page decoder when the OS cannot decode it. */
	readonly decodeCap?: number;
	/** The picture's pixel size; defaults to asking `sips`. */
	readonly size?: (path: string) => Promise<PixelSize | null>;
}

/**
 * The TIFF preview document. Where the OS can decode it, `bytes` is the
 * decoded PNG (`mime` says so) and the TIFF itself is never read into memory
 * (`sips` does a 22MB scan in about 0.2s). A picture longer than
 * {@link TIFF_DECODE_MAX_SIDE} is shrunk to it; a smaller one is left alone,
 * because sips's size option scales up as readily as down. Otherwise the
 * document is the raw file for the viewer's own decoder, unless it is past
 * {@link TIFF_DECODE_BYTE_CAP}: a TIFF that large arrives without bytes and
 * the panel shows its info instead of freezing.
 */
export async function readTiffPreview(path: string, deps: TiffDeps = {}): Promise<PreviewDocument> {
	const info = await readPreviewFile(path, 0);
	const size = (deps.platform ?? process.platform) === "darwin" ? await (deps.size ?? pixelSize)(path) : null;
	const shrink = size !== null && Math.max(size.width, size.height) > TIFF_DECODE_MAX_SIDE;
	const args = ["-s", "format", "png", ...(shrink ? ["--resampleHeightWidthMax", String(TIFF_DECODE_MAX_SIDE)] : [])];
	const png = await convertWithSips(path, "preview.png", args, deps);
	if (png !== null) return { ...info, mime: TIFF_PREVIEW_MIME, bytes: png };
	const cap = deps.decodeCap ?? TIFF_DECODE_BYTE_CAP;
	if (info.size > cap) return { ...info, truncated: true, bytes: null };
	return readPreviewFile(path, cap, true);
}
