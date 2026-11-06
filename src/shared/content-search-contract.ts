import type { FsEntry } from "./fs-contract";

/**
 * Model-free search of the local document index (MinSync hybrid: BM25 + vectors over the parsed mirror), for surfaces
 * that list matching files instead of asking the agent: the quick-search launcher. One row per file, best chunk first.
 *
 * `state` says whether the index could answer: `off` in keyword-only mode (nothing is embedded, there is no
 * MinSync index to search), `unavailable` when the local index was not searched (not built yet, binary missing),
 * `ok` otherwise, even with no hits.
 */
export type ContentSearchState = "ok" | "off" | "unavailable";

/** One file the index matched, as the librarian thread reports it. */
export interface ContentHit {
	/** Absolute path of the source file (not its parsed mirror). */
	readonly path: string;
	/** The matched passage, whitespace collapsed and cut around the first query term. */
	readonly snippet: string;
	/** 1-based line of the passage in the parsed text, when the librarian located it. */
	readonly line: number | null;
	readonly score: number;
}

export interface ContentSearchOutcome {
	readonly state: ContentSearchState;
	readonly hits: readonly ContentHit[];
}

/** A hit the fs worker resolved on disk; a file that vanished since indexing is dropped. */
export interface ContentSearchResultHit extends Omit<ContentHit, "path"> {
	readonly entry: FsEntry;
}

export interface ContentSearchResult {
	readonly state: ContentSearchState;
	readonly hits: readonly ContentSearchResultHit[];
}

/** Most files one content search returns. */
export const CONTENT_SEARCH_MAX_HITS = 20;
