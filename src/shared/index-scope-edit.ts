/**
 * The rules for editing what the index covers, from the index map: which folders are targets (`searchPaths`), which
 * paths are left out (`excludePaths`), and what the person can do with the item they are looking at. Pure, so the
 * rules are tested without a window, and shared so the page and any other caller agree.
 */

export interface ScopeState {
	readonly searchPaths: readonly string[];
	readonly excludePaths: readonly string[];
}

export type RejectedReason =
	/** Already a target. */
	| "duplicate"
	/** Inside a target that is already there; indexing it twice would count its files twice. */
	| "inside-target"
	/** Not an absolute path, so it would resolve against wherever the app happened to start. */
	| "not-absolute";

export interface RejectedRoot {
	readonly path: string;
	readonly reason: RejectedReason;
}

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/u;
const WINDOWS_UNC = /^\\\\/u;

function isWindowsStyle(path: string): boolean {
	return WINDOWS_DRIVE.test(path) || WINDOWS_UNC.test(path);
}

export function isAbsolutePath(path: string): boolean {
	return path.startsWith("/") || isWindowsStyle(path);
}

/**
 * An `excludePaths` entry with `*`, `?` or `[` is a glob over the whole absolute path (librarian 2.13.12), any other
 * entry is a file or a folder. The test is the librarian's, so the app and the index never disagree on what a pattern is.
 */
export function isGlobExclusion(entry: string): boolean {
	return /[*?[]/u.test(entry);
}

/** A path as it is compared: one separator, no trailing separator, and case folded where the platform ignores it. */
function comparable(path: string): string {
	const windows = isWindowsStyle(path);
	const unified = windows ? path.replace(/\\/gu, "/") : path;
	const trimmed = unified.length > 1 ? unified.replace(/\/+$/u, "") : unified;
	return windows ? trimmed.toLowerCase() : trimmed;
}

/** True when `path` is `ancestor` or lies under it. A shared name prefix (`/data` and `/data-old`) is not containment. */
export function isSameOrInside(path: string, ancestor: string): boolean {
	const a = comparable(ancestor);
	const p = comparable(path);
	if (p === a) return true;
	return p.startsWith(a.endsWith("/") ? a : `${a}/`);
}

export interface AddRootsResult {
	readonly searchPaths: readonly string[];
	readonly rejected: readonly RejectedRoot[];
}

/**
 * Adds picked folders as targets. A folder that is already covered is skipped and reported; a new folder that
 * contains existing targets replaces them, so the list never holds one folder inside another.
 */
export function addSearchRoots(scope: ScopeState, picked: readonly string[]): AddRootsResult {
	let roots = [...scope.searchPaths];
	const rejected: RejectedRoot[] = [];
	for (const path of picked) {
		if (!isAbsolutePath(path)) {
			rejected.push({ path, reason: "not-absolute" });
			continue;
		}
		if (roots.some((root) => comparable(root) === comparable(path))) {
			rejected.push({ path, reason: "duplicate" });
			continue;
		}
		if (roots.some((root) => isSameOrInside(path, root))) {
			rejected.push({ path, reason: "inside-target" });
			continue;
		}
		roots = [...roots.filter((root) => !isSameOrInside(root, path)), path];
	}
	return { searchPaths: roots, rejected };
}

/** Removes one target, and the exclusions that only meant something under it. */
export function removeSearchRoot(scope: ScopeState, path: string): ScopeState {
	if (!scope.searchPaths.some((root) => comparable(root) === comparable(path))) return scope;
	const searchPaths = scope.searchPaths.filter((root) => comparable(root) !== comparable(path));
	// A pattern is not tied to one folder: it keeps meaning something under every remaining target.
	const excludePaths = scope.excludePaths.filter((excluded) => isGlobExclusion(excluded) || searchPaths.some((root) => isSameOrInside(excluded, root)));
	return { searchPaths, excludePaths };
}

/** The nearest exclusion that is `path` itself or above it, or null. */
export function coveringExclusion(excludePaths: readonly string[], path: string): string | null {
	let nearest: string | null = null;
	for (const excluded of excludePaths) {
		// A pattern covers by matching, not by containment; `findExclusion` (main) answers that.
		if (isGlobExclusion(excluded) || !isSameOrInside(path, excluded)) continue;
		if (nearest === null || comparable(excluded).length > comparable(nearest).length) nearest = excluded;
	}
	return nearest;
}

/** The exclusions with `path` added; unchanged when it is already listed. */
export function excludePath(excludePaths: readonly string[], path: string): readonly string[] {
	return excludePaths.some((excluded) => comparable(excluded) === comparable(path)) ? excludePaths : [...excludePaths, path];
}

/** The exclusions without the entry that is `path` itself. A parent's exclusion stays: it is a different decision. */
export function includePath(excludePaths: readonly string[], path: string): readonly string[] {
	return excludePaths.filter((excluded) => comparable(excluded) !== comparable(path));
}

export interface ActionInput {
	readonly path: string;
	readonly kind: "root" | "folder" | "file" | "parcel";
	/** The map's display state for the item. */
	readonly state: "indexed" | "partial" | "unindexed" | "excluded";
	readonly excludePaths: readonly string[];
}

export interface AvailableActions {
	/** Leave this folder or file out of the index. */
	readonly exclude: boolean;
	/** Bring a directly excluded folder or file back in. */
	readonly include: boolean;
}

const NOTHING: AvailableActions = { exclude: false, include: false };

/**
 * What the person can do with the item they are looking at. Only what would actually work is offered: a parcel stands
 * for many files and no one path; a search root is a target, edited in the folder list, not left out of itself; only
 * an exclusion that is the item itself can be undone here (one a folder above made is undone on that folder); a
 * folder the refresh never walks (`node_modules` and the like) is excluded by the app itself, with nothing to undo.
 */
export function availableActions(input: ActionInput): AvailableActions {
	if (input.kind === "parcel" || input.kind === "root") return NOTHING;
	const covering = coveringExclusion(input.excludePaths, input.path);
	if (covering !== null) return comparable(covering) === comparable(input.path) ? { ...NOTHING, include: true } : NOTHING;
	if (input.state === "excluded") return NOTHING;
	return { ...NOTHING, exclude: true };
}
