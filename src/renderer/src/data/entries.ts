/**
 * The row model the Finder renders, plus adapters for its two sources: the
 * Electron fs bridge (OS-absolute paths, ISO stamps, byte sizes) and the
 * prototype fixtures (display-domain labels such as "14 msgs").
 */

import type { FsEntry, FsEntryEnrichment, FsSearchResult } from "../../../shared/fs-contract";
import { formatModified, formatSize, parseModifiedLabel, parseSizeLabel } from "../state/format";
import { type FileKind, kindFromExtension, kindMeta } from "../state/kinds";
import { basename, dirname, joinPath } from "../state/paths";
import type { SortableEntry } from "../state/sort";

export interface FinderEntry extends SortableEntry {
	readonly name: string;
	/** Full path; the selection, clipboard, and fs calls all key on this. */
	readonly path: string;
	readonly kind: "folder" | "file";
	readonly fileKind: FileKind;
	/** OS tile icon URL; null renders the extension letter tile. */
	readonly iconUrl: string | null;
	/** Exact filesystem mtime used to reject stale background enrichment. */
	readonly modifiedAt?: string;
	readonly createdAt?: string;
	readonly dateLabel: string;
	readonly sizeLabel: string;
}

function timestamp(value: string | null | undefined): number | undefined {
	if (value === null || value === undefined) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

type MetadataFields = {
	createdValue?: number;
	addedValue?: number;
	lastOpenedValue?: number;
	tagsLabel?: string;
	commentsLabel?: string;
	dimensionsLabel?: string;
	dimensionsValue?: number;
	ratingValue?: number;
	applicationLabel?: string;
};

function metadataFields(
	finder: FsEntry["finder"],
	fallbackCreated: string | undefined,
): MetadataFields {
	const fields: MetadataFields = {};
	const createdValue = timestamp(finder?.createdAt ?? fallbackCreated);
	if (createdValue !== undefined) fields.createdValue = createdValue;
	const addedValue = timestamp(finder?.addedAt);
	if (addedValue !== undefined) fields.addedValue = addedValue;
	const lastOpenedValue = timestamp(finder?.lastOpenedAt);
	if (lastOpenedValue !== undefined) fields.lastOpenedValue = lastOpenedValue;
	if (finder?.tags.length) fields.tagsLabel = finder.tags.join(", ");
	if (finder?.comments !== null && finder?.comments !== undefined) fields.commentsLabel = finder.comments;
	if (finder?.width !== null && finder?.height !== null && finder?.width !== undefined && finder?.height !== undefined) {
		fields.dimensionsLabel = `${finder.width} × ${finder.height}`;
		fields.dimensionsValue = finder.width * finder.height;
	}
	if (finder?.rating !== null && finder?.rating !== undefined) fields.ratingValue = finder.rating;
	if (finder?.application !== null && finder?.application !== undefined) fields.applicationLabel = finder.application;
	return fields;
}

function finderFields(entry: FsEntry): MetadataFields {
	return metadataFields(entry.finder, entry.createdAt);
}

export function entryFromFs(entry: FsEntry, location?: string): FinderEntry {
	const fileKind: FileKind = entry.kind === "folder" ? "folder" : kindFromExtension(entry.ext);
	return {
		name: entry.name,
		path: entry.path,
		kind: entry.kind,
		fileKind,
		iconUrl: entry.iconUrl,
		modifiedAt: entry.modifiedAt,
		...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
		dateLabel: formatModified(entry.modifiedAt),
		sizeLabel: formatSize(entry.kind === "folder" ? null : entry.size),
		// The OS-reported kind wins; the extension map is the fallback.
		kindLabel: entry.osKind ?? kindMeta(fileKind).label,
		location: location ?? dirname(entry.path),
		modifiedValue: Date.parse(entry.modifiedAt) || 0,
		sizeValue: entry.size ?? 0,
		...finderFields(entry),
	};
}

export function entryFromSearchHit(hit: FsSearchResult): FinderEntry {
	return { ...entryFromFs(hit.entry), location: dirname(hit.entry.path) };
}

export function applyEntryEnrichment(entries: readonly FinderEntry[], enriched: readonly FsEntryEnrichment[]): readonly FinderEntry[] {
	const byPath = new Map(enriched.map((entry) => [entry.path, entry]));
	let changed = false;
	const result = entries.map((entry) => {
		const patch = byPath.get(entry.path);
		if (patch === undefined || (entry.modifiedAt !== undefined && entry.modifiedAt !== patch.modifiedAt)) return entry;
		const finder = patch.finder;
		const {
			createdValue,
			addedValue,
			lastOpenedValue,
			tagsLabel,
			commentsLabel,
			dimensionsLabel,
			dimensionsValue,
			ratingValue,
			applicationLabel,
			...baseEntry
		} = entry;
		const next: FinderEntry = finder === undefined
			? { ...entry, kindLabel: patch.osKind ?? entry.kindLabel, iconUrl: patch.iconUrl }
			: {
					...baseEntry,
					kindLabel: patch.osKind ?? entry.kindLabel,
					iconUrl: patch.iconUrl,
					...metadataFields(finder, finder.createdAt ?? entry.createdAt),
				};
		if (
			 next.kindLabel !== entry.kindLabel || next.iconUrl !== entry.iconUrl ||
			next.createdValue !== entry.createdValue || next.addedValue !== entry.addedValue ||
			next.lastOpenedValue !== entry.lastOpenedValue || next.tagsLabel !== entry.tagsLabel ||
			next.commentsLabel !== entry.commentsLabel || next.dimensionsLabel !== entry.dimensionsLabel ||
			next.dimensionsValue !== entry.dimensionsValue || next.ratingValue !== entry.ratingValue ||
			next.applicationLabel !== entry.applicationLabel
		) changed = true;
		return next;
	});
	return changed ? result : entries;
}

/** A prototype fixture row: the reference's `F()` / `D()` shape. */
export interface FixtureItem {
	readonly name: string;
	readonly fileKind: FileKind;
	readonly dateLabel: string;
	readonly sizeLabel: string;
}

export function entryFromFixture(item: FixtureItem, location: string): FinderEntry {
	return {
		name: item.name,
		path: joinPath(location, item.name),
		kind: item.fileKind === "folder" ? "folder" : "file",
		fileKind: item.fileKind,
		iconUrl: null,
		dateLabel: item.dateLabel,
		sizeLabel: item.sizeLabel,
		kindLabel: kindMeta(item.fileKind).label,
		location,
		modifiedValue: parseModifiedLabel(item.dateLabel),
		sizeValue: parseSizeLabel(item.sizeLabel),
	};
}

export function fixtureFromEntry(entry: FinderEntry): FixtureItem {
	return {
		name: entry.name,
		fileKind: entry.fileKind,
		dateLabel: entry.dateLabel,
		sizeLabel: entry.sizeLabel,
	};
}

export function renameEntry(entry: FinderEntry, name: string): FinderEntry {
	return { ...entry, name, path: joinPath(entry.location, name) };
}

export function displayName(path: string): string {
	return basename(path);
}
