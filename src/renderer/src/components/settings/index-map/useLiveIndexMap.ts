import { useEffect, useRef, useState } from "react";
import type { IndexMap } from "../../../../../shared/index-map-contract";
import { mapProgress, NO_PROGRESS, type MapProgress } from "./progress";

/** How often the open map reads the index again while something is indexing. */
export const INDEX_MAP_REFRESH_MS = 10_000;

export interface LiveIndexMap {
	/** The newest map read. A read that fails after one succeeded keeps this; it never goes back to empty. */
	readonly map: IndexMap | null;
	/** Why the first read failed; null once any map has been read. */
	readonly error: string | null;
	/** Where the running index moved between the last two reads; empty while nothing is indexing, or when nothing moved. */
	readonly progress: MapProgress;
}

export interface LiveIndexMapSource {
	readonly read: () => Promise<IndexMap>;
	/** Fires when a refresh settles; returns the unsubscribe. */
	readonly onRefreshed: (listener: () => void) => () => void;
	/** True while the index is being built, i.e. while the map can change under the person looking at it. */
	readonly running: boolean;
	/** Names the scope the map describes (the search folders and exclusions). A different value reads at once. */
	readonly revision?: string;
}

/** Counts, per node, say everything a redraw depends on: an unchanged answer is not worth one. */
function sameMap(a: IndexMap, b: IndexMap): boolean {
	if (a.truncated !== b.truncated || a.folded !== b.folded || a.nodes.length !== b.nodes.length || a.roots.length !== b.roots.length) return false;
	for (let index = 0; index < a.roots.length; index += 1) if (a.roots[index] !== b.roots[index]) return false;
	for (let index = 0; index < a.nodes.length; index += 1) {
		const left = a.nodes[index]!;
		const right = b.nodes[index]!;
		if (left.path !== right.path || left.kind !== right.kind || left.state !== right.state || left.weight !== right.weight || left.parent !== right.parent) return false;
		for (const state of Object.keys(left.counts) as (keyof typeof left.counts)[]) if (left.counts[state] !== right.counts[state]) return false;
	}
	return true;
}

/**
 * The index map, kept current without the person asking. It reads on open, again when a refresh settles, and every
 * {@link INDEX_MAP_REFRESH_MS} while indexing runs, plus once when a run ends so the finished state shows. With no map
 * yet (the first read failed) it keeps trying at the same pace even when nothing is indexing: there is no reload button.
 *
 * It never takes the map away: a re-read that fails leaves the last good map on screen, and an answer equal to
 * the one shown keeps the same object, so the chart does not redraw. Reads never overlap; a refresh that settles
 * during a read is read again right after it, because that read may have walked the folders before the change.
 */
export function useLiveIndexMap(source: LiveIndexMapSource): LiveIndexMap {
	const [state, setState] = useState<LiveIndexMap>({ map: null, error: null, progress: NO_PROGRESS });
	const sourceRef = useRef(source);
	sourceRef.current = source;
	const control = useRef<{ read: () => void } | null>(null);
	const wasRunning = useRef(source.running);
	const haveMap = useRef(false);

	// One loop for the life of the modal: reads, timer, and the settle push all go through `read`.
	useEffect(() => {
		let alive = true;
		let reading = false;
		let again = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const schedule = (): void => {
			clearTimeout(timer);
			timer = undefined;
			if (!alive || !(sourceRef.current.running || !haveMap.current)) return;
			timer = setTimeout(read, INDEX_MAP_REFRESH_MS);
		};

		function read(): void {
			if (!alive) return;
			if (reading) {
				again = true;
				return;
			}
			reading = true;
			sourceRef.current.read().then(
				(next) => {
					haveMap.current = true;
					if (!alive) return;
					const indexing = sourceRef.current.running;
					setState((current) => {
						const same = current.map !== null && sameMap(current.map, next);
						const progress = indexing && current.map !== null ? mapProgress(current.map, next) : NO_PROGRESS;
						// Nothing new on either count: the same state, so nothing redraws.
						if (same && progress.here.size === 0 && current.progress.here.size === 0) return current;
						return { map: same ? current.map : next, error: null, progress };
					});
				},
				(failure: unknown) => {
					// Keep what is on screen; a first read with nothing to keep is the only failure the person sees.
					if (alive) setState((current) => (current.map !== null ? current : { map: null, error: failure instanceof Error ? failure.message : String(failure), progress: NO_PROGRESS }));
				},
			).finally(() => {
				reading = false;
				if (!alive) return;
				if (again) {
					again = false;
					read();
					return;
				}
				schedule();
			});
		}

		control.current = { read };
		read();
		const unsubscribe = sourceRef.current.onRefreshed(read);
		return () => {
			alive = false;
			control.current = null;
			clearTimeout(timer);
			unsubscribe();
		};
	}, []);

	// A run starting reads at once and begins the interval; a run ending reads once more for its final state.
	useEffect(() => {
		if (wasRunning.current !== source.running) control.current?.read();
		wasRunning.current = source.running;
	}, [source.running]);

	// Changing what the index covers changes the map right away, whether or not anything is indexing yet.
	const revision = useRef(source.revision);
	useEffect(() => {
		if (revision.current !== source.revision) control.current?.read();
		revision.current = source.revision;
	}, [source.revision]);

	return state;
}
