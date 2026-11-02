/**
 * Entry names as they arrive from a reader that could only guess their bytes.
 *
 * Two readers hand back a name as one Latin-1 character per original byte:
 * fflate, for a zip entry written without the UTF-8 flag, and the vendored
 * libarchive, for an entry whose stored bytes are not UTF-8 — the CP949 a Korean
 * Windows tool writes into a ustar, cpio, or ISO 9660 stream, none of which can
 * carry a charset. Both names are put back together here, so the listing, the
 * extractor, and the guard all decode a name the same way.
 *
 * Many tools (Info-ZIP on Linux, Python) write UTF-8 without the zip flag;
 * Korean Windows Explorer writes CP949. UTF-8 is tried first because it is
 * strict — a CP949 name is almost never valid UTF-8 — and a name that is neither
 * stays as read.
 *
 * Plain JavaScript for the same reason as `archive-guard.mjs`: the libarchive
 * listing worker, the extraction worker, and the TypeScript extractors all
 * import it.
 */

/**
 * Recover a name handed back as one Latin-1 character per original byte.
 * Names the reader already decoded properly (anything above U+00FF) pass through.
 */
export function decodeLegacyName(name) {
	if (!/[\u0080-\u00ff]/.test(name) || /[^\u0000-\u00ff]/.test(name)) return name;
	const bytes = Buffer.from(name, "latin1");
	for (const label of ["utf-8", "euc-kr"]) {
		try {
			return new TextDecoder(label, { fatal: true }).decode(bytes);
		} catch {
			// Not this encoding; try the next.
		}
	}
	return name;
}
