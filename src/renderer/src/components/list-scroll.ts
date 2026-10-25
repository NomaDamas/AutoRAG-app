/**
 * The list view scrolls sideways in ONE place, the row list; the column header sits above it in a viewport that only
 * follows. Two nested `overflow-x: auto` boxes (the header+list wrapper and the list) drew two horizontal scrollbars
 * where the OS scrollbars take layout space (Windows, split panes) — and the list's own vertical scrollbar stays at
 * the visible edge, because the list is the box that is as wide as the pane.
 */
export const LIST_SCROLLER_CLASS = "list flex-1 min-h-0 py-0 overflow-auto";
export const HEADER_VIEWPORT_CLASS = "flex-none overflow-x-hidden";
/** The column that stacks the header viewport and the list; it never scrolls itself. */
export const LIST_COLUMN_CLASS = "flex min-h-0 flex-1 flex-col";

/** The slice of an element this needs; keeps the module free of the DOM lib the node project lacks. */
interface Scrollable {
	scrollLeft: number;
	addEventListener(type: "scroll", listener: () => void, options?: { readonly passive: boolean }): void;
	removeEventListener(type: "scroll", listener: () => void): void;
}

/** Keeps `header.scrollLeft` equal to `list.scrollLeft`; returns the cleanup. */
export function followScrollLeft(list: Scrollable, header: { scrollLeft: number }): () => void {
	const sync = (): void => {
		header.scrollLeft = list.scrollLeft;
	};
	sync();
	list.addEventListener("scroll", sync, { passive: true });
	return () => list.removeEventListener("scroll", sync);
}
