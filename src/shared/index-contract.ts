/**
 * Per-file AutoRAG local-index state for the Finder's index badge.
 *
 * `kind` is what the index actually holds right now (parsed mirror + MinSync
 * staging); `excluded` is the user's intent in the shared AutoRAG config
 * (`excludePaths`). They differ while a refresh is still applying a toggle.
 */
export type IndexStatusKind =
	/** Parsed and staged into the MinSync workspace. */
	| "included"
	/** Excluded by config and absent from the index. */
	| "excluded"
	/** Index and config disagree until the next refresh lands. */
	| "pending"
	/** Refresh deliberately left it out (duplicate, oversize, parse failure). Not toggleable. */
	| "skipped"
	/** No parser handles this file type, so no refresh can ever index it. Not toggleable. */
	| "unsupported"
	/** Not under any configured AutoRAG search path. */
	| "outside";

export interface IndexStatus {
	readonly path: string;
	readonly kind: IndexStatusKind;
	/** True when `excludePaths` covers this file. */
	readonly excluded: boolean;
	/** False when a parent folder's exclusion or the search roots decide it. */
	readonly toggleable: boolean;
	readonly detail: string;
}
