/**
 * Rich metadata for the Inspector's Info panel. One stat pass plus, for image
 * files, an EXIF read. The FinderEntry a listing already carries is only the
 * summary; this fills in creation/access/change times, mode, ownership, the
 * symlink target, and camera tags on demand for the focused path.
 */

import { lstat, readlink, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename } from "node:path";
import type { FsFileDetails, FsImageMetadata } from "../shared/fs-contract";
import { extensionOf, hasErrorCode } from "./fs-entry";
import { readImageMetadata } from "./image-metadata";

export interface FileDetailsDeps {
	/** Defaults to the real EXIF reader; tests inject a stub. */
	readonly readImage?: (path: string, ext: string) => Promise<FsImageMetadata | null>;
}

const RWX: readonly { readonly mask: number; readonly char: string }[] = [
	{ mask: 0o400, char: "r" },
	{ mask: 0o200, char: "w" },
	{ mask: 0o100, char: "x" },
	{ mask: 0o040, char: "r" },
	{ mask: 0o020, char: "w" },
	{ mask: 0o010, char: "x" },
	{ mask: 0o004, char: "r" },
	{ mask: 0o002, char: "w" },
	{ mask: 0o001, char: "x" },
];

/** ls-style mode string, e.g. "-rw-r--r--" or "drwxr-xr-x". */
export function permissionString(mode: number, kind: "folder" | "file", isSymlink: boolean): string {
	const type = isSymlink ? "l" : kind === "folder" ? "d" : "-";
	const chars = RWX.map(({ mask, char }) => (mode & mask ? char : "-"));
	const setuid = mode & 0o4000;
	const setgid = mode & 0o2000;
	const sticky = mode & 0o1000;
	if (setuid) chars[2] = mode & 0o100 ? "s" : "S";
	if (setgid) chars[5] = mode & 0o010 ? "s" : "S";
	if (sticky) chars[8] = mode & 0o001 ? "t" : "T";
	return `${type}${chars.join("")}`;
}

function ownerName(uid: number): string {
	if (typeof process.getuid === "function" && process.getuid() !== uid) return String(uid);
	try {
		return userInfo().username;
	} catch {
		return String(uid);
	}
}

/** Everything the Info panel shows for one path. */
export async function readFileDetails(path: string, deps: FileDetailsDeps = {}): Promise<FsFileDetails> {
	const link = await lstat(path);
	const isSymlink = link.isSymbolicLink();
	let effective = link;
	if (isSymlink) {
		try {
			effective = await stat(path);
		} catch (error) {
			// Broken symlink: describe the link itself.
			if (!hasErrorCode(error, "ENOENT")) throw error;
		}
	}
	const kind = effective.isDirectory() ? "folder" : "file";
	// Filesystems without a birth time report the epoch; the inode change time is the closest stand-in.
	const created = effective.birthtimeMs > 0 ? effective.birthtime : effective.ctime;
	const linkTarget = isSymlink ? await readlink(path).catch(() => null) : null;
	const image =
		kind === "file" ? await (deps.readImage ?? readImageMetadata)(path, extensionOf(basename(path))) : null;
	return {
		path,
		kind,
		size: kind === "folder" ? null : effective.size,
		createdAt: created.toISOString(),
		modifiedAt: effective.mtime.toISOString(),
		accessedAt: effective.atime.toISOString(),
		changedAt: effective.ctime.toISOString(),
		isSymlink,
		linkTarget,
		permissions: permissionString(link.mode, kind, isSymlink),
		owner: ownerName(effective.uid),
		group: String(effective.gid),
		inode: effective.ino,
		image,
	};
}
