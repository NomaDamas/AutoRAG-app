/**
 * Edits of the Favorites section of `SidebarSettings`, shared by every surface
 * that changes it: Settings → 사이드바 (`SidebarPage.tsx`) and the sidebar's own
 * pin, unpin, and drag-to-reorder paths. They all call these functions, so a
 * pinned folder is the same `customFavorites` / `favoritesOrder` value wherever
 * it was pinned. The functions are pure and return a new settings object; the
 * caller normalizes and persists it.
 */

import {
	customSidebarItemId,
	placeSidebarItemId,
	STANDARD_FAVORITE_KINDS,
	type SidebarSettings,
} from "./sidebar-contract";

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
 * Every customizable Favorite id in display order, hidden or not: the standard
 * place kinds, then the custom pins, sorted by `favoritesOrder`. This is the
 * list Settings → 사이드바 shows and the base a reorder writes back.
 */
export function favoriteIdsInOrder(sidebar: SidebarSettings): string[] {
	const ids = [
		...STANDARD_FAVORITE_KINDS.map(placeSidebarItemId),
		...sidebar.customFavorites.map((entry) => customSidebarItemId(entry.path)),
	];
	return sortByFavoritesOrder(
		ids.map((id) => ({ id })),
		sidebar.favoritesOrder,
	).map((row) => row.id);
}

/**
 * `order` with `id` moved to gap `gap` of the rows now shown.
 *
 * `shown` lists the customizable rows the sidebar draws, top to bottom, `id`
 * included when it is drawn. A gap counts the rows above it, so 0 is above the
 * first row and `shown.length` below the last one; hidden entries of `order`
 * keep their place relative to the rows they sat beside.
 */
export function placeFavoriteAtGap(
	order: readonly string[],
	shown: readonly string[],
	id: string,
	gap: number,
): string[] {
	const others = shown.filter((shownId) => shownId !== id);
	const at = shown.indexOf(id);
	// Taking `id` out of the list moves every gap below its old row up by one.
	const target = Math.max(0, Math.min(at >= 0 && at < gap ? gap - 1 : gap, others.length));
	const rest = [...order.filter((orderId) => orderId !== id), ...others.filter((other) => !order.includes(other))];
	const anchor = others[target];
	if (anchor !== undefined) {
		rest.splice(rest.indexOf(anchor), 0, id);
		return rest;
	}
	const last = others[others.length - 1];
	rest.splice(last === undefined ? rest.length : rest.indexOf(last) + 1, 0, id);
	return rest;
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
