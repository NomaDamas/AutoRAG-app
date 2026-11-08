/**
 * The Finder's whole search (⌘F): one committed query asked of every surface at once — the platform filename index
 * (the Finder list itself), the local document index, and each connected datasource — with every answer kept under its
 * own group. Pure transitions; `hooks/useWholeSearch.ts` drives them from the bridge.
 */

import type { ContentSearchState } from "../../../shared/content-search-contract";
import type { SearchDatasource, SourceHit } from "../../../shared/source-search-contract";
import type { ContentRowInput } from "./launcher";

/** `files` is the filename list, `content` the document index, `source:<id>` one datasource. */
export type SearchGroupKey = "files" | "content" | `source:${string}`;

/** `off`: keyword-only mode has no document index; `unavailable`: the index is not built yet. */
export type SearchGroupStatus = "pending" | "ready" | "off" | "unavailable" | "error";

interface SourceAnswer {
	readonly status: "pending" | "ready" | "error";
	readonly hits: readonly SourceHit[];
	readonly error: string | null;
}

export interface WholeSearchState {
	readonly query: string;
	readonly content: { readonly status: "pending" | ContentSearchState | "error"; readonly hits: readonly ContentRowInput[] };
	/** Null until the datasource list arrived. */
	readonly datasources: readonly SearchDatasource[] | null;
	readonly sources: ReadonlyMap<string, SourceAnswer>;
}

export interface SearchGroup {
	readonly key: SearchGroupKey;
	readonly status: SearchGroupStatus;
	/** Null while pending or when the surface could not answer. */
	readonly count: number | null;
	readonly datasource: SearchDatasource | null;
	readonly error: string | null;
}

export function startWholeSearch(query: string): WholeSearchState {
	return { query, content: { status: "pending", hits: [] }, datasources: null, sources: new Map() };
}

export function withContent(state: WholeSearchState, answer: { readonly state: ContentSearchState; readonly hits: readonly ContentRowInput[] } | null): WholeSearchState {
	return { ...state, content: answer === null ? { status: "error", hits: [] } : { status: answer.state, hits: answer.hits } };
}

/** The datasource list arrived: every one of them is now asked. A failed list means no datasource group. */
export function withDatasources(state: WholeSearchState, datasources: readonly SearchDatasource[]): WholeSearchState {
	return { ...state, datasources, sources: new Map(datasources.map((datasource) => [datasource.id, { status: "pending", hits: [], error: null }])) };
}

export function withSourceAnswer(state: WholeSearchState, datasourceId: string, answer: { readonly state: "ok" | "error"; readonly hits: readonly SourceHit[]; readonly error: string | null }): WholeSearchState {
	if (!state.sources.has(datasourceId)) return state;
	const sources = new Map(state.sources);
	sources.set(datasourceId, answer.state === "ok" ? { status: "ready", hits: answer.hits, error: null } : { status: "error", hits: [], error: answer.error });
	return { ...state, sources };
}

/**
 * The group tabs, in a fixed order so a tab never moves under the pointer while answers land: file names, document
 * content, then the datasources in config order.
 */
export function searchGroups(state: WholeSearchState, fileCount: number): readonly SearchGroup[] {
	const content = state.content;
	const groups: SearchGroup[] = [
		{ key: "files", status: "ready", count: fileCount, datasource: null, error: null },
		{
			key: "content",
			status: content.status === "ok" ? "ready" : content.status,
			count: content.status === "ok" ? content.hits.length : null,
			datasource: null,
			error: null,
		},
	];
	for (const datasource of state.datasources ?? []) {
		const answer = state.sources.get(datasource.id);
		const status = answer?.status ?? "pending";
		groups.push({ key: `source:${datasource.id}`, status, count: status === "ready" ? (answer?.hits.length ?? 0) : null, datasource, error: answer?.error ?? null });
	}
	return groups;
}
