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

/**
 * An archive's top level, Finder-folder-style: entries are grouped under their
 * first path segment, dot entries and macOS's `__MACOSX` resource forks are
 * hidden, and a child is as new as the newest thing inside it. Children the
 * container gave no date keep their archive order after the dated ones.
 */
export function summarizeArchive(entries: readonly ArchiveEntry[], limit: number): ArchiveSummary {
	const tops = new Map<string, { folder: boolean; modified: number }>();
	for (const entry of entries) {
		const parts = entry.name.replace(/\\/g, "/").replace(/^(\.?\/)+/, "").split("/").filter((part) => part !== "");
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
