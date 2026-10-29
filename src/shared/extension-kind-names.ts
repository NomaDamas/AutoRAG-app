/**
 * Kind names the app gives file types the OS may not name for it.
 *
 * macOS answers an extension no installed app registered (GIMP's `.xcf`,
 * Sketch's, Figma's) with a dynamic `dyn.*` type and the bare kind "Document",
 * and Windows has no registry entry at all, so the Kind column, grouping and
 * sort would put every one of them under "Document" or a borrowed "PNG Image".
 * The main process drops that generic answer for the extensions listed here
 * (`file-kind.ts`) and the Finder shows the name below instead. A type the OS
 * does register keeps the OS's own word, as Finder shows it.
 *
 * Only the key and the brand live here; the words are in the locale files under
 * `finderState.kindNames`, so they translate.
 */

type PlainKey = "photoshop" | "illustrator" | "eps" | "jpegxl" | "icns" | "targa" | "openexr" | "gimp" | "sketch" | "figma" | "rawGeneric";

export type ExtensionKindName = { readonly key: "raw"; readonly maker: string } | { readonly key: PlainKey };

/** Brand names are not translated. */
const NAMES: Readonly<Record<string, ExtensionKindName>> = {
	psd: { key: "photoshop" },
	ai: { key: "illustrator" },
	eps: { key: "eps" },
	jxl: { key: "jpegxl" },
	icns: { key: "icns" },
	tga: { key: "targa" },
	exr: { key: "openexr" },
	xcf: { key: "gimp" },
	sketch: { key: "sketch" },
	fig: { key: "figma" },
	cr2: { key: "raw", maker: "Canon" },
	cr3: { key: "raw", maker: "Canon" },
	nef: { key: "raw", maker: "Nikon" },
	arw: { key: "raw", maker: "Sony" },
	dng: { key: "raw", maker: "Adobe" },
	orf: { key: "raw", maker: "Olympus" },
	rw2: { key: "raw", maker: "Panasonic" },
	// Panasonic and Leica both write `.raw`, so no maker is claimed.
	raw: { key: "rawGeneric" },
};

function normalized(ext: string): string {
	return ext.toLowerCase().replace(/^\./, "");
}

export function extensionKindName(ext: string): ExtensionKindName | null {
	return NAMES[normalized(ext)] ?? null;
}

export function hasExtensionKindName(ext: string): boolean {
	return NAMES[normalized(ext)] !== undefined;
}
