/**
 * Pinning folders to the sidebar's Favorites, the way Finder does: drag a folder
 * between two rows, choose 사이드바에 고정 on a folder, drag a row to reorder,
 * choose 사이드바에서 제거 on a pinned row.
 *
 * Every path ends in `SidebarSettings` (`customFavorites` / `favoritesOrder`
 * through `shared/sidebar-favorites.ts`, the same edits Settings → 사이드바
 * makes), so what the sidebar writes is what Settings shows. The functions are
 * pure: they take the settings and the OS locations the sidebar was drawn from
 * and return the settings to write.
 *
 * A *gap* is a position between Favorites rows, counted in the rows the sidebar
 * draws: 0 is above the first customizable row (the two app rows stay on top)
 * and the row count is below the last one.
 */

import type { FsLocation } from "../../../shared/fs-contract";
import {
	customPathOfSidebarItemId,
	customSidebarItemId,
	placeSidebarItemId,
	type SidebarSettings,
} from "../../../shared/sidebar-contract";
import {
	favoriteIdsInOrder,
	placeFavoriteAtGap,
	withCustomFavorite,
	withoutCustomFavorite,
} from "../../../shared/sidebar-favorites";
import { navGroups } from "../data/places";
import {
	attachmentsFromDrop,
	isOsFileDrag,
	readFinderDragFolders,
	type DropData,
} from "./attachments";
import { normalizeTypedPath } from "./paths";

/** The drag payload of a Favorites row being reordered: its sidebar item id. */
export const SIDEBAR_ITEM_DRAG_TYPE = "application/x-autorag-sidebar-item";

/** What a drag over the Favorites rows does when dropped between two of them. */
export type SidebarDragKind = "reorder" | "pin";

function homeOf(locations: readonly FsLocation[]): string | null {
	return locations.find((location) => location.section === "favorites" && location.icon === "home")?.path ?? null;
}

/** The ids of the customizable Favorites rows the sidebar draws, top to bottom. */
export function shownFavoriteIds(sidebar: SidebarSettings, locations: readonly FsLocation[]): string[] {
	const favorites = navGroups(locations, [], sidebar).find((group) => group.label === "Favorites");
	return (favorites?.items ?? []).flatMap((item) => (item.sidebarId === undefined ? [] : [item.sidebarId]));
}

/** A Favorites row for a folder: whether it is a user pin, and whether the sidebar draws it now. */
export interface FolderPinState {
	readonly id: string;
	/** A pin the user made (removable); false for an OS place such as Documents. */
	readonly custom: boolean;
	readonly shown: boolean;
}

/** The Favorites row that names `rawPath`, drawn or hidden; null when there is none. */
export function folderPinState(
	sidebar: SidebarSettings,
	locations: readonly FsLocation[],
	rawPath: string,
): FolderPinState | null {
	const home = homeOf(locations);
	const path = normalizeTypedPath(rawPath, home);
	if (path === "") return null;
	const shown = new Set(shownFavoriteIds(sidebar, locations));
	const place = locations.find((location) => location.section === "favorites" && location.path === path);
	if (place !== undefined) {
		const id = placeSidebarItemId(place.icon);
		return { id, custom: false, shown: shown.has(id) };
	}
	const pin = sidebar.customFavorites.find((entry) => (normalizeTypedPath(entry.path, home) || entry.path) === path);
	if (pin === undefined) return null;
	const id = customSidebarItemId(pin.path);
	return { id, custom: true, shown: shown.has(id) };
}

/**
 * Pins `rawPaths` (folders) at `gap`, or at the end of Favorites when `gap` is
 * null. A folder the sidebar already draws is left alone, so pinning twice adds
 * nothing; one that exists but is hidden (a hidden OS place, a hidden pin) is
 * shown again at the gap rather than added a second time.
 */
export function pinFolders(
	sidebar: SidebarSettings,
	locations: readonly FsLocation[],
	rawPaths: readonly string[],
	gap: number | null,
): SidebarSettings {
	let next = sidebar;
	let at = gap;
	for (const raw of rawPaths) {
		const found = folderPinState(next, locations, raw);
		if (found?.shown === true) continue;
		const shownBefore = shownFavoriteIds(next, locations);
		let id: string;
		if (found === null) {
			const path = normalizeTypedPath(raw, homeOf(locations));
			if (path === "") continue;
			next = withCustomFavorite(next, path);
			id = customSidebarItemId(path);
		} else {
			id = found.id;
			next = { ...next, hiddenItems: next.hiddenItems.filter((hidden) => hidden !== id) };
		}
		next = { ...next, favoritesOrder: placeFavoriteAtGap(favoriteIdsInOrder(next), shownBefore, id, at ?? shownBefore.length) };
		// The next folder of a multi-folder drop lands right below this one.
		at = shownFavoriteIds(next, locations).indexOf(id) + 1;
	}
	return next;
}

/** Removes the user pin `id` (`custom:<path>`); any other row has nothing to remove. */
export function unpinFavorite(sidebar: SidebarSettings, id: string): SidebarSettings {
	const path = customPathOfSidebarItemId(id);
	return path === null ? sidebar : withoutCustomFavorite(sidebar, path);
}

/**
 * The gap a pointer at vertical position `y` is in, given the drawn rows' boxes
 * top to bottom: the number of rows whose middle line the pointer is below.
 */
export function gapAtPointer(rows: readonly { readonly top: number; readonly height: number }[], y: number): number {
	return rows.filter((row) => y > row.top + row.height / 2).length;
}

/** Whether dropping row `id` at `gap` leaves the order as it is (the gaps just above and below it). */
export function isMoveInPlace(shownIds: readonly string[], id: string, gap: number): boolean {
	const at = shownIds.indexOf(id);
	return at < 0 || gap === at || gap === at + 1;
}

/** Moves the drawn Favorites row `id` to `gap`; the same settings object when it would not move. */
export function moveShownFavorite(
	sidebar: SidebarSettings,
	locations: readonly FsLocation[],
	id: string,
	gap: number,
): SidebarSettings {
	const shown = shownFavoriteIds(sidebar, locations);
	if (isMoveInPlace(shown, id, gap)) return sidebar;
	return { ...sidebar, favoritesOrder: placeFavoriteAtGap(favoriteIdsInOrder(sidebar), shown, id, gap) };
}

/**
 * What a drag over the Favorites rows would do, from the drag's formats (the
 * payload of an OS drag is unreadable until the drop): a row of this sidebar
 * reorders, a Finder row drag pins when it carries a folder, and an OS file
 * drag may carry one, which only the drop can tell.
 */
export function sidebarDragKind(data: Pick<DropData<unknown>, "types" | "getData">): SidebarDragKind | null {
	if (Array.from(data.types).includes(SIDEBAR_ITEM_DRAG_TYPE)) return "reorder";
	if (readFinderDragFolders(data).length > 0) return "pin";
	return isOsFileDrag(data.types) ? "pin" : null;
}

/** The folders a drop carries, from the Finder's own rows or from another app; files and links are skipped. */
export function droppedFolders<F extends { readonly name: string }>(
	data: DropData<F>,
	pathForFile: (file: F) => string,
): readonly string[] {
	return attachmentsFromDrop(data, pathForFile)
		.filter((attachment) => attachment.kind === "folder")
		.map((attachment) => attachment.id);
}
