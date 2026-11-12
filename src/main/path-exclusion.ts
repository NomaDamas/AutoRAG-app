import { matchesGlob, sep } from "node:path";
import { isGlobExclusion } from "../shared/index-scope-edit";

/**
 * What an `excludePaths` entry covers, read the way the librarian reads it (`filesystem/path-exclusions.ts`, not part of
 * its public exports, so this is a deliberate copy of its rules): an entry with `*`, `?` or `[` is a glob over the whole
 * absolute path (`**\/node_modules/**`, `**\/*.log`), anything else is a file or a folder with its subtree. A glob is
 * never resolved against a directory or a real path: it would then stop matching anywhere else.
 */

function isUnder(path: string, root: string): boolean {
	return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Whether an absolute path matches a glob entry; a leading `**\/` also matches at the filesystem root. */
export function matchesGlobExclusion(path: string, glob: string): boolean {
	const slashed = path.replaceAll("\\", "/");
	if (matchesGlob(slashed, glob)) return true;
	return glob.startsWith("**/") && matchesGlob(slashed, glob.slice(3));
}

export type ExclusionMatch = { readonly kind: "path"; readonly entry: string } | { readonly kind: "glob"; readonly entry: string };

/** The entry that excludes `path`, preferring a path entry (the person's own toggle) over a pattern; null when none does. */
export function findExclusion(exclusions: readonly string[], path: string): ExclusionMatch | null {
	let glob: ExclusionMatch | null = null;
	for (const entry of exclusions) {
		if (isGlobExclusion(entry)) {
			if (glob === null && matchesGlobExclusion(path, entry)) glob = { kind: "glob", entry };
		} else if (isUnder(path, entry)) {
			return { kind: "path", entry };
		}
	}
	return glob;
}
