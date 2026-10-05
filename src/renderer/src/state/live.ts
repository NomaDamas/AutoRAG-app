import { RECENTS_PATH } from "../../../shared/fs-contract";
import type { FsDirChange } from "../../../shared/live-contract";
import type { FinderEntry } from "../data/entries";
import { dirname } from "./paths";
import type { SelectionState } from "./selection";
import { SETTINGS_PATH } from "./tabs";

export interface LiveTab {
	readonly path: string;
}

/**
 * True when `path` names a location with a folder on disk to list, read, and
 * watch. The empty bridge path and app-owned UI locations (the Settings tab)
 * have none: sending those to the filesystem is the `fs:listDir 'Settings'
 * ENOENT` bug, so every listing/watch flow consults this predicate first.
 */
export function isFilesystemPath(path: string): boolean {
	return path !== "" && path !== SETTINGS_PATH;
}

export function watchSetFor(tabs: readonly LiveTab[]): string[] {
	const seen = new Set<string>();
	const dirs: string[] = [];
	for (const tab of tabs) {
		const path = tab.path;
		// Settings is an app UI location, not a folder: never hand it to the watcher.
		if (!isFilesystemPath(path) || path === RECENTS_PATH || seen.has(path)) {
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

export interface EntryPatch {
	readonly entries: readonly FinderEntry[];
	readonly removed: readonly string[];
}

export interface ListingScope {
	readonly generation: number;
	readonly path: string;
	readonly tabId: number;
}

export interface IncrementalListingOptions {
	readonly read: (dir: string, paths: readonly string[]) => Promise<EntryPatch>;
	readonly apply: (dir: string, patch: EntryPatch) => void;
	readonly isCurrent: (scope: ListingScope) => boolean;
	readonly onError: (error: unknown, scope: ListingScope) => void;
}

/**
 * Serialized incremental coordination for a folder's live events.
 *
 * A navigation generation starts a scope whose baseline is a full listing;
 * patches recorded before that baseline is adopted wait (so a slow listing
 * cannot overwrite or lose them). Once ready, one `read` is in flight at a
 * time and every later batch of changed paths is coalesced into a trailing Set
 * that drains afterwards — no path is dropped and none starves. Results only
 * apply while `isCurrent` holds for the scope they were read under, so a stale
 * scope (nav/tab/search change) never resurrects rows into a new context.
 */
export interface IncrementalListing {
	/** Open a navigation scope; its baseline full listing is pending. */
	begin(scope: ListingScope): void;
	/** A full listing load is pending for `scope`; block patch draining. */
	fullStarted(scope: ListingScope): void;
	/** The baseline for `scope` landed; drain the accumulated changed paths. */
	fullAdopted(scope: ListingScope): void;
	/** Record changed paths; direct children of the scope path only. */
	changed(paths: readonly string[]): void;
	/** Drop queued/in-flight work without leaving the scope unusable. */
	cancel(): void;
}

export function createIncrementalListing(options: IncrementalListingOptions): IncrementalListing {
	let scope: ListingScope | null = null;
	let baselinePending = false;
	let inFlight = false;
	let epoch = 0;
	const pending = new Set<string>();

	const drain = (): void => {
		if (scope === null || baselinePending || inFlight || pending.size === 0) {
			return;
		}
		const active = scope;
		const token = epoch;
		const paths = [...pending];
		pending.clear();
		inFlight = true;
		void options
			.read(active.path, paths)
			.then((patch) => {
				if (token !== epoch || scope !== active || !options.isCurrent(active)) {
					return;
				}
				options.apply(active.path, patch);
			})
			.catch((error: unknown) => {
				if (token !== epoch || scope !== active || !options.isCurrent(active)) {
					return;
				}
				options.onError(error, active);
			})
			.finally(() => {
				if (token !== epoch || scope !== active) {
					return;
				}
				inFlight = false;
				drain();
			});
	};

	return {
		begin(next) {
			scope = next;
			baselinePending = true;
			inFlight = false;
			pending.clear();
			epoch += 1;
		},
		fullStarted(candidate) {
			if (
				scope !== null &&
				candidate.generation === scope.generation &&
				candidate.path === scope.path &&
				candidate.tabId === scope.tabId
			) {
				baselinePending = true;
			}
		},
		fullAdopted(candidate) {
			if (
				scope === null ||
				candidate.generation !== scope.generation ||
				candidate.path !== scope.path ||
				candidate.tabId !== scope.tabId
			) {
				return;
			}
			baselinePending = false;
			drain();
		},
		changed(paths) {
			if (scope === null) {
				return;
			}
			const dir = scope.path;
			let added = false;
			for (const path of paths) {
				// `readEntries` only accepts direct children: skip the dir itself
				// (root metadata events) and anything nested beneath it.
				if (path === dir || dirname(path) !== dir || pending.has(path)) {
					continue;
				}
				pending.add(path);
				added = true;
			}
			if (added) {
				drain();
			}
		},
		cancel() {
			epoch += 1;
			inFlight = false;
			pending.clear();
		},
	};
}

/** Every field a row renders: entries equal on all of them need no re-render. */
const ENTRY_KEYS: readonly (keyof FinderEntry)[] = [
	"name",
	"path",
	"kind",
	"fileKind",
	"iconUrl",
	"modifiedAt",
	"dateLabel",
	"sizeLabel",
	"kindLabel",
	"location",
	"modifiedValue",
	"sizeValue",
	"createdValue",
	"addedValue",
	"lastOpenedValue",
	"tagsLabel",
	"commentsLabel",
	"dimensionsLabel",
	"dimensionsValue",
	"applicationLabel",
];

/** Applies current filesystem state for only the changed direct children. */
export function applyEntryPatch(listing: readonly FinderEntry[], patch: EntryPatch): readonly FinderEntry[] {
	if (patch.removed.length === 0 && patch.entries.length === 0) {
		return listing;
	}
	const removed = new Set(patch.removed);
	const updates = new Map(patch.entries.map((entry) => [entry.path, entry]));
	const result: FinderEntry[] = [];
	let changed = false;
	for (const entry of listing) {
		if (removed.has(entry.path)) {
			changed = true;
			continue;
		}
		const next = updates.get(entry.path);
		updates.delete(entry.path);
		if (next === undefined || next === entry || ENTRY_KEYS.every((key) => next[key] === entry[key])) {
			result.push(entry);
			continue;
		}
		result.push(next);
		changed = true;
	}
	for (const next of updates.values()) {
		result.push(next);
		changed = true;
	}
	return changed ? result : listing;
}

/** Applies enrichment only while the row still has the requested filesystem mtime. */
export function applyEntryEnrichmentPatch(
	listing: readonly FinderEntry[],
	enriched: readonly FinderEntry[],
): readonly FinderEntry[] {
	const currentByPath = new Map(listing.map((entry) => [entry.path, entry]));
	const fresh = enriched.filter((entry) => {
		const current = currentByPath.get(entry.path);
		return current !== undefined && current.modifiedAt === entry.modifiedAt;
	});
	return applyEntryPatch(listing, { entries: fresh, removed: [] });
}

/**
 * A fresh full listing of a folder whose rows are already known. `list`
 * returns bare rows — the OS kind and icon arrive later from `enrich` — so a
 * row whose file is unchanged on disk (same path and mtime) keeps what
 * enrichment already learned, and keeps its object when nothing else moved.
 * Returns `previous` itself when the folder is unchanged, so revalidating a
 * folder that is on screen paints nothing and never blanks its icons.
 */
export function reconcileListing(
	previous: readonly FinderEntry[],
	next: readonly FinderEntry[],
): readonly FinderEntry[] {
	if (previous.length === 0) {
		return next;
	}
	const known = new Map(previous.map((entry) => [entry.path, entry]));
	let changed = previous.length !== next.length;
	const result = next.map((entry, index) => {
		const before = known.get(entry.path);
		if (before === undefined) {
			changed = true;
			return entry;
		}
		const unchangedOnDisk = entry.modifiedAt !== undefined && entry.modifiedAt === before.modifiedAt;
		const carried: FinderEntry = unchangedOnDisk
			? {
					...entry,
					iconUrl: entry.iconUrl ?? before.iconUrl,
					kindLabel: before.kindLabel,
					...(before.createdValue === undefined ? {} : { createdValue: before.createdValue }),
					...(before.addedValue === undefined ? {} : { addedValue: before.addedValue }),
					...(before.lastOpenedValue === undefined ? {} : { lastOpenedValue: before.lastOpenedValue }),
					...(before.tagsLabel === undefined ? {} : { tagsLabel: before.tagsLabel }),
					...(before.commentsLabel === undefined ? {} : { commentsLabel: before.commentsLabel }),
					...(before.dimensionsLabel === undefined ? {} : { dimensionsLabel: before.dimensionsLabel }),
					...(before.dimensionsValue === undefined ? {} : { dimensionsValue: before.dimensionsValue }),
					...(before.ratingValue === undefined ? {} : { ratingValue: before.ratingValue }),
				}
			: entry;
		if (ENTRY_KEYS.every((key) => carried[key] === before[key])) {
			if (previous[index] !== before) changed = true;
			return before;
		}
		changed = true;
		return carried;
	});
	return changed ? result : previous;
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
	const anchor = selection.anchor !== null && survives(selection.anchor) ? selection.anchor : null;
	const focus = selection.focus !== null && survives(selection.focus) ? selection.focus : null;
	// Every key survived (filtering only removes) and the anchors held: nothing changed.
	if (keys.length === selection.keys.length && anchor === selection.anchor && focus === selection.focus) {
		return selection;
	}
	return { keys, anchor, focus };
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
