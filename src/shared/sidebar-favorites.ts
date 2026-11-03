/**
 * Edits of the Favorites section of `SidebarSettings`, shared by every surface
 * that changes it: Settings → 사이드바 (`SidebarPage.tsx`) and the sidebar's own
 * pin, unpin, and drag-to-reorder paths. They all call these functions, so a
 * pinned folder is the same `customFavorites` / `favoritesOrder` value wherever
 * it was pinned. The functions are pure and return a new settings object; the
 * caller normalizes and persists it.
 */

import { customSidebarItemId, type SidebarSettings } from "./sidebar-contract";

/**
 * `rows` ordered by `favoritesOrder`: a listed id sorts by its position, and an
 * unlisted one follows the listed ones in its original order.
 */
export function sortByFavoritesOrder<T extends { readonly id: string }>(
	rows: readonly T[],
	favoritesOrder: readonly string[],
): T[] {
	const orderIndex = new Map<string, number>(favoritesOrder.map((id, idx) => [id, idx]));
	return rows
		.map((row, idx) => ({ row, order: orderIndex.get(row.id) ?? favoritesOrder.length + idx }))
		.sort((a, b) => a.order - b.order)
		.map(({ row }) => row);
}

/**
 * Pins the custom folder `path` (already normalized by the caller): a path that
 * is already pinned is replaced rather than repeated, and the row is un-hidden.
 */
export function withCustomFavorite(sidebar: SidebarSettings, path: string): SidebarSettings {
	return {
		...sidebar,
		customFavorites: [...sidebar.customFavorites.filter((item) => item.path !== path), { path }],
		hiddenItems: sidebar.hiddenItems.filter((id) => id !== customSidebarItemId(path)),
	};
}

/** Removes the custom folder `path` along with its order and hidden entries. */
export function withoutCustomFavorite(sidebar: SidebarSettings, path: string): SidebarSettings {
	const id = customSidebarItemId(path);
	return {
		...sidebar,
		customFavorites: sidebar.customFavorites.filter((item) => item.path !== path),
		favoritesOrder: sidebar.favoritesOrder.filter((item) => item !== id),
		hiddenItems: sidebar.hiddenItems.filter((item) => item !== id),
	};
}

/**
 * Moves the Favorite at `from` of `orderedIds` to `to` and writes the whole list
 * as `favoritesOrder`. Out-of-range indexes leave the settings unchanged.
 */
export function withFavoriteMoved(
	sidebar: SidebarSettings,
	orderedIds: readonly string[],
	from: number,
	to: number,
): SidebarSettings {
	if (to < 0 || to >= orderedIds.length) return sidebar;
	const ids = [...orderedIds];
	const [moved] = ids.splice(from, 1);
	if (moved === undefined) return sidebar;
	ids.splice(to, 0, moved);
	return { ...sidebar, favoritesOrder: ids };
}
