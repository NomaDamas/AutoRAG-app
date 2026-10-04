/**
 * Finder-style grouping (issue #47): the toolbar Group control splits the
 * sorted rows into visual sections inside the Finder pane. Grouping never
 * creates folders or changes entry identity — it only adds section chrome —
 * and the sort chosen in the Sort control (or a column header) stays the
 * within-section order.
 *
 * This module also owns the shared geometry the virtualized views and the
 * controller's scroll math need: `groupedLayout` flattens sections into
 * header/row items with pixel offsets, `groupedWindow` windows them, and
 * `groupedRowTop` maps a flattened row index to its content-space top.
 */

import { ROW_HEIGHT } from "./selection";
import type { SortableEntry } from "./sort";
import type { StackRow } from "./version-family";

/** Finder grouping criteria exposed by the toolbar Group menu. */
export type GroupKey =
	| "none"
	| "name"
	| "kind"
	| "extension"
	| "application"
	| "dateCreated"
	| "date"
	| "dateAdded"
	| "dateLastOpened"
	| "size"
	| "tags"
	| "comments"
	| "dimensions"
	| "rating";

export const GROUP_OPTIONS: readonly { readonly key: GroupKey; readonly label: string }[] = [
	{ key: "none", label: "None" },
	{ key: "name", label: "Name" },
	{ key: "kind", label: "Kind" },
	{ key: "application", label: "Application" },
	{ key: "extension", label: "Extension" },
	{ key: "dateCreated", label: "Date Created" },
	{ key: "date", label: "Date Modified" },
	{ key: "dateAdded", label: "Date Added" },
	{ key: "dateLastOpened", label: "Date Last Opened" },
	{ key: "size", label: "Size" },
	{ key: "tags", label: "Tags" },
	{ key: "comments", label: "Comments" },
	{ key: "dimensions", label: "Dimensions" },
	{ key: "rating", label: "Rating" },
];

/** localStorage key that remembers the last grouping across launches. */
export const GROUP_STORAGE_KEY = "autorag.finder.grouping";
export const DEFAULT_GROUP_KEY: GroupKey = "none";

export function parseGroupKey(value: string | null): GroupKey {
	return GROUP_OPTIONS.find((option) => option.key === value)?.key ?? DEFAULT_GROUP_KEY;
}

export function groupLabel(key: GroupKey): string {
	return GROUP_OPTIONS.find((option) => option.key === key)?.label ?? "None";
}

/** One visual section: a Finder-style header label plus the rows under it. */
export interface GroupSection<T> {
	readonly label: string | null;
	readonly rows: readonly T[];
}

const collator = new Intl.Collator("ko", { numeric: true });
const DAY_MS = 24 * 60 * 60 * 1000;

/** One group's identity: display label plus its section sort order. */
interface GroupValue {
	readonly id: string;
	readonly label: string;
	/**
	 * Numeric orders sort ascending; dates use the negated bucket start so the
	 * newest bucket comes first and an unknown stamp sorts last.
	 */
	readonly order: number;
	/** Text orders compare with the collator instead of numerically. */
	readonly text: string | null;
}

function startOfDay(value: number): number {
	const date = new Date(value);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

/** Finder's relative date buckets: Today, Yesterday, Previous 7/30 Days, then months. */
function dateGroupValue(value: number, now: number): GroupValue {
	if (!Number.isFinite(value) || value <= 0) {
		return { id: "unknown", label: "Unknown Date", order: Number.MAX_SAFE_INTEGER, text: null };
	}
	const today = startOfDay(now);
	const diffDays = Math.round((today - startOfDay(value)) / DAY_MS);
	if (diffDays <= 0) return { id: "today", label: "Today", order: -today, text: null };
	if (diffDays === 1) return { id: "yesterday", label: "Yesterday", order: -(today - DAY_MS), text: null };
	if (diffDays <= 7) return { id: "prev7", label: "Previous 7 Days", order: -(today - 7 * DAY_MS), text: null };
	if (diffDays <= 30) return { id: "prev30", label: "Previous 30 Days", order: -(today - 30 * DAY_MS), text: null };
	const date = new Date(value);
	const label = new Intl.DateTimeFormat("en", { year: "numeric", month: "long" }).format(date);
	const monthStart = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
	return { id: `month-${label}`, label, order: -monthStart, text: null };
}

function extensionLabel(entry: SortableEntry): string {
	if (entry.kind === "folder") return "Folder";
	const dot = entry.name.lastIndexOf(".");
	return dot > 0 && dot < entry.name.length - 1 ? `${entry.name.slice(dot + 1)}`.toUpperCase() : "No Extension";
}

/** Finder's size bands; zero-byte entries (folders included) share Zero KB. */
function sizeGroupValue(value: number): GroupValue {
	const size = Number.isFinite(value) && value > 0 ? value : 0;
	if (size === 0) return { id: "zero", label: "Zero KB", order: 0, text: null };
	if (size < 1024) return { id: "sub-kb", label: "Under 1 KB", order: 1, text: null };
	if (size < 1024 * 1024) return { id: "kb", label: "1 KB – 1 MB", order: 2, text: null };
	if (size < 1024 * 1024 * 1024) return { id: "mb", label: "1 MB – 1 GB", order: 3, text: null };
	return { id: "gb", label: "Over 1 GB", order: 4, text: null };
}

function textValue(label: string): GroupValue {
	return { id: label, label, order: 0, text: label };
}

function ratingValue(value: number | undefined): GroupValue {
	const rating = value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
	return rating === 0
		? { id: "unrated", label: "No Rating", order: -1, text: null }
		: { id: `stars-${rating}`, label: `${rating} Star${rating === 1 ? "" : "s"}`, order: rating, text: null };
}

function groupValue(entry: SortableEntry, key: Exclude<GroupKey, "none">, now: number): GroupValue {
	switch (key) {
		case "name": {
			const first = [...entry.name.trim()][0];
			const label = first === undefined ? "#" : first.toLocaleUpperCase("ko");
			return textValue(label);
		}
		case "kind":
			return textValue(entry.kindLabel);
		case "extension":
			return textValue(extensionLabel(entry));
		case "application":
			return textValue(entry.applicationLabel ?? "No Application");
		case "dateCreated":
			return dateGroupValue(entry.createdValue ?? 0, now);
		case "date":
			return dateGroupValue(entry.modifiedValue, now);
		case "dateAdded":
			return dateGroupValue(entry.addedValue ?? 0, now);
		case "dateLastOpened":
			return dateGroupValue(entry.lastOpenedValue ?? 0, now);
		case "size":
			return sizeGroupValue(entry.sizeValue);
		case "tags":
			return textValue(entry.tagsLabel ?? "No Tags");
		case "comments":
			return textValue(entry.commentsLabel ?? "No Comments");
		case "dimensions":
			return textValue(entry.dimensionsLabel ?? "No Dimensions");
		case "rating":
			return ratingValue(entry.ratingValue);
	}
}

function orderBySectionValue(a: GroupValue, b: GroupValue): number {
	if (a.text !== null && b.text !== null) return collator.compare(a.text, b.text);
	if (a.order !== b.order) return a.order - b.order;
	return collator.compare(a.label, b.label);
}

interface SectionCollector<T> {
	readonly value: GroupValue;
	readonly rows: T[];
}

/** Split already-sorted rows into sections; input order is preserved inside each. */
function collectSections<T>(
	items: readonly T[],
	entryOf: (item: T) => SortableEntry,
	attachedToPrevious: (item: T) => boolean,
	key: GroupKey,
	now: number,
): readonly GroupSection<T>[] {
	if (key === "none") return [{ label: null, rows: [...items] }];
	const byId = new Map<string, SectionCollector<T>>();
	const order: SectionCollector<T>[] = [];
	let current: SectionCollector<T> | null = null;
	for (const item of items) {
		// A version-stack child rides inside its head's section.
		if (current !== null && attachedToPrevious(item)) {
			current.rows.push(item);
			continue;
		}
		const value = groupValue(entryOf(item), key, now);
		let section = byId.get(value.id);
		if (section === undefined) {
			section = { value, rows: [] };
			byId.set(value.id, section);
			order.push(section);
		}
		section.rows.push(item);
		current = section;
	}
	return order
		.slice()
		.sort((a, b) => orderBySectionValue(a.value, b.value))
		.map((section) => ({ label: section.value.label, rows: section.rows }));
}

/** Group plain sortable entries (column panes and other flat lists). */
export function groupEntries<T extends SortableEntry>(
	entries: readonly T[],
	key: GroupKey,
	now: number = Date.now(),
): readonly GroupSection<T>[] {
	return collectSections(entries, (entry) => entry, () => false, key, now);
}

/** Group version-stack rows; an open stack's member rows stay with their head. */
export function groupRows<T extends StackRow>(
	rows: readonly T[],
	key: GroupKey,
	now: number = Date.now(),
): readonly GroupSection<T>[] {
	return collectSections(rows, (row) => row.entry, (row) => row.child, key, now);
}

/* ----------------------------------------------------------- virtualized layout */

/** Height of one group header block, shared by the views and the scroll math. */
export const GROUP_HEADER_HEIGHT = 40;

/** One layout block: a section header or a run of rows (one list row, or one tile-row of `count`). */
export interface LayoutItem {
	readonly kind: "header" | "rows";
	readonly section: number;
	/** First row index inside the section this block covers. */
	readonly start: number;
	/** Rows covered: 1 in list mode, up to the grid's column count in icon mode. */
	readonly count: number;
}

export interface GroupedLayout {
	readonly items: readonly LayoutItem[];
	/** `offsets[i]` is item i's content-space top; the last entry is the total height. */
	readonly offsets: readonly number[];
	/** `rowBases[i]` is the flattened row index item i starts at (0 for headers). */
	readonly rowBases: readonly number[];
	readonly total: number;
}

export function groupedLayout(
	sections: readonly { readonly label: string | null; readonly rows: number }[],
	options: { readonly columns: number; readonly rowStride: number; readonly headerStride: number; readonly rowGap?: number },
): GroupedLayout {
	const columns = Math.max(1, Math.floor(options.columns));
	// A grid block's last tile-row carries no trailing gap (CSS `gap` only sits
	// *between* rows), so only that row advances by the bare height. Skipping
	// the gap on every row would grow the content by one gap per section and
	// drift the virtualized offsets away from what the DOM actually renders.
	const rowTail = Math.max(0, options.rowStride - Math.max(0, options.rowGap ?? 0));
	const items: LayoutItem[] = [];
	const offsets: number[] = [0];
	const rowBases: number[] = [];
	let top = 0;
	let rowBase = 0;
	sections.forEach((section, sectionIndex) => {
		if (section.label !== null) {
			items.push({ kind: "header", section: sectionIndex, start: 0, count: 0 });
			rowBases.push(rowBase);
			top += options.headerStride;
			offsets.push(top);
		}
		for (let start = 0; start < section.rows; start += columns) {
			const count = Math.min(columns, section.rows - start);
			// Only a rendered group block drops its trailing gap; the headerless
			// section (grouping off) keeps the pre-group geometry untouched.
			const lastRow = section.label !== null && start + count >= section.rows;
			items.push({ kind: "rows", section: sectionIndex, start, count });
			rowBases.push(rowBase);
			rowBase += count;
			top += lastRow ? rowTail : options.rowStride;
			offsets.push(top);
		}
	});
	return { items, offsets, rowBases, total: top };
}

export interface GroupedWindowInput {
	readonly offset: number;
	readonly viewport: number;
	readonly overscan: number;
	/** Flattened row index that must be rendered even when scrolled away. */
	readonly includeRow?: number | undefined;
}

export interface GroupedWindow {
	/** First rendered layout item (inclusive). */
	readonly start: number;
	/** One past the last rendered layout item. */
	readonly end: number;
}

/**
 * Layout items intersecting the viewport, widened by `overscan`. `includeRow`
 * is a flattened row index that must render even when scrolled away (the
 * keyboard/reveal target); when it lands outside the window the window moves
 * to cover it, mirroring `state/virtual.linearWindow`.
 */
export function groupedWindow(layout: GroupedLayout, input: GroupedWindowInput): GroupedWindow {
	const count = layout.items.length;
	if (count === 0) return { start: 0, end: 0 };
	const viewport = Math.max(0, input.viewport);
	const offset = Math.max(0, Math.min(Math.max(0, input.offset), Math.max(0, layout.total - viewport)));
	let start = 0;
	while (start < count) {
		const bottom = layout.offsets[start + 1];
		if (bottom === undefined || bottom > offset) break;
		start += 1;
	}
	let end = start;
	while (end < count) {
		const top = layout.offsets[end];
		if (top === undefined || top >= offset + viewport) break;
		end += 1;
	}
	const overscan = Math.max(0, Math.floor(input.overscan));
	if (input.includeRow !== undefined && Number.isFinite(input.includeRow)) {
		const includeRow = Math.floor(input.includeRow);
		const item = layout.items.findIndex((candidate, index) => {
			if (candidate.kind !== "rows") return false;
			const base = layout.rowBases[index];
			return base !== undefined && includeRow >= base && includeRow < base + candidate.count;
		});
		if (item >= 0 && (item < start || item >= end)) {
			return { start: Math.max(0, item - overscan), end: Math.min(count, item + 1 + overscan) };
		}
	}
	return { start: Math.max(0, start - overscan), end: Math.min(count, end + overscan) };
}

/**
 * Content-space top of the flattened row `rowIndex` in list geometry (row
 * height 24, header block 40). The controller scrolls the list to this top
 * minus the keyboard lead.
 */
export function groupedRowTop(sections: readonly GroupSection<unknown>[], rowIndex: number): number {
	if (rowIndex < 0) return 0;
	let total = 0;
	for (const section of sections) total += section.rows.length;
	let index = Math.min(rowIndex, total);
	let top = 0;
	for (const section of sections) {
		if (section.label !== null) top += GROUP_HEADER_HEIGHT;
		if (index < section.rows.length) return top + index * ROW_HEIGHT;
		top += section.rows.length * ROW_HEIGHT;
		index -= section.rows.length;
	}
	return top;
}