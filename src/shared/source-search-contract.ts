/**
 * Model-free search of the connected datasources (KakaoTalk, Slack, mail, browser history, …) for the Finder's
 * whole search: each datasource is asked on its own, so a slow messenger CLI never holds back the others, and every
 * answer is shown under its own source tab next to the filename and document-content results.
 */

/** One connected datasource the search can ask. */
export interface SearchDatasource {
	/** The config alias (`datasources.<id>`), e.g. `"kakao"` or `"nomadamas"`. */
	readonly id: string;
	/** The settings template it was made from (`"kakao"`, `"discord"`, `"hister"`, …); the alias when it names none. */
	readonly type: string;
}

/** One message, mail, or page a datasource matched. */
export interface SourceHit {
	readonly id: string;
	/** Chat room, channel, mail subject, or page title. */
	readonly title: string;
	/** Who wrote it (sender, author, mail sender) or the site it came from; null when the source does not say. */
	readonly author: string | null;
	/** The matched passage as one line, cut around the first query term. */
	readonly snippet: string;
	/** The whole passage, capped at {@link SOURCE_HIT_CONTENT_LIMIT} characters. */
	readonly content: string;
	/** When it was written or visited, epoch milliseconds. */
	readonly timestamp: number | null;
	/** An http(s) page to open (browser history); null for messages. */
	readonly url: string | null;
}

/** `error` carries the datasource's own failure text (CLI missing, not signed in, …); `ok` may have no hits. */
export interface SourceSearchOutcome {
	readonly state: "ok" | "error";
	readonly hits: readonly SourceHit[];
	readonly error: string | null;
}

/** Most hits one datasource returns. */
export const SOURCE_SEARCH_MAX_HITS = 30;
export const SOURCE_HIT_CONTENT_LIMIT = 2000;
