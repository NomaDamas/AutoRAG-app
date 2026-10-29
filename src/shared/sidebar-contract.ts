/**
 * Sidebar customization contract shared by the main process, the settings
 * service (`settings-state.json`), the app-customizer pi agent profile, and
 * the renderer (`places.ts`, `Sidebar.tsx`, `SidebarPage.tsx`).
 *
 * Hard invariant:
 * - `AI Search` (`app:aiSearch`) and `Automations` (`app:automations`, 자동화)
 *   are core app views and can NEVER be hidden or removed from the top of
 *   Favorites, regardless of what is written on disk, sent over IPC, or asked
 *   of the customization agent.
 */

import type { FsLocationIcon } from "./fs-contract";

export const LOCKED_SIDEBAR_ITEM_IDS = ["app:aiSearch", "app:automations"] as const;
export type LockedSidebarItemId = (typeof LOCKED_SIDEBAR_ITEM_IDS)[number];

export const SIDEBAR_SECTION_IDS = ["favorites", "cloud", "locations", "tags"] as const;
export type SidebarSectionId = (typeof SIDEBAR_SECTION_IDS)[number];

export const HIDEABLE_SIDEBAR_SECTION_IDS = ["cloud", "locations", "tags"] as const;
export type HideableSidebarSectionId = (typeof HIDEABLE_SIDEBAR_SECTION_IDS)[number];

/** Standard OS favorite folder kinds in their default Finder order. */
export const STANDARD_FAVORITE_KINDS = [
	"recents",
	"home",
	"applications",
	"desktop",
	"documents",
	"downloads",
	"music",
	"movies",
	"pictures",
	"trash",
] as const satisfies readonly FsLocationIcon[];
export type StandardFavoriteKind = (typeof STANDARD_FAVORITE_KINDS)[number];

/** Preset hidden items for the "핵심만 표시 (미니멀)" quick preset. */
export const MINIMAL_HIDDEN_FAVORITE_IDS = [
	"place:applications",
	"place:music",
	"place:movies",
	"place:pictures",
] as const;

export interface CustomSidebarFavorite {
	readonly path: string;
	readonly label?: string;
}

export interface SidebarSettings {
	/**
	 * Item IDs hidden from the sidebar (`place:<kind>`, `custom:<path>`,
	 * `cloud:<path>`, `location:<path>`, `tag:<name>`).
	 * Locked app rows (`app:aiSearch`, `app:automations`) are NEVER stored here.
	 */
	readonly hiddenItems: readonly string[];
	/**
	 * Sections hidden as a whole (`cloud`, `locations`, `tags`).
	 * `favorites` cannot be hidden because `AI Search` and `Automations` live in it.
	 */
	readonly hiddenSections: readonly HideableSidebarSectionId[];
	/**
	 * Explicit ordering of customizable Favorite item IDs (`place:<kind>`, `custom:<path>`).
	 * `app:aiSearch` and `app:automations` always remain first and second in Favorites;
	 * items not listed in `favoritesOrder` follow in their default order.
	 */
	readonly favoritesOrder: readonly string[];
	/**
	 * Order of the four sidebar sections. `favorites` is always present (defaulting to first).
	 */
	readonly sectionOrder: readonly SidebarSectionId[];
	/**
	 * User-pinned custom folder rows in Favorites.
	 */
	readonly customFavorites: readonly CustomSidebarFavorite[];
}

export const DEFAULT_SIDEBAR_SETTINGS: SidebarSettings = {
	hiddenItems: [],
	hiddenSections: [],
	favoritesOrder: [],
	sectionOrder: ["favorites", "cloud", "locations", "tags"],
	customFavorites: [],
};

const LOCKED_SET: ReadonlySet<string> = new Set<string>(LOCKED_SIDEBAR_ITEM_IDS);
const SECTION_SET: ReadonlySet<string> = new Set<string>(SIDEBAR_SECTION_IDS);
const HIDEABLE_SECTION_SET: ReadonlySet<string> = new Set<string>(HIDEABLE_SIDEBAR_SECTION_IDS);
const FAVORITE_KIND_SET: ReadonlySet<string> = new Set<string>(STANDARD_FAVORITE_KINDS);

/** Common human/agent aliases mapped to canonical item IDs. */
const ITEM_ALIAS_MAP: Readonly<Record<string, string>> = {
	"app:aisearch": "app:aiSearch",
	"aisearch": "app:aiSearch",
	"ai-search": "app:aiSearch",
	"ai_search": "app:aiSearch",
	"ai search": "app:aiSearch",
	"ai 검색": "app:aiSearch",
	"ai검색": "app:aiSearch",
	"app:automations": "app:automations",
	"automations": "app:automations",
	"automation": "app:automations",
	"자동화": "app:automations",
	"recent": "place:recents",
	"recents": "place:recents",
	"최근 항목": "place:recents",
	"최근항목": "place:recents",
	"home": "place:home",
	"홈": "place:home",
	"applications": "place:applications",
	"apps": "place:applications",
	"응용 프로그램": "place:applications",
	"응용프로그램": "place:applications",
	"desktop": "place:desktop",
	"데스크탑": "place:desktop",
	"바탕화면": "place:desktop",
	"documents": "place:documents",
	"docs": "place:documents",
	"문서": "place:documents",
	"downloads": "place:downloads",
	"download": "place:downloads",
	"다운로드": "place:downloads",
	"music": "place:music",
	"음악": "place:music",
	"movies": "place:movies",
	"videos": "place:movies",
	"동영상": "place:movies",
	"비디오": "place:movies",
	"pictures": "place:pictures",
	"photos": "place:pictures",
	"그림": "place:pictures",
	"사진": "place:pictures",
	"trash": "place:trash",
	"recycle bin": "place:trash",
	"휴지통": "place:trash",
};

/** Canonical sidebar item ID for a place kind (`place:desktop`, etc.). */
export function placeSidebarItemId(kind: FsLocationIcon): string {
	return `place:${kind}`;
}

/** Canonical sidebar item ID for a custom pinned folder (`custom:/path`). */
export function customSidebarItemId(path: string): string {
	return `custom:${path}`;
}

/** Canonical sidebar item ID for a cloud drive (`cloud:/path`). */
export function cloudSidebarItemId(path: string): string {
	return `cloud:${path}`;
}

/** Canonical sidebar item ID for a mounted volume/disk (`location:/path`). */
export function locationSidebarItemId(path: string): string {
	return `location:${path}`;
}

/** Canonical sidebar item ID for a Finder tag (`tag:Name`). */
export function tagSidebarItemId(name: string): string {
	return `tag:${name}`;
}

/**
 * Resolves a raw item identifier or natural-language alias (`"music"`,
 * `"place:music"`, `"AI Search"`, `"자동화"`, `"/Users/me/Work"`) to its
 * canonical sidebar item ID.
 */
export function normalizeSidebarItemId(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed === "") return "";
	const alias = ITEM_ALIAS_MAP[trimmed.toLowerCase()];
	if (alias !== undefined) return alias;
	if (trimmed.startsWith("place:")) {
		const kind = trimmed.slice("place:".length).trim().toLowerCase();
		if (FAVORITE_KIND_SET.has(kind)) return `place:${kind}`;
	}
	return trimmed;
}

/** True when `id` (or its alias) refers to `AI Search` or `Automations` (`자동화`). */
export function isLockedSidebarItemId(id: string): boolean {
	const normalized = normalizeSidebarItemId(id);
	return LOCKED_SET.has(normalized);
}

export function isSidebarSectionId(value: unknown): value is SidebarSectionId {
	return typeof value === "string" && SECTION_SET.has(value);
}

export function isHideableSidebarSectionId(value: unknown): value is HideableSidebarSectionId {
	return typeof value === "string" && HIDEABLE_SECTION_SET.has(value);
}

function uniqueStrings(values: Iterable<string>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		if (value === "" || seen.has(value)) continue;
		seen.add(value);
		out.push(value);
	}
	return out;
}

/**
 * Sanitizes and normalizes any persisted or partial `SidebarSettings` object:
 * - Strips locked items (`app:aiSearch`, `app:automations`) from `hiddenItems` and `favoritesOrder`.
 * - Rejects `"favorites"` in `hiddenSections`.
 * - Guarantees `sectionOrder` contains all 4 sections with `"favorites"` first when not explicitly moved,
 *   and every section present exactly once.
 * - Deduplicates `customFavorites` by normalized non-empty path.
 */
export function normalizeSidebarSettings(raw: unknown): SidebarSettings {
	if (typeof raw !== "object" || raw === null) return DEFAULT_SIDEBAR_SETTINGS;
	const candidate = raw as Partial<Record<keyof SidebarSettings, unknown>>;

	const hiddenItems = Array.isArray(candidate.hiddenItems)
		? uniqueStrings(
				candidate.hiddenItems
					.filter((item): item is string => typeof item === "string")
					.map(normalizeSidebarItemId)
					.filter((id) => id !== "" && !isLockedSidebarItemId(id)),
			)
		: [];

	const hiddenSections = Array.isArray(candidate.hiddenSections)
		? (uniqueStrings(
				candidate.hiddenSections.filter(isHideableSidebarSectionId),
			) as HideableSidebarSectionId[])
		: [];

	const favoritesOrder = Array.isArray(candidate.favoritesOrder)
		? uniqueStrings(
				candidate.favoritesOrder
					.filter((item): item is string => typeof item === "string")
					.map(normalizeSidebarItemId)
					.filter((id) => id !== "" && !isLockedSidebarItemId(id)),
			)
		: [];

	const rawSections = Array.isArray(candidate.sectionOrder)
		? uniqueStrings(candidate.sectionOrder.filter(isSidebarSectionId))
		: [];
	const sectionOrder: SidebarSectionId[] = [
		...(rawSections as SidebarSectionId[]),
		...SIDEBAR_SECTION_IDS.filter((section) => !rawSections.includes(section)),
	];

	const customFavorites: CustomSidebarFavorite[] = [];
	const seenPaths = new Set<string>();
	if (Array.isArray(candidate.customFavorites)) {
		for (const entry of candidate.customFavorites) {
			if (typeof entry !== "object" || entry === null) continue;
			const record = entry as Record<string, unknown>;
			const path = typeof record.path === "string" ? record.path.trim() : "";
			if (path === "" || seenPaths.has(path)) continue;
			seenPaths.add(path);
			const label = typeof record.label === "string" && record.label.trim().length > 0 ? record.label.trim() : undefined;
			customFavorites.push(label === undefined ? { path } : { path, label });
		}
	}

	return {
		hiddenItems,
		hiddenSections,
		favoritesOrder,
		sectionOrder,
		customFavorites,
	};
}

/** True when `sidebar` matches the uncustomized default configuration. */
export function isDefaultSidebarSettings(sidebar: SidebarSettings | undefined): boolean {
	if (sidebar === undefined) return true;
	const norm = normalizeSidebarSettings(sidebar);
	return (
		norm.hiddenItems.length === 0 &&
		norm.hiddenSections.length === 0 &&
		norm.favoritesOrder.length === 0 &&
		norm.customFavorites.length === 0 &&
		norm.sectionOrder.every((section, index) => section === DEFAULT_SIDEBAR_SETTINGS.sectionOrder[index])
	);
}
