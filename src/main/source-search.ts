/**
 * Model-free search of the connected datasources for the Finder's whole search (⌘F): one datasource per call, with
 * the same retrieval methods the agent uses for it, without a model, a prompt or a session.
 *
 * It runs in the fs worker's librarian thread next to `content-search.ts` and must not import `electron`. A query only
 * runs when the user commits a search, never per keystroke, because asking a datasource may start its CLI.
 */

import { AutoRAGLite, type RetrievalDiagnostic, type RetrievalOptions, type RetrievalResult, type RetrievalSelection } from "@autorag/librarian";
import { resolveConfigReadOnly } from "@autorag/librarian/core";
import { isJsonObject } from "../shared/settings-contract";
import { SOURCE_HIT_CONTENT_LIMIT, SOURCE_SEARCH_MAX_HITS, type SearchDatasource, type SourceHit, type SourceSearchOutcome } from "../shared/source-search-contract";
import { contentSnippet, sharedConfigLoader, type ContentSearchDeps } from "./content-search";
import { createDefaultSearchRelevanceGate, type SearchRelevanceGate } from "./search-relevance-gate";

/** The slice of `AutoRAGLite` a datasource search drives. */
export interface SourceSearchRuntime {
	listDatasources(): readonly { readonly datasourceId: string }[];
	searchSelected(query: string, selection?: RetrievalSelection, options?: RetrievalOptions): Promise<{ results: RetrievalResult[]; diagnostics: RetrievalDiagnostic[] }>;
}

export interface SourceSearchDeps {
	readonly loadConfig: ContentSearchDeps["loadConfig"];
	/** Builds the runtime for the current config; called again only after the config key changed. */
	readonly open: (raw: Record<string, unknown>) => SourceSearchRuntime;
	/** Optional relevance filter (exact/edit-distance pass-through + Jev `noul >= 0.5` gate). */
	readonly relevanceGate?: SearchRelevanceGate;
}

export interface SourceSearch {
	/** The enabled datasources the runtime registered, in config order. */
	datasources(): Promise<readonly SearchDatasource[]>;
	search(datasourceId: string, query: string, limit?: number, signal?: AbortSignal): Promise<SourceSearchOutcome>;
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function timestampOf(metadata: Record<string, unknown>): number | null {
	if (typeof metadata.publishedAt === "number" && Number.isFinite(metadata.publishedAt)) return metadata.publishedAt;
	for (const key of ["date", "visitedAt", "startedAt", "timestamp"]) {
		const value = metadata[key];
		if (typeof value !== "string") continue;
		const parsed = /^\d+(\.\d+)?$/u.test(value) ? Number(value) * 1000 : Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function urlOf(metadata: Record<string, unknown>): string | null {
	const url = text(metadata.url);
	return url !== null && /^https?:\/\//iu.test(url) ? url : null;
}

/**
 * A wombat hit is a chunk of the plain-text mirror wombat writes (one file per session), so it carries that file's
 * bookkeeping, which a row must not print:
 *   - the librarian's one-line `[<sessionKey> | turns A-B | date | title | project]` label, for the model, which reads only a
 *     result's content and needs the session key to open it. A row shows the title, the agent and the date beside the snippet.
 *   - the mirror file's path, as `<agent>/<project>/<session>__<hash>.md` or `<path>.md > Session <key>`;
 *   - the first chunk's `# Session <key>` heading and its `- key: value` header lines, which hold the source log's path;
 *   - each turn's `## Turn N | User | <time> [src:L12]` heading, which becomes `User:` in front of the turn's text.
 * Every pattern is anchored to a whole line, so a turn whose own text mentions one of them stays as written.
 */
const WOMBAT_LABEL = /^\[[^\]\n]*\]\n/u;
const MIRROR_PATH_LINE = /^[^\s>][^\n]*\.md(?: > [^\n]*)?\n/u;
const MIRROR_HEADER = /^# Session [^\n]*\n(?:- [a-z_]+: [^\n]*\n)*\n?/u;
const MIRROR_TURN_HEADING = /^## Turn \d+ \| (User|Assistant) \| [^\n]*? \[src:[^\]\n]*\]$/gmu;

function conversationOf(result: RetrievalResult): string {
	if (result.metadata.datasourceId !== "wombat") return result.content;
	return result.content
		.replace(WOMBAT_LABEL, "")
		.replace(MIRROR_PATH_LINE, "")
		.replace(MIRROR_HEADER, "")
		.replace(MIRROR_TURN_HEADING, "$1:");
}

/** A retrieval result as a row; exported for tests. */
export function sourceHit(result: RetrievalResult, query: string): SourceHit {
	const content = conversationOf(result);
	const flat = content.replace(/\s+/gu, " ").trim();
	return {
		id: result.id,
		// Each source names it differently: KakaoTalk `chatName`, Slack/Discord `channelName`, mail `subject`, pages `title`,
		// an AI session its `title` (or, untitled, its `sessionKey`).
		title:
			text(result.metadata.subject) ?? text(result.metadata.chatName) ?? text(result.metadata.channelName) ?? text(result.metadata.title) ?? text(result.metadata.sessionKey) ?? result.source,
		// The agent that ran an AI session stands where a chat's sender does.
		author:
			text(result.metadata.senderNickname) ?? text(result.metadata.authorName) ?? text(result.metadata.senderName) ?? text(result.metadata.from) ?? text(result.metadata.agent) ?? text(result.metadata.domain),
		snippet: contentSnippet(content, query),
		content: flat.length > SOURCE_HIT_CONTENT_LIMIT ? `${flat.slice(0, SOURCE_HIT_CONTENT_LIMIT)}…` : flat,
		timestamp: timestampOf(result.metadata),
		url: urlOf(result.metadata),
	};
}

/** The configured datasources that are not switched off, as `{ id, type }`. */
function configuredDatasources(raw: Record<string, unknown>): readonly SearchDatasource[] {
	if (!isJsonObject(raw.datasources)) return [];
	return Object.entries(raw.datasources).flatMap(([id, entry]) => {
		if (entry === false || (isJsonObject(entry) && entry.enabled === false)) return [];
		return [{ id, type: (isJsonObject(entry) ? text(entry.type) : null) ?? id }];
	});
}

export function createSourceSearch(deps: SourceSearchDeps): SourceSearch {
	let cached: { readonly key: string; readonly raw: Record<string, unknown>; readonly runtime: SourceSearchRuntime } | null = null;
	async function current(): Promise<{ readonly raw: Record<string, unknown>; readonly runtime: SourceSearchRuntime }> {
		const { raw, key } = await deps.loadConfig();
		if (cached?.key !== key) cached = { key, raw, runtime: deps.open(raw) };
		return cached;
	}
	return {
		async datasources() {
			const { raw, runtime } = await current();
			const registered = new Set(runtime.listDatasources().map((entry) => entry.datasourceId));
			return configuredDatasources(raw).filter((entry) => registered.has(entry.id));
		},
		async search(datasourceId, query, limit = SOURCE_SEARCH_MAX_HITS, signal) {
			const needle = query.trim();
			if (needle.length === 0) return { state: "ok", hits: [], error: null };
			const { runtime } = await current();
			try {
				const answer = await runtime.searchSelected(needle, { datasourceIds: [datasourceId], local: false }, { topK: limit, ...(signal === undefined ? {} : { signal }) });
				const failed = answer.diagnostics.find((diagnostic) => diagnostic.severity === "error");
				if (answer.results.length === 0 && failed !== undefined) return { state: "error", hits: [], error: failed.reason ?? failed.message };
				const rawHits = [...answer.results].sort((a, b) => b.score - a.score).slice(0, limit).map((result) => sourceHit(result, needle));
				if (deps.relevanceGate === undefined || rawHits.length === 0) return { state: "ok", hits: rawHits, error: null };
				const filtered = await deps.relevanceGate.filter(
					needle,
					rawHits.map((hit) => ({
						id: hit.id,
						sourceLabel: datasourceId,
						title: hit.title,
						subtitle: hit.author,
						content: hit.content,
						hit,
					})),
					signal,
				);
				return { state: "ok", hits: filtered.map((entry) => entry.hit), error: null };
			} catch (error) {
				if (signal?.aborted === true) throw error;
				return { state: "error", hits: [], error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}

/** The real search over the one shared AutoRAG config, datasources included. */
export function createDefaultSourceSearch(
	env: NodeJS.ProcessEnv,
	cwd: string,
	relevanceGate: SearchRelevanceGate = createDefaultSearchRelevanceGate(env, cwd),
): SourceSearch {
	return createSourceSearch({
		loadConfig: sharedConfigLoader(env, cwd),
		open: () => new AutoRAGLite(resolveConfigReadOnly({ flags: {}, env, cwd })),
		relevanceGate,
	});
}
