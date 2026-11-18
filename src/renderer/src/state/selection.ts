/**
 * Row selection for the Finder list: single, command-toggle, shift-range, and
 * keyboard movement.
 *
 * Reference: handoff README §2 "Selection". Keys are full item paths so a
 * selection survives a search (where rows come from many locations).
 */

/** File row height; the list is a fixed-height grid. */
export const ROW_HEIGHT = 24;
/** Pixels of context kept above a row the list jumps to from outside the viewport (see `scrollTopToReveal`). */
export const SCROLL_LEAD = 80;

export interface SelectionState {
	readonly keys: readonly string[];
	/** Range anchor for shift-click. */
	readonly anchor: string | null;
	/** The row the keyboard acts on. */
	readonly focus: string | null;
}

export const EMPTY_SELECTION: SelectionState = { keys: [], anchor: null, focus: null };

export interface ClickModifiers {
	readonly meta: boolean;
	readonly shift: boolean;
}

function single(key: string): SelectionState {
	return { keys: [key], anchor: key, focus: key };
}

export function applyRowClick(
	state: SelectionState,
	key: string,
	orderedKeys: readonly string[],
	modifiers: ClickModifiers,
): SelectionState {
	if (modifiers.meta) {
		const keys = state.keys.includes(key) ? state.keys.filter((k) => k !== key) : [...state.keys, key];
		return { keys, anchor: key, focus: keys[keys.length - 1] ?? null };
	}
	if (modifiers.shift) {
		const anchor = state.anchor ?? state.focus ?? key;
		const from = orderedKeys.indexOf(anchor);
		const to = orderedKeys.indexOf(key);
		if (from < 0 || to < 0) {
			return single(key);
		}
		return {
			keys: orderedKeys.slice(Math.min(from, to), Math.max(from, to) + 1),
			anchor,
			focus: key,
		};
	}
	return single(key);
}

export function moveSelection(
	orderedKeys: readonly string[],
	state: SelectionState,
	delta: 1 | -1,
): SelectionState {
	if (orderedKeys.length === 0) {
		return state;
	}
	const current = state.focus === null ? -1 : orderedKeys.indexOf(state.focus);
	const target = current < 0 ? 0 : current + delta;
	const next = orderedKeys[Math.min(orderedKeys.length - 1, Math.max(0, target))];
	return next === undefined ? state : single(next);
}

/**
 * Keyboard movement in the icon grid: tiles flow left to right in rows of
 * `columns`. Up/down move a whole row; a short last row catches a move down at
 * its last tile, and there is no wrap past either end.
 */
export function moveInGrid(
	orderedKeys: readonly string[],
	state: SelectionState,
	step: { readonly dx: -1 | 0 | 1; readonly dy: -1 | 0 | 1 },
	columns: number,
): SelectionState {
	const count = orderedKeys.length;
	if (count === 0) {
		return state;
	}
	const current = state.focus === null ? -1 : orderedKeys.indexOf(state.focus);
	if (current < 0) {
		const first = orderedKeys[0];
		return first === undefined ? state : single(first);
	}
	const width = Math.max(1, Math.floor(columns));
	let target = current + step.dx + step.dy * width;
	if (step.dy !== 0) {
		const lastRow = Math.floor((count - 1) / width);
		if (target < 0 || Math.floor(target / width) > lastRow) {
			target = current;
		}
	}
	const next = orderedKeys[Math.min(count - 1, Math.max(0, target))];
	return next === undefined ? state : single(next);
}

/**
 * Why a row is being scrolled to:
 * - `step`: the keyboard moved the focus (↑/↓, →/← onto a parent or child, the preview's own arrows).
 * - `reveal`: the list jumps to a row the person may not see at all (Show in Enclosing Folder, a search hit or
 *   evidence source, the folder just left with ⌥↑, a row just created).
 */
export type ScrollIntent = "step" | "reveal";

export interface RevealInput {
	/** Content-space top of the row, in the same space as `scrollTop`. */
	readonly top: number;
	readonly height: number;
	/** Where the list is scrolled to now, and how tall its visible part is. */
	readonly scrollTop: number;
	readonly viewport: number;
	/** The largest `scrollTop` the settled content allows: its height minus the viewport. */
	readonly maxScrollTop: number;
	readonly intent: ScrollIntent;
}

/**
 * The `scrollTop` that brings a row into view the way Finder (and `scrollIntoView({ block: "nearest" })`) does:
 * a row that is fully visible leaves the list where it is, and a row past an edge scrolls by exactly the part that
 * sticks out, so its bottom (or top) lands on the viewport's bottom (or top) edge. Nothing overlays the list's top: the
 * column header sits in a viewport of its own and the group headers scroll with the rows.
 *
 * One case is deliberately different. A `reveal` of a row that is entirely outside the viewport keeps `SCROLL_LEAD`
 * of context above it instead of pinning it to the edge: the person did not move to that row one step at a time,
 * so they have not seen its neighbours, and the row's flash would otherwise play on the very edge of the list. A
 * `step` is always one row from the focus the person is looking at, so it never needs the context.
 *
 * The geometry is the settled one (`maxScrollTop`): the list never needs the row's DOM node, which a virtualized
 * list has not mounted, and a viewport that stands past the settled end (a folder is closing under it) counts as
 * standing at that end, because that is where the browser leaves it.
 */
export function scrollTopToReveal(input: RevealInput): number {
	const { top, height, scrollTop, viewport, intent } = input;
	if (!(viewport > 0)) return scrollTop;
	const max = Math.max(0, input.maxScrollTop);
	const resting = Math.min(scrollTop, max);
	const bottom = top + height;
	if (top >= resting && bottom <= resting + viewport) return scrollTop;
	const outside = bottom <= resting || top >= resting + viewport;
	const target =
		intent === "reveal" && outside
			? top - SCROLL_LEAD
			: top < resting || height >= viewport
				? top
				: bottom - viewport;
	return Math.min(max, Math.max(0, target));
}

export function isSelected(state: SelectionState, key: string): boolean {
	return state.keys.includes(key);
}

export function selectionCount(state: SelectionState): number {
	return state.keys.length;
}
