/**
 * Finder tags in the renderer: which colour a tag is drawn in, which dots a row
 * carries, and which tags a selection shares. The colours themselves are the
 * `--tag-*` tokens; nothing here names a literal colour.
 */

import type { FsFinderMetadata, FsTag, FsTagCatalog, FsTagColor } from "../../../shared/fs-contract";

/** Finder's colour dots in its menu: red, orange, yellow, green, blue, purple, gray. */
export const TAG_MENU_COLORS: readonly FsTagColor[] = [6, 7, 5, 2, 4, 3, 1];

/** The `tokens.css` custom property of each coloured label; 0 (no colour) has none. */
export const TAG_COLOR_TOKEN: Readonly<Record<FsTagColor, string | null>> = {
	0: null,
	1: "--tag-gray",
	2: "--tag-green",
	3: "--tag-purple",
	4: "--tag-blue",
	5: "--tag-yellow",
	6: "--tag-red",
	7: "--tag-orange",
};

/** Tag name (lower-case) → the colour Finder's registry draws it in. */
export type TagColors = ReadonlyMap<string, FsTagColor>;

export const NO_TAG_COLORS: TagColors = new Map();

export function tagKey(name: string): string {
	return name.trim().toLowerCase();
}

/** The registry's colours, including the standard colour tags under the OS's own names. */
export function tagColorsOf(catalog: FsTagCatalog): TagColors {
	if (!catalog.supported) return NO_TAG_COLORS;
	const colors = new Map<string, FsTagColor>();
	for (const tag of catalog.tags) colors.set(tagKey(tag.name), tag.color);
	return colors;
}

export interface TagDot {
	readonly name: string;
	readonly color: FsTagColor;
}

/**
 * The dots one row draws, in the order Finder lists the file's tags. The
 * registry's colour wins: a tag recoloured in Finder keeps its old colour on
 * the files that already carried it. A tag the registry does not know falls
 * back to the colour its file stored.
 */
export function tagDotsOf(finder: FsFinderMetadata | undefined, colors: TagColors): readonly TagDot[] {
	if (finder === undefined || finder.tags.length === 0) return [];
	return finder.tags.map((name, index) => ({ name, color: colors.get(tagKey(name)) ?? finder.tagColors?.[index] ?? 0 }));
}

/** Tags that every one of `rows` carries (lower-case names): what the menu shows ticked. */
export function sharedTags(rows: readonly (FsFinderMetadata | undefined)[]): ReadonlySet<string> {
	if (rows.length === 0) return new Set();
	const [first, ...rest] = rows.map((finder) => new Set((finder?.tags ?? []).map(tagKey)));
	const shared = new Set(first);
	for (const names of rest) for (const name of shared) if (!names.has(name)) shared.delete(name);
	return shared;
}

/** The tags the sidebar lists: the ones Finder lists in its own sidebar, in its order. */
export function sidebarTags(catalog: FsTagCatalog): readonly FsTag[] {
	return catalog.supported ? catalog.tags.filter((tag) => tag.sidebar) : [];
}
