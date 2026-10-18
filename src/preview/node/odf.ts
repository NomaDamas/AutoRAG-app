import { extractZipEntry, withZip } from "./zip-read";

/** ODF stores the first page or slide here, a PNG of at most a few hundred pixels. */
const THUMBNAIL_NAME = "Thumbnails/thumbnail.png";
/** A thumbnail beyond this is not one; LibreOffice writes tens of KB. */
const THUMBNAIL_BYTE_CAP = 8 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47] as const;

/** Extensions of OpenDocument packages (ZIPs carrying `Thumbnails/thumbnail.png`). */
export const ODF_EXTENSIONS: ReadonlySet<string> = new Set(["odt", "ods", "odp", "odg"]);

/**
 * The first page/sheet/slide image an OpenDocument package embeds, or null
 * when the file is not a ZIP, has no thumbnail, or the entry is not a PNG.
 * Only the ZIP directory and that one entry are read.
 */
export async function readOdfThumbnail(path: string): Promise<Uint8Array | null> {
	return withZip(path, async (handle, entries) => {
		const entry = entries.find((candidate) => candidate.name === THUMBNAIL_NAME);
		if (entry === undefined) return null;
		const bytes = await extractZipEntry(handle, entry, THUMBNAIL_BYTE_CAP);
		if (bytes === null || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) return null;
		return bytes;
	});
}
