/**
 * The row model the Finder renders, plus adapters for its two sources: the
 * Electron fs bridge (OS-absolute paths, epoch-ms stamps, byte sizes) and the
 * prototype fixtures (display-domain labels such as "14 msgs").
 *
 * A row holds raw filesystem values only. Every label (date, size, kind,
 * location) is derived when a cell renders or a sort runs
 * (`state/entry-values`), so ingesting a 10,000-file folder formats nothing
 * and stores no string the listing did not already carry.
 */

import type { FsEntry, FsSearchResult } from "../../../shared/fs-contract";
import type { SortableEntry } from "../state/entry-values";
import { parseModifiedLabel, parseSizeLabel } from "../state/format";
import type { FileKind } from "../state/kinds";
import { joinPath } from "../state/paths";

export interface FinderEntry extends SortableEntry {
	/** OS tile icon URL, once the entry sidecar resolved the row; absent renders the letter tile. */
	readonly iconUrl?: string;
}

/** Extensions are few; one shared string per distinct value instead of one per row. */
const EXTENSIONS = new Map<string, string>();

function internExtension(ext: string): string {
	if (ext === "") return "";
	const known = EXTENSIONS.get(ext);
	if (known !== undefined) return known;
	if (EXTENSIONS.size < 4096) EXTENSIONS.set(ext, ext);
	return ext;
}

/**
 * The bridge's record as a row. A fresh object with one fixed shape (the IPC
 * copy is garbage right after): `kind` and `ext` point at shared strings, and
 * `flags` stays behind because no view reads it.
 */
export function entryFromFs(entry: FsEntry): FinderEntry {
	return {
		name: entry.name,
		path: entry.path,
		kind: entry.kind === "folder" ? "folder" : "file",
		ext: internExtension(entry.ext),
		size: entry.size,
		mtimeMs: entry.mtimeMs,
		birthtimeMs: entry.birthtimeMs ?? 0,
	};
}

export function entryFromSearchHit(hit: FsSearchResult): FinderEntry {
	return entryFromFs(hit.entry);
}

/**
 * True for a row backed by a real file version the OS can enrich (kind, icon,
 * metadata, preview); prototype fixture rows have none.
 */
export function hasFileVersion(entry: FinderEntry): boolean {
	return entry.fixture === undefined;
}

/** A prototype fixture row: the reference's `F()` / `D()` shape. */
export interface FixtureItem {
	readonly name: string;
	readonly fileKind: FileKind;
	readonly dateLabel: string;
	readonly sizeLabel: string;
}

function fixtureExtension(item: FixtureItem): string {
	if (item.fileKind === "folder") return "";
	const dot = item.name.lastIndexOf(".");
	return dot <= 0 ? "" : item.name.slice(dot + 1).toLowerCase();
}

export function entryFromFixture(item: FixtureItem, location: string): FinderEntry {
	const folder = item.fileKind === "folder";
	return {
		name: item.name,
		path: joinPath(location, item.name),
		kind: folder ? "folder" : "file",
		ext: fixtureExtension(item),
		// The labels are the display truth; these only order and total the rows.
		size: folder ? null : parseSizeLabel(item.sizeLabel),
		mtimeMs: parseModifiedLabel(item.dateLabel),
		birthtimeMs: 0,
		fixture: { fileKind: item.fileKind, dateLabel: item.dateLabel, sizeLabel: item.sizeLabel },
	};
}
