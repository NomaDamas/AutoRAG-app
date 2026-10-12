/**
 * The archive extractor's security boundary, in plain JavaScript so both the
 * TypeScript extractors and the libarchive worker module can import the exact
 * same guard — a hostile entry must be refused identically in every format.
 *
 * Every entry name passes {@link archiveEntryPath}: absolute paths, Windows
 * drive paths, NUL bytes, and `..` escapes sink the whole extraction, so a
 * hostile archive can never write outside its destination folder.
 */

import { resolve, sep } from "node:path";

/** A refusal the extractor decided on; its message is the Korean copy the user sees. */
export class ArchiveError extends Error {}

/**
 * Strip the leading `./` (and `././`) that tar writers prefix, so wrapper-folder
 * detection and path guards see the same name for every container. A lone `.` or
 * `./` normalizes to "" (the archive root, which is not an entry).
 */
export function normalizeEntryName(name) {
	let normalized = name;
	while (normalized.startsWith("./")) normalized = normalized.slice(2);
	return normalized === "." ? "" : normalized;
}

/**
 * The absolute path an archive entry extracts to, and whether it is a
 * directory. Rejects absolute entries, Windows drive paths, NUL bytes in the
 * name, and any entry escaping `destDir` (zip-slip), so a hostile archive can
 * never write outside the chosen folder.
 *
 * The name is normalized to NFC *before* any check, so the guard judges the
 * exact name that reaches the disk. Mac tools store Hangul decomposed (NFD,
 * `ㅎ`+`ㅏ`+`ㄴ`), which Windows lists as separate jamo and cannot match against
 * the composed name; NFC is what Windows, Linux, and Finder's own file
 * creation use. APFS treats both forms as one name, so nothing is lost there.
 */
export function archiveEntryPath(destDir, name) {
	if (name.includes("\0")) {
		throw new ArchiveError(`압축 파일 항목 이름이 올바르지 않습니다: ${JSON.stringify(name)}`);
	}
	const normalized = name.normalize("NFC").replace(/\\/g, "/");
	if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
		throw new ArchiveError(`압축 파일에 절대 경로 항목이 있습니다: ${name}`);
	}
	const directory = normalized.endsWith("/");
	const trimmed = directory ? normalized.slice(0, -1) : normalized;
	const root = resolve(destDir);
	const target = resolve(root, trimmed);
	if (target !== root && !target.startsWith(root + sep)) {
		throw new ArchiveError(`압축 파일 항목이 대상 폴더를 벗어납니다: ${name}`);
	}
	return { path: target, directory };
}
