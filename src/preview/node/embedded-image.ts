import { extname } from "node:path";
import { readIcnsPreview } from "./icns-preview";
import { EMBEDDED_THUMBNAIL_EXTENSIONS, readEmbeddedThumbnail, type EmbeddedThumbnail } from "./odf";
import { readPsdComposite, readPsdThumbnail } from "./psd-preview";
import { RAW_EXTENSIONS, readRawPreview } from "./raw-preview";
import { readXmpThumbnail } from "./xmp-thumbnail";

export type { EmbeddedThumbnail } from "./odf";

/**
 * Every extension whose file carries a picture of itself the main process can
 * read without the OS: the first page ODF and Sketch/Figma packages embed, the
 * JPEG a camera RAW keeps beside the sensor data, a Photoshop file's thumbnail
 * and flattened composite, the PNGs inside an icns, and the XMP thumbnail
 * Adobe's apps write into Illustrator and EPS files.
 */
export const EMBEDDED_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
	...EMBEDDED_THUMBNAIL_EXTENSIONS,
	...RAW_EXTENSIONS,
	"psd",
	"ai",
	"eps",
	"icns",
]);

export interface EmbeddedImageOptions {
	/**
	 * The longest side in pixels the caller will draw (a tile asks for 128, the
	 * Inspector for 640). The smallest embedded image at least that big is
	 * returned, so a tile never decodes a 24-megapixel preview; omitted means
	 * the best the file has.
	 */
	readonly want?: number;
}

/** Below this a PSD's own thumbnail is the right size and the whole composite is not worth reading. */
const PSD_COMPOSITE_FROM = 256;

async function photoshop(path: string, want: number | undefined): Promise<EmbeddedThumbnail | null> {
	const thumbnail = await readPsdThumbnail(path);
	if (want !== undefined && thumbnail !== null && want <= Math.max(thumbnail.width, thumbnail.height)) return thumbnail;
	// A tile that finds no thumbnail stays on its type icon rather than decoding a layered file's pixels.
	if (want !== undefined && want <= PSD_COMPOSITE_FROM) return thumbnail;
	return (await readPsdComposite(path)) ?? thumbnail;
}

/**
 * The picture a file embeds of itself, reading only that image's byte range
 * (never the whole file), or null when the format has none, the file has none,
 * or it is damaged.
 */
export async function readEmbeddedImage(path: string, ext: string = extname(path).slice(1), options: EmbeddedImageOptions = {}): Promise<EmbeddedThumbnail | null> {
	const key = ext.toLowerCase().replace(/^\./, "");
	const want = options.want;
	const wanting = want === undefined ? {} : { want };
	if (EMBEDDED_THUMBNAIL_EXTENSIONS.has(key)) return readEmbeddedThumbnail(path, key);
	if (RAW_EXTENSIONS.has(key)) return readRawPreview(path, key, wanting);
	switch (key) {
		case "psd":
			return photoshop(path, want);
		case "ai":
		case "eps":
			return readXmpThumbnail(path);
		case "icns":
			return readIcnsPreview(path, wanting);
		default:
			return null;
	}
}
