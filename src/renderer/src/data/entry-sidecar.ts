/**
 * What the Finder learns about a row after it is listed, kept beside the
 * listing instead of inside it.
 *
 * A folder listing is bare filesystem metadata; the OS kind, the tile icon,
 * Finder metadata (tags, dates, dimensions, default app), and the AutoRAG
 * index state arrive later, in batches. Writing each batch back into the
 * listing used to rebuild the whole array and re-run sort → group → tree for
 * every batch, and every rebuilt array stayed reachable from whatever still
 * held the previous one. Here the listing stays as it was read; enrichment is
 * keyed by file version (`path` + mtime, so a stale answer never lands on a
 * newer file) and index state by path, and a row reads both through
 * `resolve` and `indexStatus`, subscribed to its own path only.
 */

import type { FsEntryEnrichment, FsFinderEnrichment, FsFinderMetadata } from "../../../shared/fs-contract";
import type { IndexStatus } from "../../../shared/index-contract";
import { type FinderEntry, hasFileVersion } from "./entries";

/** Records kept per kind (icons, metadata, index states) before the oldest go. */
const DEFAULT_CAPACITY = 20_000;

interface KindRecord {
	readonly osKind: string | null;
	readonly iconUrl: string | null;
}

interface MetadataRecord {
	readonly finder: FsFinderMetadata | null;
}

export interface EntrySidecar {
	/**
	 * `entry` with every enrichment known for its file version applied, or
	 * `entry` itself when none is. Stable: the same inputs give the same
	 * object, so a row only re-renders when its own data moved.
	 */
	resolve(entry: FinderEntry): FinderEntry;
	/** The OS kind pass has answered for this file version. */
	hasKind(entry: FinderEntry): boolean;
	/** The Finder metadata pass has answered for this file version. */
	hasMetadata(entry: FinderEntry): boolean;
	applyEnrichment(enriched: readonly FsEntryEnrichment[]): void;
	/**
	 * Finder metadata results. `requested` names every version that was asked
	 * for, so a file the helpers had nothing for is not asked again.
	 */
	applyMetadata(enriched: readonly FsFinderEnrichment[], requested?: readonly FinderEntry[]): void;
	indexStatus(path: string): IndexStatus | null;
	setIndexStatuses(statuses: readonly IndexStatus[]): void;
	/** Bumped whenever anything about `path` changes (rows key their subscription on it). */
	revision(path: string): number;
	/** Bumped once per batch that changed row data (kind, icon, metadata). */
	version(): number;
	subscribe(path: string, listener: () => void): () => void;
	/** Every batch that changed row data; the sort pipeline listens when it orders by enrichment. */
	subscribeAll(listener: () => void): () => void;
}

/** Cache identity of one file version. */
function versionKey(path: string, mtimeMs: number): string {
	return `${path}\u0000${mtimeMs}`;
}

function entryKey(entry: FinderEntry): string | null {
	return hasFileVersion(entry) ? versionKey(entry.path, entry.mtimeMs) : null;
}

/** Map with insertion-order eviction past `capacity`; `set` refreshes recency. */
function remember<K, V>(map: Map<K, V>, key: K, value: V, capacity: number): void {
	map.delete(key);
	map.set(key, value);
	while (map.size > capacity) {
		const oldest = map.keys().next();
		if (oldest.done === true) break;
		map.delete(oldest.value);
	}
}

function sameFinder(a: FsFinderMetadata | null, b: FsFinderMetadata | null): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	return (
		a.createdAt === b.createdAt &&
		a.addedAt === b.addedAt &&
		a.lastOpenedAt === b.lastOpenedAt &&
		a.comments === b.comments &&
		a.width === b.width &&
		a.height === b.height &&
		a.rating === b.rating &&
		a.application === b.application &&
		a.tags.length === b.tags.length &&
		a.tags.every((tag, index) => tag === b.tags[index])
	);
}

interface Resolved {
	readonly kind: KindRecord | undefined;
	readonly metadata: MetadataRecord | undefined;
	readonly row: FinderEntry;
}

export function createEntrySidecar(options: { readonly capacity?: number } = {}): EntrySidecar {
	const capacity = options.capacity ?? DEFAULT_CAPACITY;
	const kinds = new Map<string, KindRecord>();
	const metadata = new Map<string, MetadataRecord>();
	const statuses = new Map<string, IndexStatus>();
	const revisions = new Map<string, number>();
	const listeners = new Map<string, Set<() => void>>();
	const allListeners = new Set<() => void>();
	/** Listed row → its merged row, for as long as the listed row is alive. */
	const resolved = new WeakMap<FinderEntry, Resolved>();
	/** Merged row → the listed row it was made from, so resolving it again is stable. */
	const baseOf = new WeakMap<FinderEntry, FinderEntry>();
	let dataVersion = 0;
	/** One sequence for every path, so a path evicted and touched again never repeats a revision. */
	let sequence = 0;

	const touch = (changed: Set<string>, path: string): void => {
		changed.add(path);
		sequence += 1;
		remember(revisions, path, sequence, capacity);
	};
	const notify = (changed: ReadonlySet<string>, rowData: boolean): void => {
		if (changed.size === 0) return;
		if (rowData) dataVersion += 1;
		for (const path of changed) {
			for (const listener of listeners.get(path) ?? []) listener();
		}
		if (rowData) for (const listener of allListeners) listener();
	};

	/** The listed row plus what the OS answered; labels derive from these when a cell renders. */
	const merge = (entry: FinderEntry, kind: KindRecord | undefined, meta: MetadataRecord | undefined): FinderEntry => {
		const osKind = kind?.osKind ?? undefined;
		const iconUrl = kind?.iconUrl ?? undefined;
		const finder = meta?.finder ?? undefined;
		if (osKind === undefined && iconUrl === undefined && finder === undefined) return entry;
		return {
			...entry,
			...(osKind === undefined ? {} : { osKind }),
			...(iconUrl === undefined ? {} : { iconUrl }),
			...(finder === undefined ? {} : { finder }),
		};
	};

	return {
		resolve(input) {
			const entry = baseOf.get(input) ?? input;
			const key = entryKey(entry);
			if (key === null) return entry;
			const kind = kinds.get(key);
			const meta = metadata.get(key);
			if (kind === undefined && meta === undefined) return entry;
			const cached = resolved.get(entry);
			if (cached !== undefined && cached.kind === kind && cached.metadata === meta) return cached.row;
			const row = merge(entry, kind, meta);
			resolved.set(entry, { kind, metadata: meta, row });
			if (row !== entry) baseOf.set(row, entry);
			return row;
		},
		hasKind(entry) {
			const key = entryKey(entry);
			return key !== null && kinds.has(key);
		},
		hasMetadata(entry) {
			const key = entryKey(entry);
			return key !== null && metadata.has(key);
		},
		applyEnrichment(enriched) {
			const changed = new Set<string>();
			for (const patch of enriched) {
				const key = versionKey(patch.path, patch.mtimeMs);
				const current = kinds.get(key);
				// A capped background pass answers null icons for rows it did not
				// render; an icon the viewport pass already loaded stays.
				const next: KindRecord = {
					osKind: patch.osKind ?? current?.osKind ?? null,
					iconUrl: patch.iconUrl ?? current?.iconUrl ?? null,
				};
				if (current !== undefined && current.osKind === next.osKind && current.iconUrl === next.iconUrl) continue;
				remember(kinds, key, next, capacity);
				touch(changed, patch.path);
			}
			notify(changed, true);
		},
		applyMetadata(enriched, requested = []) {
			const changed = new Set<string>();
			const answered = new Set<string>();
			for (const patch of enriched) {
				const key = versionKey(patch.path, patch.mtimeMs);
				answered.add(key);
				const current = metadata.get(key);
				if (current !== undefined && sameFinder(current.finder, patch.finder)) continue;
				remember(metadata, key, { finder: patch.finder }, capacity);
				touch(changed, patch.path);
			}
			for (const entry of requested) {
				const key = entryKey(entry);
				if (key === null) continue;
				// Asked and nothing came back: remembered, so it is not asked again.
				if (!answered.has(key) && !metadata.has(key)) remember(metadata, key, { finder: null }, capacity);
			}
			notify(changed, true);
		},
		indexStatus(path) {
			return statuses.get(path) ?? null;
		},
		setIndexStatuses(next) {
			const changed = new Set<string>();
			for (const status of next) {
				const current = statuses.get(status.path);
				if (
					current !== undefined &&
					current.kind === status.kind &&
					current.excluded === status.excluded &&
					current.toggleable === status.toggleable &&
					current.detail === status.detail
				) {
					continue;
				}
				remember(statuses, status.path, status, capacity);
				touch(changed, status.path);
			}
			notify(changed, false);
		},
		revision(path) {
			return revisions.get(path) ?? 0;
		},
		version() {
			return dataVersion;
		},
		subscribe(path, listener) {
			let set = listeners.get(path);
			if (set === undefined) {
				set = new Set();
				listeners.set(path, set);
			}
			set.add(listener);
			return () => {
				const current = listeners.get(path);
				if (current === undefined) return;
				current.delete(listener);
				if (current.size === 0) listeners.delete(path);
			};
		},
		subscribeAll(listener) {
			allListeners.add(listener);
			return () => {
				allListeners.delete(listener);
			};
		},
	};
}
