/**
 * The part of the disk one dupey scan looked at, shared by the main process (which decides what a failed scan leaves
 * stale) and the renderer (which shows a scan failure only while its folder is in view).
 *
 * A scan covers a folder and everything below it, except the immediate subfolders it was told to skip: a cloud drive
 * whose whole-root scan failed is scanned folder by folder, and the files lying loose in its root are one more scan that
 * skips every one of those folders.
 */

/** What a `scanDuplicates` call may ask beyond the folder: the immediate subfolders to leave out of the scan. */
export interface DupeyScanOptions {
	readonly excludeDirs?: readonly string[];
}

export interface VersionScanScope {
	readonly path: string;
	/** Immediate subfolders of `path` the scan skipped. dupey matches these by folder name, ignoring case. */
	readonly excludeDirs: readonly string[];
}

function normalize(path: string): string {
	const slashed = path.replaceAll("\\", "/");
	return slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
}

/** True when `target` is the scope's folder or sits below it, outside the subfolders the scan skipped. */
export function scanScopeCovers(scope: VersionScanScope, target: string): boolean {
	const root = normalize(scope.path);
	const path = normalize(target);
	const prefix = root.endsWith("/") ? root : `${root}/`;
	if (path !== root && !path.startsWith(prefix)) return false;
	if (path === root || scope.excludeDirs.length === 0) return true;
	const first = path.slice(prefix.length).split("/", 1)[0]?.toLowerCase() ?? "";
	return !scope.excludeDirs.some((name) => name.toLowerCase() === first);
}
