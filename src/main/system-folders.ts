/**
 * Folders an operating system or a cloud provider keeps for itself. File-name
 * search never walks into them and never returns them: their contents are not
 * the user's files, and a provider's internal folder (Google Drive's `.tmp`,
 * mode `d--x------`) cannot be listed at all.
 *
 * Names are compared case-insensitively, at any depth. A folder the user
 * chose as the search scope is exempt (see `isInsideSystemFolder`).
 */
const SYSTEM_FOLDER_NAMES: ReadonlySet<string> = new Set([
	// macOS volume and user bookkeeping
	".trash",
	".trashes",
	".spotlight-v100",
	".documentrevisions-v100",
	".fseventsd",
	".temporaryitems",
	".mobilebackups",
	".pkinstallsandboxmanager",
	".pkinstallsandboxmanager-sip",
	// Windows
	"$recycle.bin",
	"system volume information",
	"$winreagent",
	// Cloud providers' internal domain folders (Google Drive for desktop, Dropbox)
	".tmp",
	".tmp.drivedownload",
	".tmp.driveupload",
	".shortcut-targets-by-id",
	".file-revisions-by-id",
	".encrypted",
	".dropbox.cache",
]);

export function isSystemFolderName(name: string): boolean {
	return SYSTEM_FOLDER_NAMES.has(name.toLowerCase());
}

/**
 * Whether `path` lies in a system folder below `base`. Only the part of the
 * path under `base` counts, so a search scoped to `~/.Trash` still finds what
 * the Trash holds. A path outside `base` (or no `base`) is checked whole.
 */
export function isInsideSystemFolder(path: string, base?: string): boolean {
	const segments = path.replaceAll("\\", "/").split("/").filter((segment) => segment.length > 0);
	if (base !== undefined) {
		const baseSegments = base.replaceAll("\\", "/").split("/").filter((segment) => segment.length > 0);
		if (baseSegments.every((segment, index) => segments[index] === segment)) {
			return segments.slice(baseSegments.length).some(isSystemFolderName);
		}
	}
	return segments.some(isSystemFolderName);
}
