import { constants } from "node:fs";
import { access, lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, parse, resolve, sep } from "node:path";
import { FS_ENTRY_SYMLINK, type FsEntry } from "../shared/fs-contract";

/** True when the error carries the given Node errno code. */
export function hasErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

/** Verbatim error text for operator-facing diagnostics. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return false;
		throw error;
	}
}

export async function isAvailable(path: string): Promise<boolean> {
	try {
		await access(path, constants.R_OK);
		return true;
	} catch (error) {
		if (
			hasErrorCode(error, "ENOENT") ||
			hasErrorCode(error, "ENOTDIR") ||
			hasErrorCode(error, "EACCES") ||
			hasErrorCode(error, "EPERM")
		) {
			return false;
		}
		throw error;
	}
}

/**
 * `path` spelled as the filesystem stores it. On a case-insensitive volume
 * (APFS and NTFS defaults) "/Volumes/ssd/autorag" opens "/Volumes/SSD/AutoRAG";
 * every segment is matched back to its directory entry, by case and Unicode
 * form, and confirmed by inode. Symlinks are never resolved: a link keeps its
 * own name. Rejects with ENOENT/ENOTDIR when the path does not exist.
 */
export async function onDiskPath(path: string): Promise<string> {
	const absolute = resolve(path);
	// Already exact and free of symlinks: the common case costs one call
	// (`fs/promises` realpath is the OS one, which answers in on-disk case).
	if ((await realpath(absolute)) === absolute) return absolute;
	const { root } = parse(absolute);
	let current = root;
	for (const segment of absolute.slice(root.length).split(sep).filter((part) => part.length > 0)) {
		const target = await lstat(join(current, segment), { bigint: true });
		let names: string[] = [];
		try {
			names = await readdir(current);
		} catch (error) {
			// A traverse-only folder (execute without read) cannot be listed: keep the typed name.
			if (!hasErrorCode(error, "EACCES") && !hasErrorCode(error, "EPERM")) throw error;
		}
		const key = segment.normalize("NFC").toLowerCase();
		let match = segment;
		for (const name of names) {
			if (name === segment) break;
			if (name.normalize("NFC").toLowerCase() !== key) continue;
			const candidate = await lstat(join(current, name), { bigint: true }).catch(() => null);
			if (candidate !== null && candidate.ino === target.ino && candidate.dev === target.dev) {
				match = name;
				break;
			}
		}
		current = join(current, match);
	}
	return current;
}

/** Lowercase extension without the dot; "" for extensionless names and dotfiles. */
export function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function splitBaseExt(name: string, isFolder: boolean): { readonly base: string; readonly ext: string } {
	if (isFolder) return { base: name, ext: "" };
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? { base: name, ext: "" } : { base: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * Finder-style collision naming inside destDir: the bare name when free,
 * otherwise "name copy.ext", "name copy 2.ext", ... (ext stays last).
 */
export async function resolveCopyName(destDir: string, name: string, isFolder: boolean): Promise<string> {
	if (!(await pathExists(join(destDir, name)))) return name;
	const { base, ext } = splitBaseExt(name, isFolder);
	for (let attempt = 1; ; attempt += 1) {
		const candidate = attempt === 1 ? `${base} copy${ext}` : `${base} copy ${attempt}${ext}`;
		if (!(await pathExists(join(destDir, candidate)))) return candidate;
	}
}

/** The `.app` extension that marks a macOS application bundle. */
const APP_BUNDLE_EXTENSION = ".app";

/**
 * True when `path`'s name marks a macOS application bundle: a directory the OS
 * treats as one launchable item, not a folder to browse into. Finder shows the
 * app's own icon and launches it on double-click, and so must we. No other
 * platform has the concept, so the same directory stays a folder there.
 */
export function isAppBundle(name: string, isDirectory: boolean, platform: NodeJS.Platform): boolean {
	if (!isDirectory || platform !== "darwin") return false;
	const lower = name.toLowerCase();
	// A directory named exactly ".app" has no bundle name to launch.
	return lower.length > APP_BUNDLE_EXTENSION.length && lower.endsWith(APP_BUNDLE_EXTENSION);
}

/**
 * Build the contract entry for one on-disk path. Symlinks are reported with
 * the target's metadata when resolvable, else with the link's own metadata.
 * A macOS application bundle reports `kind: "file"` (see {@link isAppBundle});
 * its size stays null because the entry is still a directory on disk, whose
 * byte count would be the folder's own, not the app's.
 */
export async function buildFsEntry(path: string, platform: NodeJS.Platform = process.platform): Promise<FsEntry> {
	const linkStat = await lstat(path);
	const isSymlink = linkStat.isSymbolicLink();
	let effective = linkStat;
	if (isSymlink) {
		try {
			effective = await stat(path);
		} catch (error) {
			// Broken symlink: fall back to the link's own metadata.
			if (!hasErrorCode(error, "ENOENT")) throw error;
		}
	}
	const isDirectory = effective.isDirectory();
	const name = basename(path);
	const isBundle = isAppBundle(name, isDirectory, platform);
	const isFolder = isDirectory && !isBundle;
	const entry = {
		name,
		path,
		kind: isFolder ? "folder" : "file",
		ext: isFolder ? "" : extensionOf(name),
		// A bundle is a directory on disk: its byte count would be the folder's own, not the app's.
		size: isDirectory ? null : effective.size,
		mtimeMs: effective.mtimeMs,
		flags: isSymlink ? FS_ENTRY_SYMLINK : 0,
	} as const;
	// Only a real birth time is a creation time; never substitute mtime/ctime.
	return effective.birthtimeMs > 0 ? { ...entry, birthtimeMs: effective.birthtimeMs } : entry;
}
