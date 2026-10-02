import { RECENTS_PATH } from "../../../shared/fs-contract";
import type { FsDirChange } from "../../../shared/live-contract";
import type { FinderEntry } from "../data/entries";
import { dirname } from "./paths";
import type { SelectionState } from "./selection";
import { CONTACTS_PATH } from "./tabs";

export interface LiveTab {
	readonly path: string;
}

export function watchSetFor(tabs: readonly LiveTab[]): string[] {
	const seen = new Set<string>();
	const dirs: string[] = [];
	for (const tab of tabs) {
		const path = tab.path;
		if (path === "" || path === RECENTS_PATH || path === CONTACTS_PATH || seen.has(path)) {
			continue;
		}
		seen.add(path);
		dirs.push(path);
	}
	return dirs;
}

export function applyOptimisticDeletes(
	listing: readonly FinderEntry[],
	dirChange: FsDirChange,
): readonly FinderEntry[] {
	const deleted = new Set(
		dirChange.changes
			.filter((change) => change.type === "delete")
			.map((change) => change.path),
	);
	return deleted.size === 0 ? listing : listing.filter((entry) => !deleted.has(entry.path));
}

/**
 * The keep-test for a relisted folder: a path vanished only when it belonged to
 * that listing (shown before, or a direct child of `dir`) and is absent now.
 * Selections in expanded subfolders and other column panes are left alone.
 */
export function listingSurvivor(
	dir: string,
	previous: readonly FinderEntry[],
	next: readonly FinderEntry[],
): (path: string) => boolean {
	const surviving = new Set(next.map((entry) => entry.path));
	const shown = new Set(previous.map((entry) => entry.path));
	return (path) => surviving.has(path) || (!shown.has(path) && dirname(path) !== dir);
}

export function pruneSelection(selection: SelectionState, survives: (path: string) => boolean): SelectionState {
	const keys = selection.keys.filter(survives);
	return {
		keys,
		anchor: selection.anchor !== null && survives(selection.anchor) ? selection.anchor : null,
		focus: selection.focus !== null && survives(selection.focus) ? selection.focus : null,
	};
}

export async function nearestExistingAncestor(
	path: string,
	exists: (path: string) => Promise<boolean>,
): Promise<string | null> {
	let candidate = path;
	while (candidate !== "") {
		if (await exists(candidate)) {
			return candidate;
		}
		const parent = dirname(candidate);
		if (parent === candidate) {
			break;
		}
		candidate = parent;
	}
	return null;
}

export type ListingLoadMode = "navigate" | "silent";

export interface ListingLoadRequest<T> {
	readonly path: string;
	readonly generation: number;
	readonly mode: ListingLoadMode;
	readonly previous: readonly T[];
}

export type ListingLoadResult<T> =
	| {
			readonly kind: "loaded";
			readonly request: ListingLoadRequest<T>;
			readonly entries: readonly T[];
	  }
	| {
			readonly kind: "stale" | "superseded";
			readonly request: ListingLoadRequest<T>;
			readonly entries: readonly T[];
	  }
	| {
			readonly kind: "error";
			readonly request: ListingLoadRequest<T>;
			readonly entries: readonly T[];
			readonly error: unknown;
	  };

export type ListingLoader<T> = (
	request: ListingLoadRequest<T>,
) => Promise<ListingLoadResult<T>>;

interface Pending<T> {
	readonly request: ListingLoadRequest<T>;
	readonly resolve: (result: ListingLoadResult<T>) => void;
}

/**
 * A generation-aware listing loader. Silent requests share one in-flight
 * request per path and retain only the newest trailing request. A stale
 * response remains observable as `stale` so the controller can drop it
 * without clearing the newer listing.
 */
export function createListingLoader<T>(
	list: (path: string) => Promise<readonly T[]>,
	isCurrent: (request: ListingLoadRequest<T>) => boolean = () => true,
): ListingLoader<T> {
	const inFlight = new Map<string, Promise<ListingLoadResult<T>>>();
	const trailing = new Map<string, Pending<T>>();

	const execute = async (request: ListingLoadRequest<T>): Promise<ListingLoadResult<T>> => {
		try {
			const entries = await list(request.path);
			return isCurrent(request)
				? { kind: "loaded", request, entries }
				: { kind: "stale", request, entries: request.previous };
		} catch (error: unknown) {
			return isCurrent(request)
				? { kind: "error", request, entries: request.previous, error }
				: { kind: "stale", request, entries: request.previous };
		}
	};

	const executeSilent = (request: ListingLoadRequest<T>): Promise<ListingLoadResult<T>> => {
		const promise = execute(request);
		inFlight.set(request.path, promise);
		void promise.then(() => {
			inFlight.delete(request.path);
			const next = trailing.get(request.path);
			if (next === undefined) {
				return;
			}
			trailing.delete(request.path);
			const nextPromise = executeSilent(next.request);
			void nextPromise.then(next.resolve);
		});
		return promise;
	};

	return (request) => {
		if (request.mode !== "silent") {
			return execute(request);
		}
		if (inFlight.has(request.path)) {
			const previous = trailing.get(request.path);
			if (previous !== undefined) {
				previous.resolve({
					kind: "superseded",
					request: previous.request,
					entries: previous.request.previous,
				});
			}
			return new Promise<ListingLoadResult<T>>((resolve) => {
				trailing.set(request.path, { request, resolve });
			});
		}
		return executeSilent(request);
	};
}
