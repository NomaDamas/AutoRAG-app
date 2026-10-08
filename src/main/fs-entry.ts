import { constants } from "node:fs";
import { access, lstat, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { FsEntry } from "../shared/fs-contract";

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
	return {
		name,
		path,
		kind: isFolder ? "folder" : "file",
		ext: isFolder ? "" : extensionOf(name),
		size: isDirectory ? null : effective.size,
		modifiedAt: effective.mtime.toISOString(),
		// Only a real birth time is a creation time; never substitute mtime/ctime.
		...(effective.birthtimeMs > 0 ? { createdAt: effective.birthtime.toISOString() } : {}),
		isSymlink,
		// The OS metadata lookup lands in fs-service, which owns process spawning.
		osKind: null,
		iconUrl: null,
	};
}
