/**
 * Folder listings, owned outside React.
 *
 * Every view that shows a folder — a tab, a column pane, an expanded subfolder
 * in the list — reads the same snapshot here, keyed by folder path. The store
 * owns everything that used to live in each controller's closures: the
 * in-flight and trailing listing reads, which answer is newest, live
 * incremental patches, and the background enrichment that follows a listing.
 * React subscribes to snapshots (`useDirectory`) and never holds the
 * bookkeeping, so no render scope can keep an older listing alive.
 *
 * A snapshot's `entries` is the listing as read from disk. Icons, OS kinds,
 * and Finder metadata go to the entry sidecar, never into this array, so a
 * thumbnail batch leaves the listing — and everything sorted from it — as it
 * was. A relist that finds the folder unchanged keeps the same array.
 *
 * Views `retain` the folders they show. A released folder stays cached (a tab
 * switched back to paints at once) until it falls out of the most recent
 * `capacity` released folders.
 */

import type { FsEntryEnrichment, FsFinderEnrichment } from "../../../shared/fs-contract";
import type { LiveMessage } from "../../../shared/live-contract";
import {
	applyEntryPatch,
	applyOptimisticDeletes,
	createIncrementalListing,
	createListingLoader,
	type EntryPatch,
	type IncrementalListing,
	type ListingLoadMode,
	reconcileListing,
	withoutPaths,
} from "../state/live";
import { needsThumbnail, thumbnailKey } from "../state/thumbnails";
import type { FinderEntry } from "./entries";
import type { EntrySidecar } from "./entry-sidecar";

/** Released folders kept for an instant repaint. */
const DEFAULT_CAPACITY = 32;
/** Coalescing window for viewport icon requests, so a scroll burst is one batch. */
const DEFAULT_ICON_FLUSH_MS = 60;
/** File versions remembered as already asked for an icon. */
const ICON_REQUEST_MEMORY = 20_000;

export interface DirectorySource {
	list(dir: string): Promise<readonly FinderEntry[]>;
	readEntries(dir: string, paths: readonly string[]): Promise<EntryPatch>;
	enrich(entries: readonly FinderEntry[]): Promise<readonly FsEntryEnrichment[]>;
	finderMetadata(entries: readonly FinderEntry[]): Promise<readonly FsFinderEnrichment[]>;
	onLive(listener: (message: LiveMessage) => void): () => void;
}

export interface DirectorySnapshot {
	readonly dir: string;
	/** Store-wide publish counter: unique per snapshot, even across eviction. */
	readonly version: number;
	/** The folder's rows as read from disk; enrichment lives in the sidecar. */
	readonly entries: readonly FinderEntry[];
	/** A listing (or a navigate failure) has landed. */
	readonly loaded: boolean;
	/** The first listing is still in flight. */
	readonly loading: boolean;
	/** The last navigate failure; a silent failure keeps the rows and leaves this alone. */
	readonly error: unknown;
}

export type LoadOutcome =
	| { readonly kind: "loaded" }
	/** A newer answer for the folder won, or the folder left the store. */
	| { readonly kind: "stale" }
	| { readonly kind: "error"; readonly error: unknown };

export interface DirectoryStore {
	get(dir: string): DirectorySnapshot | undefined;
	subscribe(dir: string, listener: () => void): () => void;
	/** A view shows `dir`: keep it and its live patches. The release is idempotent. */
	retain(dir: string): () => void;
	/**
	 * Read `dir`. `navigate` is a user opening the folder (a failure empties
	 * it); `silent` revalidates what is shown, sharing one in-flight read per
	 * folder and keeping the rows on failure.
	 */
	load(dir: string, mode: ListingLoadMode): Promise<LoadOutcome>;
	/** OS kind, icon, and Finder metadata for rows that are not a folder listing (search hits). */
	enrich(entries: readonly FinderEntry[]): void;
	/** A mounted row still has no icon: coalesce it into the next viewport batch. */
	requestIcon(entry: FinderEntry): void;
	/**
	 * A trash or move just took `removed` out of their folders: drop those rows
	 * (and anything nested under a removed folder) from every cached folder at
	 * once, instead of waiting for the watcher's relist.
	 */
	drop(removed: readonly string[]): void;
	/** A retained folder vanished on disk. */
	onGone(listener: (dir: string) => void): () => void;
	/** Start applying live filesystem changes to retained folders. */
	connect(): () => void;
}

interface DirectoryRecord {
	snapshot: DirectorySnapshot;
	refs: number;
	/** Request sequence of the answer the snapshot holds; older answers are ignored. */
	applied: number;
	/** Full listings in flight; live patches wait until none is. */
	pendingFull: number;
	readonly incremental: IncrementalListing;
	readonly scope: { readonly generation: number; readonly path: string; readonly tabId: number };
}

export function createDirectoryStore(options: {
	readonly source: DirectorySource;
	readonly sidecar: EntrySidecar;
	readonly capacity?: number;
	readonly iconFlushMs?: number;
}): DirectoryStore {
	const { source, sidecar } = options;
	const capacity = options.capacity ?? DEFAULT_CAPACITY;
	const iconFlushMs = options.iconFlushMs ?? DEFAULT_ICON_FLUSH_MS;
	const records = new Map<string, DirectoryRecord>();
	/** Released folders, least recently used first. */
	const released = new Set<string>();
	const listeners = new Map<string, Set<() => void>>();
	const goneListeners = new Set<(dir: string) => void>();
	const iconQueue = new Map<string, FinderEntry>();
	const iconRequested = new Set<string>();
	let iconFlushPending = false;
	let sequence = 0;
	let generation = 0;
	let version = 0;

	const loader = createListingLoader<FinderEntry>((dir) => source.list(dir));

	const publish = (dir: string, record: DirectoryRecord, next: Omit<DirectorySnapshot, "dir" | "version">): void => {
		const current = record.snapshot;
		if (
			current.entries === next.entries &&
			current.loaded === next.loaded &&
			current.loading === next.loading &&
			current.error === next.error
		) {
			return;
		}
		version += 1;
		// Only the four state fields: callers pass `{ ...snapshot, entries }`, whose
		// stale `version` must never overwrite the new one.
		record.snapshot = { dir, version, entries: next.entries, loaded: next.loaded, loading: next.loading, error: next.error };
		for (const listener of listeners.get(dir) ?? []) listener();
	};

	const evict = (dir: string): void => {
		const record = records.get(dir);
		if (record === undefined) return;
		record.incremental.cancel();
		records.delete(dir);
		released.delete(dir);
		for (const listener of listeners.get(dir) ?? []) listener();
	};

	const trim = (): void => {
		for (const dir of released) {
			if (released.size <= capacity) break;
			evict(dir);
		}
	};

	/** Both background passes for rows the sidecar has not heard about yet. */
	const enrich = (entries: readonly FinderEntry[]): void => {
		const needKind = entries.filter((entry) => entry.modifiedAt !== undefined && !sidecar.hasKind(entry));
		const needMetadata = entries.filter((entry) => entry.modifiedAt !== undefined && !sidecar.hasMetadata(entry));
		if (needKind.length > 0) {
			source
				.enrich(needKind)
				.then((enriched) => sidecar.applyEnrichment(enriched))
				.catch((error: unknown) => console.error("background enrichment failed", error));
		}
		if (needMetadata.length > 0) {
			source
				.finderMetadata(needMetadata)
				.then((enriched) => sidecar.applyMetadata(enriched, needMetadata))
				.catch((error: unknown) => console.error("background metadata failed", error));
		}
	};

	const create = (dir: string): DirectoryRecord => {
		generation += 1;
		const scope = { generation, path: dir, tabId: 0 };
		const record: DirectoryRecord = {
			snapshot: { dir, version: (version += 1), entries: [], loaded: false, loading: true, error: null },
			refs: 0,
			applied: 0,
			pendingFull: 0,
			scope,
			incremental: createIncrementalListing({
				read: (path, paths) => source.readEntries(path, paths),
				apply: (path, patch) => {
					publish(path, record, { ...record.snapshot, entries: applyEntryPatch(record.snapshot.entries, patch) });
					enrich(patch.entries);
				},
				isCurrent: () => records.get(dir) === record,
				onError: (error) => {
					console.error("live incremental listing failed", error);
					void load(dir, "silent");
				},
			}),
		};
		record.incremental.begin(scope);
		records.set(dir, record);
		return record;
	};

	/** A folder read without a view holding it is cached like a released one. */
	const createReleased = (dir: string): DirectoryRecord => {
		const record = create(dir);
		released.add(dir);
		trim();
		return record;
	};

	const load = async (dir: string, mode: ListingLoadMode): Promise<LoadOutcome> => {
		const record = records.get(dir) ?? createReleased(dir);
		sequence += 1;
		const request = sequence;
		record.pendingFull += 1;
		record.incremental.fullStarted(record.scope);
		const result = await loader({ path: dir, generation: request, mode, previous: [] });
		record.pendingFull -= 1;
		const current = records.get(dir) === record && request > record.applied;
		if (current && result.kind === "loaded") {
			record.applied = request;
			const entries = reconcileListing(record.snapshot.entries, result.entries);
			publish(dir, record, { entries, loaded: true, loading: false, error: null });
			enrich(entries);
		} else if (current && result.kind === "error" && mode === "navigate") {
			record.applied = request;
			publish(dir, record, { entries: [], loaded: true, loading: false, error: result.error });
		}
		if (record.pendingFull === 0 && records.get(dir) === record) record.incremental.fullAdopted(record.scope);
		if (result.kind === "error" && records.get(dir) === record && request >= record.applied) {
			return { kind: "error", error: result.error };
		}
		return current && result.kind === "loaded" ? { kind: "loaded" } : { kind: "stale" };
	};

	const flushIcons = (): void => {
		iconFlushPending = false;
		const batch = [...iconQueue.values()];
		iconQueue.clear();
		if (batch.length === 0) return;
		for (const entry of batch) {
			iconRequested.add(thumbnailKey(entry));
			if (iconRequested.size > ICON_REQUEST_MEMORY) {
				const oldest = iconRequested.values().next();
				if (oldest.done !== true) iconRequested.delete(oldest.value);
			}
		}
		// Icons only: the background pass already asked for these rows' Finder metadata.
		source
			.enrich(batch)
			.then((enriched) => sidecar.applyEnrichment(enriched))
			.catch((error: unknown) => console.error("viewport thumbnail enrichment failed", error));
	};

	const onLive = (message: LiveMessage): void => {
		for (const change of message.dirs) {
			const record = records.get(change.dir);
			// Only folders on screen follow live changes; a cached one revalidates when shown again.
			if (record === undefined || record.refs === 0) continue;
			if (change.dirGone || change.overflow) {
				const entries = applyOptimisticDeletes(record.snapshot.entries, change);
				publish(change.dir, record, { ...record.snapshot, entries });
				if (change.dirGone) for (const listener of goneListeners) listener(change.dir);
				void load(change.dir, "silent");
				continue;
			}
			record.incremental.changed(change.changes.map(({ path }) => path));
		}
	};

	return {
		get: (dir) => records.get(dir)?.snapshot,
		subscribe(dir, listener) {
			let set = listeners.get(dir);
			if (set === undefined) {
				set = new Set();
				listeners.set(dir, set);
			}
			set.add(listener);
			return () => {
				const current = listeners.get(dir);
				if (current === undefined) return;
				current.delete(listener);
				if (current.size === 0) listeners.delete(dir);
			};
		},
		retain(dir) {
			const record = records.get(dir) ?? create(dir);
			record.refs += 1;
			released.delete(dir);
			let held = true;
			return () => {
				if (!held) return;
				held = false;
				if (records.get(dir) !== record) return;
				record.refs -= 1;
				if (record.refs > 0) return;
				released.add(dir);
				trim();
			};
		},
		load,
		enrich,
		drop(removed) {
			if (removed.length === 0) return;
			for (const [dir, record] of records) {
				const entries = withoutPaths(record.snapshot.entries, removed);
				if (entries !== record.snapshot.entries) publish(dir, record, { ...record.snapshot, entries });
			}
		},
		requestIcon(entry) {
			if (!needsThumbnail(entry)) return;
			const key = thumbnailKey(entry);
			if (iconRequested.has(key) || iconQueue.has(key)) return;
			iconQueue.set(key, entry);
			if (iconFlushPending) return;
			iconFlushPending = true;
			setTimeout(flushIcons, iconFlushMs);
		},
		onGone(listener) {
			goneListeners.add(listener);
			return () => {
				goneListeners.delete(listener);
			};
		},
		connect: () => source.onLive(onLive),
	};
}
