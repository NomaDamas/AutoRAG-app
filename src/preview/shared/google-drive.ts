/**
 * Google Drive's Google-native files (Docs, Sheets, Slides, Forms, ...). Drive
 * for desktop shows each one as a tiny JSON pointer (`.gdoc`, `.gsheet`, ...)
 * instead of content, because the document lives in Google's cloud. The pointer
 * carries the document id and the account that owns the copy; the picture the
 * Finder shows for it is a thumbnail Drive's file provider draws for the OS.
 */

export const GOOGLE_DRIVE_EXTENSIONS: readonly string[] = [
	"gdoc",
	"gsheet",
	"gslides",
	"gform",
	"gdraw",
	"gmap",
	"gsite",
	"gjam",
	"gtable",
	"gscript",
];

const EXTENSION_SET: ReadonlySet<string> = new Set(GOOGLE_DRIVE_EXTENSIONS);

export function isGoogleDriveExtension(ext: string): boolean {
	return EXTENSION_SET.has(ext.toLowerCase().replace(/^\./u, ""));
}

export interface GoogleDrivePointer {
	readonly docId: string;
	/** The Google account Drive for desktop signed in with; null when the pointer names none. */
	readonly email: string | null;
}

/**
 * The pointer's document id and account, or null when the bytes are not a
 * Drive pointer (a truncated, binary, or foreign file that merely carries a
 * `.gdoc` name).
 */
export function readGoogleDrivePointer(bytes: Uint8Array): GoogleDrivePointer | null {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const docId: unknown = Reflect.get(value, "doc_id");
	if (typeof docId !== "string" || docId === "") return null;
	const email: unknown = Reflect.get(value, "email");
	return { docId, email: typeof email === "string" && email !== "" ? email : null };
}
