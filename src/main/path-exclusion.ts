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
 * Compiled matcher over one exclusion list. Uses the bundled Rust N-API core as
 * the primary implementation; falls back to Node's `matchesGlob` only for glob
 * syntax outside the native compiler (braces/character classes) or if the native
 * module errors.
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
	if (native !== null) {
		try {
			if (native.canHandleExclusionsNatively(exclusions)) {
				const compiled = new native.CompiledExclusions(exclusions);
				return {
					find: (path) => {
						try {
							return compiled.find(path);
						} catch {
							return findExclusion(exclusions, path);
						}
					},
					isExcluded: (path) => {
						try {
							return compiled.isExcluded(path);
						} catch {
							return findExclusion(exclusions, path) !== null;
						}
					},
					findBatch: (paths) => {
						if (paths.length === 0) return [];
						try {
							return native.findExclusionBatch(exclusions, paths);
						} catch {
							return paths.map((path) => findExclusion(exclusions, path));
						}
					},
				};
			}
		} catch (error) {
			console.warn("[dazzi-core] exclusion matcher error, falling back to JS:", error instanceof Error ? error.message : error);
		}
	}
	return {
		find: (path) => findExclusion(exclusions, path),
		isExcluded: (path) => findExclusion(exclusions, path) !== null,
		findBatch: (paths) => paths.map((path) => findExclusion(exclusions, path)),
	};
}

/**
 * Evaluate `exclusions` over a batch of `paths` in one native FFI call.
 * Falls back to JS only if a complex glob requires Node `matchesGlob` or native throws.
 */
export function findExclusionsBatch(exclusions: readonly string[], paths: readonly string[]): (ExclusionMatch | null)[] {
	if (paths.length === 0) return [];
	if (exclusions.length === 0) return new Array<ExclusionMatch | null>(paths.length).fill(null);
	const native = loadDazziNativeCore();
	if (native !== null) {
		try {
			if (native.canHandleExclusionsNatively(exclusions)) {
				return native.findExclusionBatch(exclusions, paths);
			}
		} catch (error) {
			console.warn("[dazzi-core] findExclusionBatch error, falling back to JS:", error instanceof Error ? error.message : error);
		}
	}
	return paths.map((path) => findExclusion(exclusions, path));
}
