/**
 * Archive formats the app can extract, plus the "is this file an archive, and
 * what is its stem" rule shared by the context menu, the Inspector action bar,
 * and the main-process extractor. One module so no surface can offer a format
 * the extractor does not handle, or derive a different output name.
 *
 * A name is an archive only when it carries one of these suffixes and has
 * something before it: `.zip` (a dotfile whose whole name is the suffix) and
 * `trailing.` are plain files. Multi-dot suffixes match longest-first, so
 * `a.tar.gz` is a tar.gz whose stem is `a` — never a `.gz` named `a.tar`.
 *
 * `.gz` is deliberately listed: it may wrap a tar (then it extracts like a tar)
 * or a single compressed file (then it writes `<name without .gz>`), decided
 * from the inflated bytes, not the name. `.bz2` and `.xz` on their own are not
 * listed — this build's engine reads their tar-wrapped forms only.
 */

export type ArchiveFormat =
	| "zip"
	| "tar"
	| "tar.gz"
	| "tgz"
	| "gz"
	| "7z"
	| "tar.bz2"
	| "tbz2"
	| "tar.xz"
	| "txz";

/** One archive name's decoded format and output stem. */
export interface ArchiveMatch {
	/** The format the name's suffix denotes. */
	readonly format: ArchiveFormat;
	/** The file name without its archive suffix; the folder or file the extractor creates. */
	readonly stem: string;
}

/** Every suffix, longest first so `.tar.gz` wins over `.gz`; lower-case, matched case-insensitively. */
const ARCHIVE_SUFFIXES: readonly { readonly suffix: string; readonly format: ArchiveFormat }[] = [
	{ suffix: ".tar.gz", format: "tar.gz" },
	{ suffix: ".tar.bz2", format: "tar.bz2" },
	{ suffix: ".tar.xz", format: "tar.xz" },
	{ suffix: ".tgz", format: "tgz" },
	{ suffix: ".tbz2", format: "tbz2" },
	{ suffix: ".txz", format: "txz" },
	{ suffix: ".zip", format: "zip" },
	{ suffix: ".tar", format: "tar" },
	{ suffix: ".gz", format: "gz" },
	{ suffix: ".7z", format: "7z" },
];

/**
 * The format `name` denotes and its stem, or null when it is not an extractable
 * archive. `name` is a file name (no directory part); a dotfile (`.zip`,
 * `.tar.gz`) has no suffix Finder recognizes and is not an archive.
 */
export function archiveFormatOf(name: string): ArchiveMatch | null {
	// A leading dot is a dotfile, which Finder treats as extensionless; the
	// renderer's own `fileExtension` reads it the same way, so neither offers one.
	if (name.startsWith(".")) return null;
	const lower = name.toLowerCase();
	for (const { suffix, format } of ARCHIVE_SUFFIXES) {
		if (lower.length <= suffix.length || !lower.endsWith(suffix)) continue;
		return { format, stem: name.slice(0, name.length - suffix.length) };
	}
	return null;
}
