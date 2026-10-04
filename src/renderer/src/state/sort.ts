/**
 * Sorting for the Finder — the toolbar Sort menu (issue #47) and the list
 * column headers drive the same state, so both stay in sync.
 *
 * Reference: handoff README §2 "Column header" — first click ascending (Date
 * and Size start descending), second flips, third clears. Folders rank by the
 * same key as files (a folder has size 0), an unparseable stamp or size counts
 * as 0 (the minimum), and Name compares with the Korean locale.
 */

export type SortKey =
	| "name"
	| "kind"
	| "application"
	| "extension"
	| "dateCreated"
	| "date"
	| "dateAdded"
	| "dateLastOpened"
	| "size"
	| "tags"
	| "comments"
	| "dimensions"
	| "rating"
	| "where";
export type SortDirection = 1 | -1;

export interface SortState {
	readonly key: SortKey;
	readonly dir: SortDirection;
	/** True once the direction has been flipped, i.e. the next click clears. */
	readonly flipped: boolean;
}

/** Every criterion the toolbar Sort menu offers (Finder's Sort By list). */
export const SORT_OPTIONS: readonly { readonly key: SortKey; readonly label: string }[] = [
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
	{ key: "where", label: "Relative Path" },
];

/** Columns whose first click sorts descending. */
const DESCENDING_FIRST: readonly SortKey[] = ["dateCreated", "date", "dateAdded", "dateLastOpened", "size", "rating"];

/**
 * The list columns that expose a sort button, and the key each one cycles —
 * Name included, matching the v7 reference (`c.key === 'name' || 'date' ||
 * 'size' || 'kind'`). Any column absent here renders a static label.
 */
export const SORT_KEY_BY_COLUMN: Readonly<Record<string, SortKey>> = {
	name: "name",
	date: "date",
	size: "size",
	kind: "kind",
};

export function cycleSort(current: SortState | null, key: SortKey): SortState | null {
	if (current !== null && current.key === key) {
		return current.flipped ? null : { key, dir: current.dir === 1 ? -1 : 1, flipped: true };
	}
	return { key, dir: DESCENDING_FIRST.includes(key) ? -1 : 1, flipped: false };
}

/** The toolbar Sort menu's explicit choice: a key plus a direction. */
export function explicitSort(key: SortKey, dir: SortDirection): SortState {
	return { key, dir, flipped: dir === (DESCENDING_FIRST.includes(key) ? 1 : -1) };
}

export interface SortableEntry {
	readonly name: string;
	readonly kind: "folder" | "file";
	/** Sortable modification stamp; see state/format.parseModifiedLabel. */
	readonly modifiedValue: number;
	/** Sortable size in bytes; folders and unstatable entries are 0. */
	readonly sizeValue: number;
	readonly kindLabel: string;
	/** Parent location, shown in the "Where" column while searching. */
	readonly location: string;
	/** Finder metadata populated by the native enrichment pass. */
	readonly createdValue?: number;
	readonly addedValue?: number;
	readonly lastOpenedValue?: number;
	readonly tagsLabel?: string;
	readonly commentsLabel?: string;
	readonly dimensionsLabel?: string;
	readonly dimensionsValue?: number;
	readonly ratingValue?: number;
	readonly applicationLabel?: string;
}

const collator = new Intl.Collator("ko", { numeric: true });

/** An unparseable stamp or size (NaN) ranks as 0, the minimum of its column. */
function orZero(value: number | undefined): number {
	return value !== undefined && Number.isFinite(value) ? value : 0;
}

function extensionOf(entry: SortableEntry): string {
	if (entry.kind === "folder") return "";
	const dot = entry.name.lastIndexOf(".");
	return dot > 0 ? entry.name.slice(dot + 1) : "";
}

function textOf(value: string | undefined): string {
	return value ?? "";
}

function byName(a: SortableEntry, b: SortableEntry): number {
	return collator.compare(a.name, b.name);
}

const COMPARATORS: Record<SortKey, (a: SortableEntry, b: SortableEntry) => number> = {
	name: byName,
	kind: (a, b) => collator.compare(a.kindLabel, b.kindLabel) || byName(a, b),
	application: (a, b) => collator.compare(textOf(a.applicationLabel), textOf(b.applicationLabel)) || byName(a, b),
	extension: (a, b) => collator.compare(extensionOf(a), extensionOf(b)),
	dateCreated: (a, b) => orZero(a.createdValue) - orZero(b.createdValue),
	date: (a, b) => orZero(a.modifiedValue) - orZero(b.modifiedValue),
	dateAdded: (a, b) => orZero(a.addedValue) - orZero(b.addedValue),
	dateLastOpened: (a, b) => orZero(a.lastOpenedValue) - orZero(b.lastOpenedValue),
	size: (a, b) => orZero(a.sizeValue) - orZero(b.sizeValue),
	tags: (a, b) => collator.compare(textOf(a.tagsLabel), textOf(b.tagsLabel)),
	comments: (a, b) => collator.compare(textOf(a.commentsLabel), textOf(b.commentsLabel)),
	dimensions: (a, b) => orZero(a.dimensionsValue) - orZero(b.dimensionsValue),
	rating: (a, b) => orZero(a.ratingValue) - orZero(b.ratingValue),
	where: (a, b) => collator.compare(a.location, b.location) || byName(a, b),
};

export function sortEntries<T extends SortableEntry>(entries: readonly T[], sort: SortState | null): T[] {
	if (sort === null) {
		return [...entries];
	}
	const compare = COMPARATORS[sort.key];
	return [...entries].sort((a, b) => compare(a, b) * sort.dir);
}