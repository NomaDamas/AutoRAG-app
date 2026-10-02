/**
 * Windowing math for the Finder's virtualized list and icon grid (issue #16).
 *
 * Both views keep only the items that intersect the scroll viewport in the DOM.
 * The window is a half-open index range `[start, end)` into the view's ordered
 * rows, clamped to the item count and widened by `overscan` so a fast scroll
 * paints before the blank edge is reached.
 *
 * `include` is the controller's keyboard/reveal target. When it lands outside
 * the natural window the window is *moved* to cover it (not stretched across
 * the gap) so the target's DOM node exists for `scrollIntoView`; the next
 * scroll event then re-windows around the new position.
 *
 * These functions are pure: the components measure the scroll container and
 * feed the numbers in, and the tests cover the arithmetic without a DOM.
 */

/** Extra list rows rendered outside the viewport on each side. */
export const LIST_OVERSCAN = 4;
/** Extra icon-grid rows rendered outside the viewport on each side. */
export const GRID_OVERSCAN = 2;

export interface IndexWindow {
	/** First rendered index (inclusive). */
	readonly start: number;
	/** One past the last rendered index (exclusive). */
	readonly end: number;
}

export interface WindowInput {
	/** Total number of items in the view. */
	readonly count: number;
	/** Content pixels scrolled past the first item's top edge; never negative. */
	readonly offset: number;
	/** Visible height of the scroll container in pixels. */
	readonly viewport: number;
	/** Height of one item row in pixels (item height + row gap). */
	readonly stride: number;
	/** Extra rows rendered on either side of the viewport. */
	readonly overscan: number;
	/** An item index that must be rendered even when it is scrolled away. */
	readonly include?: number | undefined;
}

function clampIndex(value: number, count: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.min(count, Math.max(0, value));
}

/**
 * Half-open window of items intersecting the viewport on a uniform stride.
 * `offset`/`viewport` are clamped; `count <= 0` or a non-positive `stride`
 * yields an empty window.
 */
export function linearWindow(input: WindowInput): IndexWindow {
	const count = Math.max(0, Math.floor(input.count));
	const stride = input.stride;
	if (count === 0 || !(stride > 0)) {
		return { start: 0, end: 0 };
	}
	const offset = Math.max(0, input.offset);
	const viewport = Math.max(0, input.viewport);
	const overscan = Math.max(0, Math.floor(input.overscan));
	const first = Math.floor(offset / stride);
	const last = Math.max(first, Math.ceil((offset + viewport) / stride) - 1);
	let start = clampIndex(first - overscan, count);
	let end = clampIndex(last + 1 + overscan, count);
	const include = input.include;
	if (include !== undefined && Number.isFinite(include) && include >= 0 && include < count && (include < start || include >= end)) {
		start = clampIndex(include - overscan, count);
		end = clampIndex(include + 1 + overscan, count);
	}
	if (end < start) {
		end = start;
	}
	return { start, end };
}

export interface GridWindow extends IndexWindow {
	/** First rendered row (inclusive); `start === startRow * columns`. */
	readonly startRow: number;
	/** One past the last rendered row (exclusive). */
	readonly endRow: number;
}

export interface GridWindowInput extends WindowInput {
	/** Tiles per row (measured from the laid-out CSS grid). */
	readonly columns: number;
}

/**
 * Row-aligned window for the wrapping icon grid: `linearWindow` runs on the row
 * grid, then the row range expands back to item indices. The first rendered row
 * is kept full width so the controller's DOM-measured column count stays valid
 * even when the target is on the short last row.
 */
export function gridWindow(input: GridWindowInput): GridWindow {
	const columns = Math.max(1, Math.floor(input.columns));
	const count = Math.max(0, Math.floor(input.count));
	const rows = count === 0 ? 0 : Math.ceil(count / columns);
	const includeRow =
		input.include !== undefined && input.include >= 0 && input.include < count ? Math.floor(input.include / columns) : undefined;
	const rowWindow = linearWindow({ ...input, count: rows, include: includeRow });
	let startRow = rowWindow.start;
	const endRow = rowWindow.end;
	if (rows > 1 && startRow === rows - 1 && count % columns !== 0) {
		startRow = rows - 2;
	}
	return {
		start: startRow * columns,
		end: Math.min(count, endRow * columns),
		startRow,
		endRow,
	};
}

/**
 * Tiles per row from a resolved `grid-template-columns` value, e.g.
 * `"112px 112px 112px"` → 3. Returns 0 when the value is absent or still a
 * symbolic `repeat(...)`, so callers can fall back to width math.
 */
export function gridColumnCount(template: string | null | undefined): number {
	const tracks = (template ?? "").trim();
	if (tracks === "" || tracks === "none" || tracks.includes("repeat(")) {
		return 0;
	}
	return Math.max(1, tracks.split(/\s+/).length);
}

/**
 * `auto-fill` count for a content width, used when computed style still reports
 * the unresolved `repeat(auto-fill, minmax(min, 1fr))` form.
 */
export function columnsForWidth(width: number, minTrack: number, gap: number): number {
	if (!(minTrack > 0) || !Number.isFinite(width)) {
		return 1;
	}
	const safeGap = Number.isFinite(gap) && gap > 0 ? gap : 0;
	return Math.max(1, Math.floor((Math.max(0, width) + safeGap) / (minTrack + safeGap)));
}
