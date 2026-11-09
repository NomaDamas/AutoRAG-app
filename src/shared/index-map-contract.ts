/**
 * The index map: every file and folder under the configured AutoRAG search
 * roots, with what the local index holds for each, shaped for Settings →
 * 검색 범위 → 인덱싱 지도.
 *
 * The main side walks the roots the way a refresh does and sends a bounded
 * graph: a tree of `nodes` whose files are individual nodes while the budget
 * allows and fold into per-state `parcel` nodes (one per state, `weight` files
 * each) when a folder or the whole scope is too large to draw file by file.
 * `totals` counts every eligible file the walk saw, whatever was folded; files
 * no parser reads never enter the map.
 *
 * A folder's `state` reads its index coverage, not its largest count: all of
 * its eligible files indexed, some of them, none of them, or an explicit
 * excluded marker (see `indexMapFolderState`).
 */

/**
 * What the index holds for one file, in the map's own terms.
 *
 * Files no parser reads (unsupported extensions, product artifacts) never become nodes or counts: the map covers only
 * what a refresh could index. `unindexable` therefore means a supported file the refresh skipped.
 */
export type IndexMapState =
	/** Parsed and staged, and the file has not changed since. */
	| "indexed"
	/** Indexed once, but the file changed since, or the index and the config disagree until the next refresh. */
	| "stale"
	/** Supported and inside the scope, not in the index yet. */
	| "unindexed"
	/** Left out by `excludePaths` (the user's or the code-folder rule) or a folder no refresh walks; an explicit marker. */
	| "excluded"
	/** Supported, but the refresh skipped it (duplicate, parse failure, unreadable): an unfinished target. */
	| "unindexable";

export const INDEX_MAP_STATES: readonly IndexMapState[] = ["indexed", "stale", "unindexed", "excluded", "unindexable"];

export type IndexMapCounts = Readonly<Record<IndexMapState, number>>;

export type IndexMapNodeKind = "root" | "folder" | "file" | "parcel";

export interface IndexMapNode {
	/** Index into `IndexMap.nodes`. */
	readonly id: number;
	/** The parent node's id; null for a search root. */
	readonly parent: number | null;
	readonly kind: IndexMapNodeKind;
	/** Display name: the file or folder name, or the root's full path. Empty for a parcel. */
	readonly name: string;
	/** Absolute path; a parcel carries its folder's path. */
	readonly path: string;
	/** A file's or parcel's own state; for a root or folder, its index coverage (`indexMapFolderState`). */
	readonly state: IndexMapState;
	/**
	 * Files this node stands for: 1 for a file, the folded count for a parcel, the subtree count for a folder. An
	 * excluded marker keeps at least 1 so it is drawn even when nothing under it is counted.
	 */
	readonly weight: number;
	/** Per-state file counts of everything this node stands for. */
	readonly counts: IndexMapCounts;
	/** Distance from the search root (root = 0). */
	readonly depth: number;
}

export interface IndexMap {
	/** The search roots, canonical, in config order. */
	readonly roots: readonly string[];
	readonly nodes: readonly IndexMapNode[];
	readonly totals: IndexMapCounts;
	/** True when the walk stopped at its entry limit, so the counts cover part of the scope. */
	readonly truncated: boolean;
	/** True when files or folders were folded into parcels to stay inside the drawing budget. */
	readonly folded: boolean;
}

export function emptyIndexMapCounts(): Record<IndexMapState, number> {
	return { indexed: 0, stale: 0, unindexed: 0, excluded: 0, unindexable: 0 };
}

/**
 * A folder's (or root's) index coverage, read from its per-state counts:
 *
 * - `indexed` when every eligible file under it is indexed (all),
 * - `stale` when some are (partial),
 * - `unindexed` when none are — nothing held yet, parse failures included (none),
 * - `excluded` when it has no eligible files at all, so there is nothing to index.
 *
 * Eligible files are the ones a refresh could index: unsupported files are never counted, and excluded files stay out
 * of the denominator (`indexed + stale + unindexed + unindexable`).
 */
export function indexMapFolderState(counts: IndexMapCounts): IndexMapState {
	const eligible = counts.indexed + counts.stale + counts.unindexed + counts.unindexable;
	if (eligible === 0) return "excluded";
	if (counts.indexed === eligible) return "indexed";
	return counts.indexed > 0 ? "stale" : "unindexed";
}
