/**
 * Viewport-driven thumbnail requests: the identity the icon provider caches
 * by, and which rows still need one. The list and grid are virtualized, so
 * only rows near the viewport mount; each mounted row without an OS icon
 * reports itself and the directory store coalesces those into one batch. A
 * folder larger than the provider's per-call icon cap therefore fills in as
 * the user scrolls instead of going iconless past the first batch.
 */

import { type FinderEntry, hasFileVersion } from "../data/entries";

/** Cache identity the icon provider keys on: path plus the mtime the bytes were made for. */
export function thumbnailKey(entry: FinderEntry): string {
	return `${entry.path}\u0000${entry.mtimeMs}`;
}

/** A file that still needs an OS icon; folders and already-resolved entries do not. */
export function needsThumbnail(entry: FinderEntry): boolean {
	return entry.kind === "file" && hasFileVersion(entry) && entry.iconUrl === undefined;
}
