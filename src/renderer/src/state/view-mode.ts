/**
 * Finder view modes, matching the toolbar toggle left to right:
 * 1 icons (tile grid), 2 list (the rows with the column header), 3 columns
 * (up to three side-by-side folder panes).
 */

export type ViewMode = "icons" | "list" | "columns";

export const VIEW_MODES: readonly ViewMode[] = ["icons", "list", "columns"];

export const DEFAULT_VIEW_MODE: ViewMode = "list";

/** Command 1 / 2 / 3 pick the mode at that position; any other key is not a mode key. */
export function viewModeForKey(key: string): ViewMode | null {
	const index = ["1", "2", "3"].indexOf(key);
	return index < 0 ? null : (VIEW_MODES[index] ?? null);
}

/** localStorage key that remembers the last chosen mode across launches. */
export const VIEW_MODE_STORAGE_KEY = "autorag.finder.viewMode";

export function parseViewMode(value: string | null): ViewMode {
	return VIEW_MODES.find((mode) => mode === value) ?? DEFAULT_VIEW_MODE;
}
