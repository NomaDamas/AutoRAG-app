/**
 * Rubber-band (marquee) selection for the icon grid: a drag that starts on
 * empty space draws a rectangle and selects every tile it touches, Finder's
 * own behavior. The grid is virtualized, so hits come from the layout math
 * (`state/grouping.groupedLayout`), never from the mounted tiles: a rectangle
 * that scrolls past the window still selects the tiles it covers.
 */

import type { GroupedLayout } from "./grouping";

/** A rectangle in the grid content's own coordinates (origin: its top-left). */
export interface MarqueeRect {
	readonly left: number;
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
}

/** The tile geometry the grid measured from its resolved CSS grid. */
export interface GridGeometry {
	readonly columns: number;
	/** Height of one tile-row track (the row stride minus the row gap). */
	readonly rowHeight: number;
	readonly columnGap: number;
	/** Content width the tracks share. */
	readonly width: number;
}

/** How a drag combines with the selection it started from (⌘ toggles, ⇧ adds). */
export type MarqueeMode = "replace" | "toggle" | "add";

/** Normalizes two corner points into a rectangle. */
export function marqueeRect(a: { readonly x: number; readonly y: number }, b: { readonly x: number; readonly y: number }): MarqueeRect {
	return {
		left: Math.min(a.x, b.x),
		top: Math.min(a.y, b.y),
		right: Math.max(a.x, b.x),
		bottom: Math.max(a.y, b.y),
	};
}

/**
 * Flattened row indices (the order of `sections.flatMap(rows)`) whose tile
 * cell the rectangle touches. Group headers never count; a short last row
 * only has its real tiles.
 */
export function marqueeHits(layout: GroupedLayout, geometry: GridGeometry, rect: MarqueeRect): number[] {
	const columns = Math.max(1, Math.floor(geometry.columns));
	const track = Math.max(0, (geometry.width - (columns - 1) * geometry.columnGap) / columns);
	const hits: number[] = [];
	layout.items.forEach((item, index) => {
		if (item.kind !== "rows") return;
		const top = layout.offsets[index] ?? 0;
		if (top >= rect.bottom || top + geometry.rowHeight <= rect.top) return;
		const base = layout.rowBases[index] ?? 0;
		for (let column = 0; column < item.count; column += 1) {
			const left = column * (track + geometry.columnGap);
			if (left < rect.right && left + track > rect.left) hits.push(base + column);
		}
	});
	return hits;
}

/**
 * The selection a drag produces from the one it started with: a plain drag
 * replaces it, ⌘ flips every touched tile, ⇧ adds them. `ordered` is the
 * view order, so the result reads top-left to bottom-right.
 */
export function combineMarquee(
	ordered: readonly string[],
	base: readonly string[],
	hits: readonly string[],
	mode: MarqueeMode,
): string[] {
	if (mode === "replace") return [...hits];
	const touched = new Set(hits);
	const start = new Set(base);
	return ordered.filter((key) => (mode === "add" ? start.has(key) || touched.has(key) : start.has(key) !== touched.has(key)));
}
