import { useMemo } from "react";
import type { FsLocation } from "../../../shared/fs-contract";
import type { SidebarSettings } from "../../../shared/sidebar-contract";
import {
	folderPinState,
	moveShownFavorite,
	pinFolders,
	shownFavoriteIds,
	unpinFavorite,
	type FolderPinState,
} from "../state/sidebar-pins";
import { useLatestCallback } from "./useLatestCallback";
import { useSidebarSettings } from "./useSidebarSettings";

/** What the sidebar's pin, unpin, and reorder gestures call; each writes `AppSettings.sidebar`. */
export interface SidebarPins {
	/** The ids of the customizable Favorites rows drawn now, top to bottom. */
	readonly shownIds: readonly string[];
	/** How Favorites holds the folder at `path`; null when it has no row. */
	stateOf(path: string): FolderPinState | null;
	/** Pins folders at `gap` (null: the end of Favorites). A folder already shown is left alone. */
	pin(paths: readonly string[], gap: number | null): void;
	/** Removes the user pin `id`. */
	unpin(id: string): void;
	/** Moves the drawn row `id` to `gap`. */
	move(id: string, gap: number): void;
}

/**
 * The sidebar's pin edits for the settings in force and the OS `locations` the
 * rows were drawn from. The write goes through the same settings bridge as
 * Settings → 사이드바, and the `settings:changed` broadcast redraws the sidebar.
 */
export function useSidebarPins(locations: readonly FsLocation[], onError: (message: string) => void): SidebarPins {
	const sidebar = useSidebarSettings();
	const shownIds = useMemo(() => shownFavoriteIds(sidebar, locations), [sidebar, locations]);
	const write = useLatestCallback((next: SidebarSettings): void => {
		if (next === sidebar) return;
		window.autorag.settings.set({ sidebar: next }).catch((cause: unknown) => {
			onError(cause instanceof Error ? cause.message : String(cause));
		});
	});
	const stateOf = useLatestCallback((path: string) => folderPinState(sidebar, locations, path));
	const pin = useLatestCallback((paths: readonly string[], gap: number | null) => write(pinFolders(sidebar, locations, paths, gap)));
	const unpin = useLatestCallback((id: string) => write(unpinFavorite(sidebar, id)));
	const move = useLatestCallback((id: string, gap: number) => write(moveShownFavorite(sidebar, locations, id, gap)));
	return useMemo(() => ({ shownIds, stateOf, pin, unpin, move }), [shownIds, stateOf, pin, unpin, move]);
}
