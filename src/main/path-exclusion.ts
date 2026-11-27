import { matchesGlob, sep } from "node:path";
import { isGlobExclusion } from "../shared/index-scope-edit";
import { loadDazziNativeCore } from "./dazzi-native-core";

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

export interface ExclusionMatcher {
	find(path: string): ExclusionMatch | null;
	isExcluded(path: string): boolean;
	findBatch(paths: readonly string[]): (ExclusionMatch | null)[];
}

/**
 * Compiled matcher over one exclusion list. Uses the Rust N-API core when available
 * and every glob pattern is supported natively; otherwise falls back to Node's
 * `matchesGlob` with identical semantics.
 */
export function createExclusionMatcher(exclusions: readonly string[]): ExclusionMatcher {
	if (exclusions.length === 0) {
		return {
			find: () => null,
			isExcluded: () => false,
			findBatch: (paths) => new Array<ExclusionMatch | null>(paths.length).fill(null),
		};
	}
	const native = loadDazziNativeCore();
	if (native !== null && native.canHandleExclusionsNatively(exclusions)) {
		const compiled = new native.CompiledExclusions(exclusions);
		return {
			find: (path) => compiled.find(path),
			isExcluded: (path) => compiled.isExcluded(path),
			findBatch: (paths) => (paths.length === 0 ? [] : native.findExclusionBatch(exclusions, paths)),
		};
	}
	return {
		find: (path) => findExclusion(exclusions, path),
		isExcluded: (path) => findExclusion(exclusions, path) !== null,
		findBatch: (paths) => paths.map((path) => findExclusion(exclusions, path)),
	};
}

/**
 * Evaluate `exclusions` over a batch of `paths` in one native FFI call when the Rust
 * core is available and handles all glob patterns; falls back to JS otherwise.
 */
export function findExclusionsBatch(exclusions: readonly string[], paths: readonly string[]): (ExclusionMatch | null)[] {
	if (paths.length === 0) return [];
	if (exclusions.length === 0) return new Array<ExclusionMatch | null>(paths.length).fill(null);
	const native = loadDazziNativeCore();
	if (native !== null && native.canHandleExclusionsNatively(exclusions)) {
		return native.findExclusionBatch(exclusions, paths);
	}
	return paths.map((path) => findExclusion(exclusions, path));
}
