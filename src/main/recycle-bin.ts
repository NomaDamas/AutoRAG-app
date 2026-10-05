/**
 * Windows Recycle Bin folders (`<drive>\$Recycle.Bin\<SID>`) hold each deleted
 * item as a `$R<id><ext>` payload plus a `$I<id><ext>` record naming where it
 * came from. Listing the folder raw would show `$RQ4F2K1.docx`; Explorer shows
 * the original name, so the listing reads it from the `$I` record.
 *
 * `$I` layout (little-endian): int64 version, int64 size, FILETIME deletedAt,
 * then the original path in UTF-16 — a fixed 260-character field in version 1
 * (Vista–8), or an int32 character count followed by the path in version 2.
 */

import { readFile } from "node:fs/promises";
import { win32 } from "node:path";

const V1_PATH_OFFSET = 24;
const V2_LENGTH_OFFSET = 24;
const V2_PATH_OFFSET = 28;

/** True when `dir` is a `$Recycle.Bin\<SID>` folder. */
export function isRecycleBinDir(dir: string): boolean {
	return /^[a-z]:\\\$recycle\.bin\\s-[\d-]+\\?$/i.test(dir);
}

/** The original file name a `$I` record points at, or null when the file is not one. */
export async function readRecycleBinName(recordPath: string): Promise<string | null> {
	const bytes = await readFile(recordPath);
	if (bytes.length < V2_PATH_OFFSET) return null;
	const version = bytes.readBigInt64LE(0);
	let raw: string;
	if (version === 1n) {
		raw = bytes.toString("utf16le", V1_PATH_OFFSET);
	} else if (version === 2n) {
		const chars = bytes.readInt32LE(V2_LENGTH_OFFSET);
		raw = bytes.toString("utf16le", V2_PATH_OFFSET, V2_PATH_OFFSET + chars * 2);
	} else {
		return null;
	}
	const original = raw.split("\0")[0] ?? "";
	return original === "" ? null : win32.basename(original);
}
