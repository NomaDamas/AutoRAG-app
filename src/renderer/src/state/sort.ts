/**
 * Sorting for the Finder — the toolbar Sort menu (issue #47) and the list
 * column headers drive the same state, so both stay in sync.
 *
 * Reference: handoff README §2 "Column header" — first click ascending (Date
 * and Size start descending), second flips, third clears. Folders rank by the
 * same key as files (a folder has size 0), an unparseable stamp or size counts
 * as 0 (the minimum), and Name compares with the Korean locale.
 */

import {
	addedMsOf,
	applicationOf,
	commentsTextOf,
	createdMsOf,
	dimensionsAreaOf,
	kindLabelOf,
	lastOpenedMsOf,
	locationOf,
	ratingOf,
	type SortableEntry,
	sizeOf,
	tagsTextOf,
} from "./entry-values";

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

const collator = new Intl.Collator("ko", { numeric: true });

/** An unparseable stamp or size (NaN) ranks as 0, the minimum of its column. */
function orZero(value: number | undefined): number {
	return value !== undefined && Number.isFinite(value) ? value : 0;
}

/** The name's own suffix, case kept, so "a.TXT" and "a.txt" order the way Finder does. */
function extensionText(entry: SortableEntry): string {
	if (entry.kind === "folder") return "";
	const dot = entry.name.lastIndexOf(".");
	return dot > 0 ? entry.name.slice(dot + 1) : "";
}

/**
 * How one criterion orders rows: the key each row sorts by, whether it is
 * text (collator) or a number, and whether equal keys fall back to the name.
 */
type SortSpec =
	| { readonly text: true; readonly key: (entry: SortableEntry) => string; readonly thenByName: boolean }
	| { readonly text: false; readonly key: (entry: SortableEntry) => number; readonly thenByName: false };

const text = (key: (entry: SortableEntry) => string | undefined, thenByName = false): SortSpec => ({
	text: true,
	key: (entry) => key(entry) ?? "",
	thenByName,
});
const numeric = (key: (entry: SortableEntry) => number | undefined): SortSpec => ({
	text: false,
	key: (entry) => orZero(key(entry)),
	thenByName: false,
});

const SPECS: Record<SortKey, SortSpec> = {
	name: text((entry) => entry.name),
	kind: text(kindLabelOf, true),
	application: text(applicationOf, true),
	extension: text(extensionText),
	dateCreated: numeric(createdMsOf),
	date: numeric((entry) => entry.mtimeMs),
	dateAdded: numeric(addedMsOf),
	dateLastOpened: numeric(lastOpenedMsOf),
	size: numeric(sizeOf),
	tags: text(tagsTextOf),
	comments: text(commentsTextOf),
	dimensions: numeric(dimensionsAreaOf),
	rating: numeric(ratingOf),
	where: text(locationOf, true),
};

/**
 * Rows ordered by `sort`, stable for equal keys. Labels are derived, not
 * stored, so each row's key is computed once up front and the comparator only
 * compares (10,000 rows: one derivation each instead of one per comparison).
 */
export function sortEntries<T extends SortableEntry>(entries: readonly T[], sort: SortState | null): T[] {
	if (sort === null) {
		return [...entries];
	}
	const spec = SPECS[sort.key];
	const dir = sort.dir;
	const order = entries.map((_, index) => index);
	if (spec.text) {
		const keys = entries.map(spec.key);
		order.sort((a, b) => {
			const compared = collator.compare(keys[a] ?? "", keys[b] ?? "") || (spec.thenByName ? collator.compare(entries[a]?.name ?? "", entries[b]?.name ?? "") : 0);
			return compared * dir;
		});
	} else {
		const keys = Float64Array.from(entries, spec.key);
		order.sort((a, b) => ((keys[a] ?? 0) - (keys[b] ?? 0)) * dir);
	}
	return order.map((index) => entries[index] as T);
}