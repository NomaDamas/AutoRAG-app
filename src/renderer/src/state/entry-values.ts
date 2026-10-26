/**
 * What the Finder derives from a row at the moment it needs it — a sort, a
 * group, a rendered cell — instead of storing it on every row when a folder
 * is listed.
 *
 * A row holds the filesystem's plain values (name, path, kind, extension,
 * bytes, epoch-ms stamps), exactly as `fs:listDir` delivered them. The OS kind,
 * tile icon, and Finder metadata join a row only when the entry sidecar
 * resolves it (`osKind`, `iconUrl`, `finder`). Everything below reads those
 * fields and falls back the way the old listing-time copies did, so the
 * strings on screen are unchanged.
 */

import type { FsFinderMetadata } from "../../../shared/fs-contract";
import { t } from "../../../shared/i18n/core";
import { formatModified, formatSize } from "./format";
import { type FileKind, isKnownExtension, kindFromExtension, kindMeta } from "./kinds";
import { dirname } from "./paths";

/**
 * Display-domain labels of a prototype fixture row ("14 msgs", "Slack
 * Thread"): the fixture source has no real file behind them. Real rows never
 * carry this field.
 */
export interface FixtureLabels {
	readonly fileKind: FileKind;
	readonly dateLabel: string;
	readonly sizeLabel: string;
}

/** The row fields sorting, grouping, and the labels read. */
export interface SortableEntry {
	readonly name: string;
	/** Full path; the parent folder (`locationOf`) is derived from it. */
	readonly path: string;
	readonly kind: "folder" | "file";
	/** Lowercase extension without the dot; "" for folders and extensionless files. */
	readonly ext: string;
	/** Bytes; null for folders. */
	readonly size: number | null;
	/** Modification time, epoch ms; with `path`, the file version enrichment is keyed by. */
	readonly mtimeMs: number;
	/** Filesystem birth time, epoch ms; 0 when the filesystem exposes none. */
	readonly birthtimeMs: number;
	/** The kind the OS reports; set once the sidecar resolved the row. */
	readonly osKind?: string;
	/** Finder metadata; set once the sidecar resolved the row and the platform had some. */
	readonly finder?: FsFinderMetadata;
	/** Prototype fixture rows only. */
	readonly fixture?: FixtureLabels;
}

export function fileKindOf(entry: SortableEntry): FileKind {
	if (entry.fixture !== undefined) return entry.fixture.fileKind;
	return entry.kind === "folder" ? "folder" : kindFromExtension(entry.ext);
}

/** Finder's Kind column: the OS-reported kind wins; the extension map is the fallback, then "<EXT> File". */
export function kindLabelOf(entry: SortableEntry): string {
	if (entry.osKind !== undefined) return entry.osKind;
	// An extension the map does not know (.json, .py on a PC whose registry has no name for it) would read "Markdown".
	if (entry.fixture === undefined && entry.kind !== "folder" && entry.ext !== "" && !isKnownExtension(entry.ext)) return t("finderState.kindByExtension", { ext: entry.ext.toUpperCase() });
	return kindMeta(fileKindOf(entry)).label;
}

/** The Date Modified cell, e.g. "Sep 13, 16:48". */
export function dateLabelOf(entry: SortableEntry): string {
	return entry.fixture?.dateLabel ?? formatModified(entry.mtimeMs);
}

/** The Size cell, e.g. "84 KB"; folders show an em dash. */
export function sizeLabelOf(entry: SortableEntry): string {
	return entry.fixture?.sizeLabel ?? formatSize(entry.kind === "folder" ? null : entry.size);
}

/** Bytes for sorting and totals; folders and unknown sizes are 0. */
export function sizeOf(entry: SortableEntry): number {
	return entry.size ?? 0;
}

/** The folder that holds the row (the "Where" column, version-stack chips). */
export function locationOf(entry: Pick<SortableEntry, "path">): string {
	return dirname(entry.path);
}

function timestamp(value: string | null | undefined): number | undefined {
	if (value === null || value === undefined) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** Date Created: Spotlight's creation date, else the filesystem birth time. */
export function createdMsOf(entry: SortableEntry): number | undefined {
	return timestamp(entry.finder?.createdAt) ?? (entry.birthtimeMs > 0 ? entry.birthtimeMs : undefined);
}

export function addedMsOf(entry: SortableEntry): number | undefined {
	return timestamp(entry.finder?.addedAt);
}

export function lastOpenedMsOf(entry: SortableEntry): number | undefined {
	return timestamp(entry.finder?.lastOpenedAt);
}

export function tagsTextOf(entry: SortableEntry): string | undefined {
	const tags = entry.finder?.tags;
	return tags === undefined || tags.length === 0 ? undefined : tags.join(", ");
}

export function commentsTextOf(entry: SortableEntry): string | undefined {
	return entry.finder?.comments ?? undefined;
}

export function applicationOf(entry: SortableEntry): string | undefined {
	return entry.finder?.application ?? undefined;
}

export function ratingOf(entry: SortableEntry): number | undefined {
	return entry.finder?.rating ?? undefined;
}

/** Pixel area, for ordering by Dimensions. */
export function dimensionsAreaOf(entry: SortableEntry): number | undefined {
	const width = entry.finder?.width;
	const height = entry.finder?.height;
	return width == null || height == null ? undefined : width * height;
}

/** "4032 × 3024", for grouping by Dimensions. */
export function dimensionsTextOf(entry: SortableEntry): string | undefined {
	const width = entry.finder?.width;
	const height = entry.finder?.height;
	return width == null || height == null ? undefined : `${width} × ${height}`;
}
