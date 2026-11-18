import { groupedRowTop, type GroupSection } from "../state/grouping";
import { ROW_HEIGHT, scrollTopToReveal, type ScrollIntent } from "../state/selection";
import type { ViewMode } from "../state/view-mode";
import { OPENNESS_PROPERTY } from "./useDisclosureMotion";
import { itemElement } from "./useFinderKeyboard";

/** A row the next row set should bring into view, and why (see `ScrollIntent`). */
export interface ScrollRequest {
	readonly path: string;
	readonly intent: ScrollIntent;
}

/** The list's rows container (`FileList`'s treegrid or grid): the one child that starts the virtual content. */
function rowsOf(list: HTMLElement): HTMLElement | null {
	for (const child of list.children) {
		const role = child.getAttribute("role");
		if (child instanceof HTMLElement && (role === "treegrid" || role === "grid")) return child;
	}
	return null;
}

/** A folder is opening or closing in the list (`useDisclosureMotion` drives its openness on the rows container). */
function disclosing(rows: HTMLElement | null): boolean {
	return rows !== null && rows.style.getPropertyValue(OPENNESS_PROPERTY) !== "";
}

/**
 * Scrolls the list view so the row at `index` (of the flattened `sections`) is in view, by the rule in
 * `scrollTopToReveal`. The row comes from the layout's geometry, not from its element: the list is virtualized, so
 * the row may not be mounted.
 *
 * `sections` are the settled rows, and so is the geometry. While a folder opens or closes, the rows on screen are
 * still moving and the scroller is shorter or taller than it will be, so a scroll written then could be clamped by
 * the browser and leave the row half hidden once the motion ends. The scroll therefore waits, frame by frame, for
 * the motion to settle and is computed from the settled list. Returns a function that cancels a scroll still waiting.
 */
export function revealListRow(
	list: HTMLElement,
	input: { readonly sections: readonly GroupSection<unknown>[]; readonly index: number; readonly intent: ScrollIntent },
): () => void {
	let frame: number | null = null;
	const scroll = (): void => {
		frame = null;
		const rows = rowsOf(list);
		if (disclosing(rows)) {
			frame = requestAnimationFrame(scroll);
			return;
		}
		// A banner above the rows (a version-family error) pushes the first row down; the rows' own top is the origin.
		const origin = rows === null ? 0 : rows.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
		const viewport = list.clientHeight;
		const rowCount = input.sections.reduce((total, section) => total + section.rows.length, 0);
		const next = scrollTopToReveal({
			top: origin + groupedRowTop(input.sections, input.index),
			height: ROW_HEIGHT,
			scrollTop: list.scrollTop,
			viewport,
			maxScrollTop: origin + groupedRowTop(input.sections, rowCount) - viewport,
			intent: input.intent,
		});
		if (next !== list.scrollTop) list.scrollTop = next;
	};
	scroll();
	return () => {
		if (frame !== null) cancelAnimationFrame(frame);
		frame = null;
	};
}

/**
 * Carries out a pending `ScrollRequest`. Returns null while the row cannot be reached yet, and the caller keeps the
 * request for the next row set; otherwise the request is used up and the result cancels whatever of it is still
 * pending.
 *
 * - The icon and column views mount the row's element (a pane or a revealed folder may still be loading it), and
 *   the browser scrolls it the way Finder does: `block: "nearest"`.
 * - The list is virtualized, so it works from the layout (`revealListRow`). `rows` is null while the rows on screen
 *   are not the target's folder yet (a revealed folder still loading); a search list may come from many folders and
 *   is always its own.
 */
export function revealTarget(input: {
	readonly layout: ViewMode;
	readonly list: HTMLElement | null;
	readonly request: ScrollRequest;
	readonly rows: { readonly sections: readonly GroupSection<unknown>[]; readonly orderedKeys: readonly string[] } | null;
}): (() => void) | null {
	const { layout, list, request, rows } = input;
	if (layout !== "list") {
		const element = itemElement(list, request.path);
		if (element === null) return null;
		element.scrollIntoView({ block: "nearest", inline: "nearest" });
		return () => undefined;
	}
	const index = rows === null ? -1 : rows.orderedKeys.indexOf(request.path);
	if (rows === null || index < 0) return null;
	return list === null ? () => undefined : revealListRow(list, { sections: rows.sections, index, intent: request.intent });
}
