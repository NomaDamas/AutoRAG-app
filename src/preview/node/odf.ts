import { extractZipEntry, withZip } from "./zip-read";

/** A thumbnail beyond this is not one; LibreOffice and PowerPoint write tens of KB. */
const THUMBNAIL_BYTE_CAP = 8 * 1024 * 1024;

/** A package's embedded first-page image and the format it is in. */
export interface EmbeddedThumbnail {
	readonly bytes: Uint8Array;
	readonly mime: "image/png" | "image/jpeg";
}

/** Entry names tried in order, per extension. ODF stores a PNG; an OOXML template stores a JPEG. */
const THUMBNAIL_ENTRIES: Readonly<Record<string, readonly string[]>> = {
	odt: ["Thumbnails/thumbnail.png"],
	ods: ["Thumbnails/thumbnail.png"],
	odp: ["Thumbnails/thumbnail.png"],
	odg: ["Thumbnails/thumbnail.png"],
	potx: ["docProps/thumbnail.jpeg", "docProps/thumbnail.jpg"],
};

/** Extensions whose package embeds a first-page image the Finder tile can show without Quick Look. */
export const EMBEDDED_THUMBNAIL_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(THUMBNAIL_ENTRIES));

function sniff(bytes: Uint8Array): EmbeddedThumbnail["mime"] | null {
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
	return null;
}

/**
 * The first page/sheet/slide image a package embeds, or null when the file is
 * not a ZIP, has no thumbnail, or the entry is not a PNG/JPEG. Only the ZIP
 * directory and that one entry are read.
 */
export async function readEmbeddedThumbnail(path: string, ext: string): Promise<EmbeddedThumbnail | null> {
	const names = THUMBNAIL_ENTRIES[ext.toLowerCase()];
	if (names === undefined) return null;
	return withZip(path, async (handle, entries) => {
		for (const name of names) {
			const entry = entries.find((candidate) => candidate.name === name);
			if (entry === undefined) continue;
			const bytes = await extractZipEntry(handle, entry, THUMBNAIL_BYTE_CAP);
			const mime = bytes === null ? null : sniff(bytes);
			if (bytes !== null && mime !== null) return { bytes, mime };
		}
		return null;
	});
}
