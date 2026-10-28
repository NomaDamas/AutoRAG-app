import { extname } from "node:path";
import type { PreviewDocument } from "../shared/contract";
import { RAW_PHOTO_EXTENSIONS } from "../shared/raster-formats";
import { readEmbeddedImage } from "./embedded-image";
import type { EmbeddedThumbnail } from "./odf";
import { readPreviewFile } from "./read-file";
import { convertWithSips, pixelSize, type PixelSize, type SipsConversion } from "./sips";

/** Longest side of a picture the OS decodes for the panel; the window never shows more than a screen of it. */
export const RASTER_MAX_SIDE = 2048;
/** sips `formatOptions` for the JPEGs it writes for a photograph: quality 0-100. */
const JPEG_QUALITY = "85";

type Source = "embedded" | "system";
type SystemFormat = "jpeg" | "png";

interface Route {
	/** Where the picture is looked for, first to last. `system` is a no-op off macOS. */
	readonly order: readonly Source[];
	/** What the OS writes: JPEG for photographs, PNG where transparency matters. */
	readonly system: SystemFormat;
}

const ROUTES: Readonly<Record<string, Route>> = {
	// A RAW carries the camera's own JPEG: instant and bounded, where decoding the
	// sensor data takes 0.4-4s. The OS decoder covers a file with no preview.
	...Object.fromEntries(RAW_PHOTO_EXTENSIONS.map((ext) => [ext, { order: ["embedded", "system"], system: "jpeg" } satisfies Route])),
	// macOS draws the real composite; elsewhere the file's flattened image or thumbnail stands in.
	psd: { order: ["system", "embedded"], system: "png" },
	icns: { order: ["embedded", "system"], system: "png" },
	// Only the OS can decode these; no embedded image exists.
	tga: { order: ["system"], system: "png" },
	exr: { order: ["system"], system: "png" },
	// macOS has no PostScript renderer: an EPS shows the preview it embeds, or nothing.
	eps: { order: ["embedded"], system: "png" },
	sketch: { order: ["embedded"], system: "png" },
	fig: { order: ["embedded"], system: "png" },
};

export interface RasterDeps extends SipsConversion {
	/** The picture's pixel size; defaults to asking `sips`. */
	readonly size?: (path: string) => Promise<PixelSize | null>;
	/** The file's own embedded image; defaults to the readers in `embedded-image.ts`. */
	readonly embedded?: (path: string, ext: string) => Promise<EmbeddedThumbnail | null>;
}

/**
 * `sips` writes the source's EXIF orientation tag into the JPEG it makes, even
 * for a RAW (checked with a portrait Samsung DNG: pixels landscape, tag
 * `RightTop`), and Chromium turns the `<img>` upright from it. Rotating the
 * pixels as well would turn a portrait shot twice.
 */
async function systemImage(path: string, route: Route, deps: RasterDeps): Promise<EmbeddedThumbnail | null> {
	if ((deps.platform ?? process.platform) !== "darwin") return null;
	// sips's size option enlarges as readily as it shrinks, so a small picture is left alone.
	const size = await (deps.size ?? pixelSize)(path);
	const shrink = size === null || Math.max(size.width, size.height) > RASTER_MAX_SIDE;
	const format = route.system;
	const args = [
		"-s",
		"format",
		format,
		...(format === "jpeg" ? ["-s", "formatOptions", JPEG_QUALITY] : []),
		...(shrink ? ["--resampleHeightWidthMax", String(RASTER_MAX_SIDE)] : []),
	];
	const bytes = await convertWithSips(path, `preview.${format === "jpeg" ? "jpg" : "png"}`, args, { ...deps, warn: deps.warn ?? ((message) => console.warn(message)) });
	return bytes === null ? null : { bytes, mime: format === "jpeg" ? "image/jpeg" : "image/png" };
}

/**
 * The raster preview document: `bytes` is a PNG or JPEG (`mime` says which)
 * and the original is never read whole. The file's own embedded preview and
 * the OS's decode are tried in the order that suits the format (`ROUTES`);
 * a file neither can draw arrives with `bytes: null`, which the panel
 * answers with its "Other" view.
 */
export async function readRasterPreview(path: string, deps: RasterDeps = {}): Promise<PreviewDocument> {
	const info = await readPreviewFile(path, 0);
	const ext = extname(path).slice(1).toLowerCase();
	const route = ROUTES[ext];
	if (route === undefined) return info;
	const warn = deps.warn ?? ((message: string) => console.warn(message));
	const embedded = deps.embedded ?? readEmbeddedImage;
	for (const source of route.order) {
		try {
			const image = source === "embedded" ? await embedded(path, ext) : await systemImage(path, route, deps);
			if (image !== null) return { ...info, mime: image.mime, bytes: image.bytes };
		} catch (error) {
			warn(`quick-look: ${source} preview for ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return info;
}
