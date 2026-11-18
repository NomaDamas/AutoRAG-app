import { useEffect, useRef, useState } from "react";
import type { FinderSource } from "../data/source";
import { startWholeSearch, withContent, withDatasources, withSourceAnswer, type WholeSearchState } from "../state/whole-search";

/** A committed query asked again within this long shows the answers it already has (switching back to a search tab). */
const REUSE_MS = 60_000;
const CACHED_QUERIES = 8;

interface CachedSearch {
	readonly at: number;
	state: WholeSearchState;
}

/**
 * Asks the document index and every connected datasource for the committed `query`, all at once, and keeps each
 * answer as it lands. The filename list is not here: the Finder controller already searches it and shows it first.
 * Null while nothing is searched.
 */
export function useWholeSearch(source: FinderSource, query: string): WholeSearchState | null {
	const text = query.trim();
	const cache = useRef(new Map<string, CachedSearch>());
	/** The query on screen; an answer for any other query only updates its cache record. */
	const shown = useRef("");
	const [state, setState] = useState<WholeSearchState | null>(null);

	useEffect(() => {
		shown.current = text;
		if (text === "") {
			setState(null);
			return;
		}
		const remembered = cache.current.get(text);
		if (remembered !== undefined && Date.now() - remembered.at < REUSE_MS) {
			// A search still landing keeps writing into its record and to the screen while it is shown.
			setState(remembered.state);
			return;
		}
		const record: CachedSearch = { at: Date.now(), state: startWholeSearch(text) };
		cache.current.delete(text);
		cache.current.set(text, record);
		for (const key of cache.current.keys()) {
			if (cache.current.size <= CACHED_QUERIES) break;
			cache.current.delete(key);
		}
		const apply = (change: (current: WholeSearchState) => WholeSearchState): void => {
			record.state = change(record.state);
			if (shown.current === text && cache.current.get(text) === record) setState(record.state);
		};
		setState(record.state);
		source.contentSearch(text).then(
			(answer) => apply((current) => withContent(current, answer)),
			() => apply((current) => withContent(current, null)),
		);
		source.searchDatasources().then(
			(datasources) => {
				apply((current) => withDatasources(current, datasources));
				for (const datasource of datasources) {
					source.sourceSearch(datasource.id, text).then(
						(answer) => apply((current) => withSourceAnswer(current, datasource.id, answer)),
						(error: unknown) =>
							apply((current) => withSourceAnswer(current, datasource.id, { state: "error", hits: [], error: error instanceof Error ? error.message : String(error) })),
					);
				}
			},
			() => apply((current) => withDatasources(current, [])),
		);
	}, [source, text]);

	return state?.query === text ? state : null;
}
