/**
 * Viewport-driven thumbnail requests, factored out of the Finder controller so
 * the coalescing invariant is unit-testable.
 *
 * The list and grid are virtualized, so only rows near the viewport mount; each
 * mounted row without an OS icon reports itself, and the controller drains the
 * coalesced batch through the same enrichment the background pass uses. A folder
 * larger than the provider's per-call icon cap therefore fills in as the user
 * scrolls instead of going iconless past the first batch.
 */

import type { FinderEntry } from "../data/entries";

/** Cache identity the icon provider keys on: path plus the mtime the bytes were made for. */
export function thumbnailKey(entry: FinderEntry): string {
	return `${entry.path}\u0000${entry.modifiedAt ?? ""}`;
}

/** A file that still needs an OS icon; folders and already-resolved entries do not. */
export function needsThumbnail(entry: FinderEntry): boolean {
	return entry.kind === "file" && entry.modifiedAt !== undefined && (entry.iconUrl === null || entry.iconUrl === undefined);
}

/**
 * Drain `queue` into one enrichment batch: entries whose `location` the caller
 * accepts are marked in `requested` and returned; the rest are dropped (they
 * belong to a view that is no longer current). Draining the queue keeps the next
 * scroll burst from resending identities that are already in flight.
 */
export function takeThumbnailBatch(
	queue: Map<string, FinderEntry>,
	requested: Set<string>,
	acceptLocation: (location: string) => boolean,
): FinderEntry[] {
	const batch: FinderEntry[] = [];
	for (const [key, entry] of queue) {
		queue.delete(key);
		if (!acceptLocation(entry.location)) continue;
		requested.add(key);
		batch.push(entry);
	}
	return batch;
}
