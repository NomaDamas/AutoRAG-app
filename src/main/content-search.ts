/**
 * Model-free search of the local document index for the quick-search launcher: the same MinSync hybrid method the
 * agent searches first (BM25 fused with vectors over the parsed mirror), without a model, a prompt or a session.
 *
 * It runs in the fs worker's librarian thread, the only place in that process that loads `@autorag/librarian`, and must
 * not import `electron`. Datasources are left out on purpose: a launcher keystroke must never spawn a messenger CLI,
 * and only local files are something the launcher can open, copy or reveal.
 */

import { existsSync } from "node:fs";
import { basename } from "node:path";
import { AutoRAGLite, type RetrievalDiagnostic, type RetrievalOptions, type RetrievalResult, type RetrievalSelection, type RetrievalUnsearchedSurface } from "@autorag/librarian";
import { readRawConfigObject, resolveConfigPath, resolveConfigReadOnly } from "@autorag/librarian/core";
import { CONTENT_SEARCH_MAX_HITS, type ContentHit, type ContentSearchOutcome } from "../shared/content-search-contract";
import { readAppIndexing } from "./app-indexing";
import { createDefaultSearchRelevanceGate, matchesQueryLexicallyOrApprox, type SearchRelevanceGate } from "./search-relevance-gate";

/** The slice of `AutoRAGLite` a content search drives. */
export interface ContentSearchRuntime {
	searchSelected(
		query: string,
		selection?: RetrievalSelection,
		options?: RetrievalOptions,
	): Promise<{ results: RetrievalResult[]; diagnostics: RetrievalDiagnostic[]; unsearched: RetrievalUnsearchedSurface[] }>;
}

export interface ContentSearchDeps {
	/** The raw shared config and a key that changes whenever it does. */
	readonly loadConfig: () => Promise<{ readonly raw: Record<string, unknown>; readonly key: string }>;
	/** Builds the runtime for the current config; called again only after the key changed. */
	readonly open: (raw: Record<string, unknown>) => ContentSearchRuntime;
	/** Optional relevance filter (exact/edit-distance pass-through + Jev `noul >= 0.5` gate). */
	readonly relevanceGate?: SearchRelevanceGate;
}

export interface ContentSearch {
	search(query: string, limit?: number, signal?: AbortSignal): Promise<ContentSearchOutcome>;
}

/** Only the local hybrid method: no datasource method is eligible, so none is ever spawned. */
const LOCAL_HYBRID: RetrievalSelection = { datasourceIds: [], local: true, methods: ["hybrid"] };
/** The surface label the librarian gives local MinSync files in `unsearched`. */
const LOCAL_SURFACE = "minsync";
/** Chunks asked for per file shown: several chunks of one document usually rank together. */
const CHUNKS_PER_HIT = 3;
const SNIPPET_LENGTH = 160;

/** The passage as one line, cut to {@link SNIPPET_LENGTH} around the first query term that appears in it. */
export function contentSnippet(text: string, query: string): string {
	const flat = text.replace(/\s+/gu, " ").trim();
	if (flat.length <= SNIPPET_LENGTH) return flat;
	const lower = flat.toLowerCase();
	const terms = query.toLowerCase().split(/\s+/u).filter((term) => term.length > 0);
	const found = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
	const at = found.length === 0 ? 0 : Math.min(...found);
	const start = Math.max(0, Math.min(at - Math.floor(SNIPPET_LENGTH / 3), flat.length - SNIPPET_LENGTH));
	const end = start + SNIPPET_LENGTH;
	return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

function lineOf(result: RetrievalResult): number | null {
	const line = result.metadata.lineNumber;
	return typeof line === "number" && Number.isInteger(line) && line > 0 ? line : null;
}

export function createContentSearch(deps: ContentSearchDeps): ContentSearch {
	let cached: { readonly key: string; readonly runtime: ContentSearchRuntime } | null = null;
	return {
		async search(query, limit = CONTENT_SEARCH_MAX_HITS, signal) {
			const text = query.trim();
			if (text.length === 0) return { state: "ok", hits: [] };
			const { raw, key } = await deps.loadConfig();
			// Keyword-only mode embeds nothing, so there is no MinSync index to search.
			if (!readAppIndexing(raw).semanticSearch) return { state: "off", hits: [] };
			if (cached?.key !== key) cached = { key, runtime: deps.open(raw) };
			const answer = await cached.runtime.searchSelected(text, LOCAL_HYBRID, { topK: limit * CHUNKS_PER_HIT, ...(signal === undefined ? {} : { signal }) });
			if (answer.results.length === 0 && answer.unsearched.some((surface) => surface.surface === LOCAL_SURFACE)) return { state: "unavailable", hits: [] };
			const byFile = new Map<string, { chunk: RetrievalResult; lexical: boolean }>();
			for (const result of [...answer.results].sort((a, b) => b.score - a.score)) {
				const lexical = matchesQueryLexicallyOrApprox(text, `${basename(result.source)}\n${result.content}`);
				const existing = byFile.get(result.source);
				if (existing === undefined) {
					if (byFile.size >= limit) continue;
					byFile.set(result.source, { chunk: result, lexical });
				} else if (!existing.lexical && lexical) {
					byFile.set(result.source, { chunk: result, lexical: true });
				}
			}
			const candidates = [...byFile.values()].map(({ chunk }) => ({
				id: chunk.source,
				sourceLabel: "local-document",
				title: basename(chunk.source),
				subtitle: null,
				content: chunk.content,
				hit: { path: chunk.source, snippet: contentSnippet(chunk.content, text), line: lineOf(chunk), score: chunk.score } satisfies ContentHit,
			}));
			const filtered = deps.relevanceGate === undefined ? candidates : await deps.relevanceGate.filter(text, candidates, signal);
			return { state: "ok", hits: filtered.map((entry) => entry.hit) };
		},
	};
}

/** The raw shared AutoRAG config and a key that changes whenever it does. */
export function sharedConfigLoader(env: NodeJS.ProcessEnv, cwd: string): ContentSearchDeps["loadConfig"] {
	const input = { flags: {}, env, cwd };
	return async () => {
		const configPath = resolveConfigPath(input).configPath;
		const raw = existsSync(configPath) ? readRawConfigObject(configPath) : {};
		return { raw, key: `${configPath}\n${JSON.stringify(raw)}` };
	};
}

/**
 * The real search over the one shared AutoRAG config. Datasources are dropped from the runtime's config, so building it
 * constructs no datasource skill; the app's code-folder exclusions only change what a refresh writes, never a query.
 */
export function createDefaultContentSearch(
	env: NodeJS.ProcessEnv,
	cwd: string,
	relevanceGate: SearchRelevanceGate = createDefaultSearchRelevanceGate(env, cwd),
): ContentSearch {
	return createContentSearch({
		loadConfig: sharedConfigLoader(env, cwd),
		open: () => new AutoRAGLite({ ...resolveConfigReadOnly({ flags: {}, env, cwd }), datasources: {} }),
		relevanceGate,
	});
}
