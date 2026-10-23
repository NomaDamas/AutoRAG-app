import { useEffect, type RefObject } from "react";
import type { FinderEntry } from "../data/entries";
import type { ColumnDirection } from "../state/columns";
import { discloseStep, type TreeRow } from "../state/folder-tree";
import type { GroupSection } from "../state/grouping";
import { type FocusZone, type KeyAction, mouseNavDirection, resolveKeyAction } from "../state/keymap";
import { moveSelection, type SelectionState } from "../state/selection";
import { isVirtualTabPath } from "../state/tabs";
import type { StackRow } from "../state/version-family";
import type { ViewMode } from "../state/view-mode";
import { columnsForWidth, gridColumnCount } from "../state/virtual";
import type { NewFileFormatId } from "../../../shared/new-file-contract";

/** Shortcuts that act on the window, not on rows: the only ones a Settings or AI Search tab answers. */
const WINDOW_KEY_ACTIONS: Partial<Record<KeyAction["type"], true>> = {
	dismiss: true,
	focusSearch: true,
	focusComposer: true,
	newTab: true,
	reopenTab: true,
	closeTab: true,
	openSettings: true,
	setViewMode: true,
};

/** The tile or column row that renders `path` (the list view scrolls by row index instead). */
export function itemElement(root: HTMLElement | null, path: string): HTMLElement | null {
	const selector = `[data-path="${CSS.escape(path)}"]`;
	return root?.querySelector<HTMLElement>(`.icon-tile${selector}, .column-row${selector}`) ?? null;
}

/**
 * Tiles per row in the icon grid. The resolved `grid-template-columns` is the
 * real track count and is shared by every section's grid block; the first
 * DOM row is only a fallback because grouping can leave the first rendered row
 * short (a small section), which would undercount the tracks.
 */
function gridColumns(root: HTMLElement | null): number {
	if (root === null) {
		return 1;
	}
	const grid = root.querySelector<HTMLElement>(".icon-grid");
	if (grid !== null) {
		const styles = getComputedStyle(grid);
		const tracks = gridColumnCount(styles.gridTemplateColumns);
		if (tracks > 0) {
			return tracks;
		}
		// Computed style still symbolic: width math on the tracked template.
		const minTrack = Number.parseFloat(styles.getPropertyValue("--tile-min")) || 96;
		const columnGap = Number.parseFloat(styles.columnGap) || 8;
		const byWidth = columnsForWidth(grid.clientWidth, minTrack, columnGap);
		if (byWidth > 0) {
			return byWidth;
		}
	}
	const counts = new Map<number, number>();
	let most = 0;
	for (const tile of root.querySelectorAll<HTMLElement>(".icon-tile")) {
		const count = (counts.get(tile.offsetTop) ?? 0) + 1;
		counts.set(tile.offsetTop, count);
		if (count > most) {
			most = count;
		}
	}
	return Math.max(1, most);
}

/**
 * Arrow target in the grouped icon grid. Every section lays its rows out in
 * `columns` tracks and a group restarts the tracks, so up/down move by a whole
 * tile-row inside the focused section and step to the adjacent section at its
 * edge, keeping the column when that section's row is long enough (a short
 * final row clamps to its last tile). Left/right walk the section's flattened
 * rows; a header separates sections, so they do not cross one. Returns the path
 * to focus, or null when the grid is empty.
 */
function groupedGridTarget(
	sections: readonly GroupSection<StackRow>[],
	columns: number,
	focus: string | null,
	step: { readonly dx: -1 | 0 | 1; readonly dy: -1 | 0 | 1 },
): string | null {
	const width = Math.max(1, Math.floor(columns));
	// One pass locates the focused path's section, its start, and the total.
	let total = 0;
	let index = -1;
	let section = 0;
	let sectionStart = 0;
	for (let i = 0; i < sections.length; i += 1) {
		const rows = sections[i]?.rows ?? [];
		if (index < 0 && focus !== null) {
			const at = rows.findIndex((row) => row.entry.path === focus);
			if (at >= 0) {
				index = total + at;
				section = i;
				sectionStart = total;
			}
		}
		total += rows.length;
	}
	if (total === 0) {
		return null;
	}
	if (index < 0) {
		index = 0;
		section = 0;
		sectionStart = 0;
	}
	const rowsHere = sections[section]?.rows.length ?? 0;
	let local = index - sectionStart;
	if (step.dy !== 0) {
		const row = Math.floor(local / width);
		const lastRow = Math.floor((rowsHere - 1) / width);
		const column = local % width;
		const nextRow = row + step.dy;
		if (nextRow >= 0 && nextRow <= lastRow) {
			// Same section: clamp to a short final row.
			local = Math.min(nextRow * width + column, rowsHere - 1);
		} else if (nextRow < 0) {
			const previousRows = sections[section - 1]?.rows.length ?? 0;
			if (previousRows > 0) {
				section -= 1;
				local = Math.min(column, previousRows - 1);
			}
		} else {
			const nextRows = sections[section + 1]?.rows.length ?? 0;
			if (nextRows > 0) {
				section += 1;
				local = Math.min(column, nextRows - 1);
			}
		}
	} else if (step.dx !== 0) {
		const candidate = local + step.dx;
		if (candidate >= 0 && candidate < rowsHere) {
			local = candidate;
		}
	}
	return sections[section]?.rows[local]?.entry.path ?? focus;
}

/** What the keyboard reads and drives; every handler is a stable `useLatestCallback`. */
export interface FinderKeyboardInput {
	/** This pane has the window's focus: it alone answers the keyboard. */
	readonly focused: boolean;
	readonly zone: FocusZone;
	readonly path: string;
	readonly layout: ViewMode;
	readonly selection: SelectionState;
	readonly orderedKeys: readonly string[];
	readonly stackRows: readonly TreeRow[];
	readonly stackSections: readonly GroupSection<TreeRow>[];
	readonly focusedEntry: FinderEntry | null;
	readonly listRef: RefObject<HTMLDivElement | null>;
	readonly actions: {
		dismiss(): void;
		focusSearch(): void;
		/** ⌘L: turn the path bar into a text field holding the current path. */
		editPath(): void;
		/** ⌘D: duplicate the selected rows next to themselves. */
		duplicateSelection(): void;
		newTab(): void;
		newFolder(): void;
		newFile(format: NewFileFormatId): void;
		reopenClosedTab(): void;
		closeTab(): void;
		openSettings(): void;
		focusComposer(): void;
		quickLookSelection(): void;
		/** Closes the open Quick Look panel; false when none is open. */
		closeOpenQuickLook(): boolean;
		stepColumns(direction: ColumnDirection): void;
		/** Select `path` alone and scroll it into view. */
		focusPath(path: string): void;
		/** Apply a moved selection and scroll its focus into view. */
		moveTo(next: SelectionState): void;
		setViewMode(mode: ViewMode): void;
		setFolderOpen(folder: string, open: boolean): void;
		openEntry(entry: FinderEntry): void;
		trash(paths: readonly string[]): void;
		/** Start the inline rename of the focused row (⌘R). */
		renameFocused(): void;
		/** Go up to the enclosing folder and select the folder just left (⌥↑). */
		goToParentFolder(): void;
		copySelection(): void;
		cutSelection(): void;
		pasteClipboard(move: boolean): void;
		undoLastOperation(): void;
		redoLastOperation(): void;
		/** The toolbar's Back and Forward, also driven by the mouse side buttons. */
		back(): void;
		forward(): void;
	};
}

/** The input half of a Finder pane: its window-level keyboard shortcuts. */
export function useFinderKeyboard(input: FinderKeyboardInput): void {
	const { focused, zone, path, layout, selection, orderedKeys, stackRows, stackSections, focusedEntry, listRef, actions } = input;
	useEffect(() => {
		// Every pane mounts a controller; only the focused one answers the keyboard.
		if (!focused) return;
		const onKeyDown = (event: globalThis.KeyboardEvent): void => {
			const target = event.target;
			const typing =
				target instanceof HTMLElement &&
				(target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable || target.closest('[role="menu"]') !== null);
			const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
			// Space closes an open preview wherever focus is. The panel an evidence title opens has no
			// row to toggle, and the focused title button would otherwise press itself and reopen it.
			if (event.key === " " && plain && !typing && actions.closeOpenQuickLook()) {
				event.preventDefault();
				return;
			}
			if (
				target instanceof HTMLElement &&
				target.tagName === "BUTTON" &&
				(event.key === "Enter" || event.key === " ") &&
				!event.metaKey &&
				!event.ctrlKey &&
				!event.altKey
			) {
				return;
			}
			const action = resolveKeyAction(
				{
					key: event.key,
					meta: event.metaKey || event.ctrlKey,
					shift: event.shiftKey,
					alt: event.altKey,
				},
				{ zone, typing, viewMode: layout },
			);
			if (action === null) {
				return;
			}
			// A Settings or AI Search tab shows no rows: only window-level shortcuts apply.
			if (isVirtualTabPath(path) && WINDOW_KEY_ACTIONS[action.type] !== true) {
				return;
			}
			switch (action.type) {
				case "dismiss":
					actions.dismiss();
					return;
				case "focusSearch":
					event.preventDefault();
					actions.focusSearch();
					return;
				case "editPath":
					event.preventDefault();
					actions.editPath();
					return;
				case "duplicate":
					event.preventDefault();
					actions.duplicateSelection();
					return;
				case "newTab":
					event.preventDefault();
					actions.newTab();
					return;
				case "reopenTab":
					event.preventDefault();
					actions.reopenClosedTab();
					return;
				case "newFolder":
					event.preventDefault();
					actions.newFolder();
					return;
				case "newFile":
					event.preventDefault();
					actions.newFile(action.format);
					return;
				case "closeTab":
					event.preventDefault();
					actions.closeTab();
					return;
				case "openSettings":
					event.preventDefault();
					actions.openSettings();
					return;
				case "focusComposer":
					event.preventDefault();
					actions.focusComposer();
					return;
				case "quickLook":
					event.preventDefault();
					actions.quickLookSelection();
					return;
				case "moveSelection": {
					event.preventDefault();
					if (layout === "columns") {
						actions.stepColumns(action.delta === 1 ? "down" : "up");
						return;
					}
					if (layout === "icons") {
						const next = groupedGridTarget(stackSections, gridColumns(listRef.current), selection.focus, {
							dx: 0,
							dy: action.delta,
						});
						if (next !== null) actions.focusPath(next);
						return;
					}
					actions.moveTo(moveSelection(orderedKeys, selection, action.delta));
					return;
				}
				case "moveSelectionSideways": {
					event.preventDefault();
					if (layout === "columns") {
						actions.stepColumns(action.delta === 1 ? "right" : "left");
						return;
					}
					const next = groupedGridTarget(stackSections, gridColumns(listRef.current), selection.focus, {
						dx: action.delta,
						dy: 0,
					});
					if (next !== null) actions.focusPath(next);
					return;
				}
				case "setViewMode":
					event.preventDefault();
					actions.setViewMode(action.mode);
					return;
				case "moveEvidence":
					return;
				case "disclose": {
					const step = discloseStep(stackRows, selection.focus, action.direction);
					if (step === null) {
						return;
					}
					event.preventDefault();
					if (step.type === "select") {
						actions.focusPath(step.path);
						return;
					}
					actions.setFolderOpen(step.path, step.type === "expand");
					return;
				}
				case "open":
					event.preventDefault();
					if (layout === "columns" && focusedEntry?.kind === "folder") {
						actions.stepColumns("right");
						return;
					}
					if (focusedEntry !== null) {
						actions.openEntry(focusedEntry);
					}
					return;
				case "trash":
					event.preventDefault();
					actions.trash(selection.keys);
					return;
				case "rename":
					event.preventDefault();
					actions.renameFocused();
					return;
				case "parentFolder":
					event.preventDefault();
					actions.goToParentFolder();
					return;
				case "copy":
					event.preventDefault();
					actions.copySelection();
					return;
				case "cut":
					event.preventDefault();
					actions.cutSelection();
					return;
				case "paste":
					event.preventDefault();
					actions.pasteClipboard(action.move);
					return;
				case "undo":
					event.preventDefault();
					actions.undoLastOperation();
					return;
				case "redo":
					event.preventDefault();
					actions.redoLastOperation();
					return;
			}
		};
		// The mouse side buttons are the toolbar's Back and Forward. `mouseup`
		// acts, and `mousedown`/`auxclick` are cancelled so the page never also
		// runs Chromium's own history step.
		const onMouseUp = (event: MouseEvent): void => {
			const direction = mouseNavDirection(event.button);
			if (direction === null) return;
			event.preventDefault();
			if (direction === "back") actions.back();
			else actions.forward();
		};
		const swallow = (event: MouseEvent): void => {
			if (mouseNavDirection(event.button) !== null) event.preventDefault();
		};
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("mouseup", onMouseUp);
		window.addEventListener("mousedown", swallow);
		window.addEventListener("auxclick", swallow);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("mouseup", onMouseUp);
			window.removeEventListener("mousedown", swallow);
			window.removeEventListener("auxclick", swallow);
		};
	}, [focused, zone, path, layout, selection, orderedKeys, stackRows, stackSections, focusedEntry, listRef, actions]);
}
