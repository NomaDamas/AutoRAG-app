import { extensionOf } from "./format";

/** One path inside an archive, whatever the container (ZIP, tar). A directory entry ends in "/". */
export interface ArchiveEntry {
	readonly name: string;
	readonly size: number;
	/** ms since the epoch; null when the container stored no usable date. */
	readonly modified: number | null;
}

/** One top-level child of an archive, shaped like a folder preview's item. */
export interface ArchiveItem {
	readonly name: string;
	readonly folder: boolean;
	readonly ext: string;
}

export interface ArchiveSummary {
	/** Visible top-level children, the way a folder preview counts its direct children. */
	readonly itemCount: number;
	/** The `limit` most recently modified of them, newest first. */
	readonly items: readonly ArchiveItem[];
}

/** An entry name's non-empty path segments, with the `./` prefix and Windows backslashes a tool may have written normalized away. */
function segmentsOf(name: string): string[] {
	return name.replace(/\\/g, "/").replace(/^(\.?\/)+/, "").split("/").filter((part) => part !== "");
}

/**
 * An archive's top level, Finder-folder-style: entries are grouped under their
 * first path segment, dot entries and macOS's `__MACOSX` resource forks are
 * hidden, and a child is as new as the newest thing inside it. Children the
 * container gave no date keep their archive order after the dated ones.
 */
export function summarizeArchive(entries: readonly ArchiveEntry[], limit: number): ArchiveSummary {
	const tops = new Map<string, { folder: boolean; modified: number }>();
	for (const entry of entries) {
		const parts = segmentsOf(entry.name);
		const head = parts[0];
		if (head === undefined || head.startsWith(".") || head === "__MACOSX") continue;
		const folder = parts.length > 1 || entry.name.endsWith("/");
		const modified = entry.modified ?? 0;
		const seen = tops.get(head);
		if (seen === undefined) {
			tops.set(head, { folder, modified });
		} else {
			seen.folder ||= folder;
			seen.modified = Math.max(seen.modified, modified);
		}
	}
	const items = [...tops]
		.sort((left, right) => right[1].modified - left[1].modified)
		.slice(0, limit)
		.map(([name, top]) => ({ name, folder: top.folder, ext: top.folder ? "" : extensionOf(name) }));
	return { itemCount: tops.size, items };
}

/**
 * One entry per top-level child of `entries`: a folder is `name/` carrying the
 * summed size and newest date of what it holds. {@link summarizeArchive} of the
 * result equals that of the full list, so a listing of a hundred thousand
 * entries crosses the process boundary as a handful.
 */
export function collapseToTopLevel(entries: readonly ArchiveEntry[]): ArchiveEntry[] {
	const tops = new Map<string, { folder: boolean; size: number; modified: number | null }>();
	for (const entry of entries) {
		const parts = segmentsOf(entry.name);
		const head = parts[0];
		if (head === undefined) continue;
		const folder = parts.length > 1 || entry.name.endsWith("/");
		const seen = tops.get(head);
		if (seen === undefined) {
			tops.set(head, { folder, size: entry.size, modified: entry.modified });
			continue;
		}
		seen.folder ||= folder;
		seen.size += entry.size;
		if (entry.modified !== null && (seen.modified === null || entry.modified > seen.modified)) seen.modified = entry.modified;
	}
	return [...tops].map(([name, top]) => ({ name: top.folder ? `${name}/` : name, size: top.size, modified: top.modified }));
}
