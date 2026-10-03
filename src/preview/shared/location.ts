/**
 * The folders that hold `path`, as Finder's "Where" row prints them:
 * "Macintosh HD › Users › jeffrey › Downloads". On macOS the startup disk is
 * named by `bootVolume` and `/Volumes/<name>` paths start at that volume; on
 * Windows the drive (or UNC share) is the first crumb.
 */
export function locationCrumbs(path: string, platform: string, bootVolume: string | null): readonly string[] {
	if (platform === "win32") {
		const unc = /^\\\\[^\\]+\\[^\\]+/.exec(path);
		const root = unc?.[0] ?? (/^[A-Za-z]:/.exec(path)?.[0] ?? "");
		const parts = path.slice(root.length).split(/[\\/]/).filter((part) => part.length > 0);
		return [...(root === "" ? [] : [root]), ...parts.slice(0, -1)];
	}
	const parts = path.split("/").filter((part) => part.length > 0).slice(0, -1);
	if (platform === "darwin" && parts[0] === "Volumes" && parts.length > 1) return parts.slice(1);
	return [bootVolume ?? "/", ...parts];
}

/**
 * Resolves a document-relative reference (a Markdown image) against the
 * folder holding the document. Returns null for anything that is not a plain
 * relative path: URLs, absolute paths, and paths that climb above the root.
 */
export function resolveRelative(folder: string, reference: string): string | null {
	if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || /^[\\/]/.test(reference)) return null;
	const [bare = ""] = reference.split(/[?#]/);
	let decoded: string;
	try {
		decoded = decodeURIComponent(bare);
	} catch (error) {
		if (error instanceof URIError) return null;
		throw error;
	}
	const windows = !folder.startsWith("/") && folder.includes("\\");
	const parts = folder.split(/[\\/]/).filter((part, index) => index === 0 || part !== "");
	for (const part of decoded.split(/[\\/]/)) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (parts.length <= 1) return null;
			parts.pop();
		} else {
			parts.push(part);
		}
	}
	return parts.join(windows ? "\\" : "/");
}
