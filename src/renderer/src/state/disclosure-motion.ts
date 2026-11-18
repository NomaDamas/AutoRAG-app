/**
 * Folder disclosure motion for the list view (seungwonme/AutoRAG-app#19): the rows of a folder
 * that opens in place slide out from behind it and push the rows below down by
 * their height; closing is the same motion backwards (NSOutlineView's
 * slide-down / slide-up row insertion in Finder).
 *
 * The list is virtualized, so the motion cannot move every row of a 5,000-entry
 * folder. This module keeps the arithmetic pure and bounded:
 *
 * - `detectDisclosureChange` reads the motion off two consecutive row lists
 *   (one folder row opened or closed, exactly one block of rows entered or left
 *   after it), so a folder whose listing is still loading animates once, when
 *   its rows arrive, and a refresh or a sort never animates.
 * - Only the rows that can reach the screen are drawn: `drawnBlockRows` caps
 *   the block at the viewport, and `disclosureView` windows the list *without*
 *   the block, then hangs that capped block under the folder row. The rows below
 *   the block are the ones the plain window already renders.
 * - Everything below the folder row moves rigidly by `hidden * (1 - openness)`
 *   and the block is clipped at the folder row's bottom edge, so `openness`
 *   (0 closed, 1 open) is the single number the animation drives.
 *
 * Nothing here touches the DOM: the node and web test projects both load it.
 */

import type { TreeRow } from "./folder-tree";
import {
	groupedLayout,
	groupedRowTop,
	groupedWindow,
	GROUP_HEADER_HEIGHT,
	type GroupedLayout,
	type GroupedWindow,
	type GroupSection,
} from "./grouping";
import { ROW_HEIGHT } from "./selection";

/* ------------------------------------------------------------------ detection */

export type DisclosureKind = "expand" | "collapse";

export interface DisclosureChange {
	readonly kind: DisclosureKind;
	/** Path of the folder row that opened or closed. */
	readonly parent: string;
	/** Index of the folder row in the flattened rows (the same before and after the change). */
	readonly parentIndex: number;
	/** The rows that entered (expand, from `next`) or left (collapse, from `prev`), in order. */
	readonly block: readonly TreeRow[];
}

/** Same rows in the same order: a refresh that changed no structure. */
export function sameShape(prev: readonly TreeRow[], next: readonly TreeRow[]): boolean {
	if (prev.length !== next.length) return false;
	for (let index = 0; index < prev.length; index += 1) {
		if (prev[index]?.entry.path !== next[index]?.entry.path) return false;
	}
	return true;
}

/**
 * The disclosure that turned `prev` into `next`, or null when the change is
 * anything else. Exactly one run of rows is inserted or removed, directly after
 * a folder row, and the run is that folder's whole block (every row deeper than
 * the folder, up to the next row at its level). The folder row must have opened
 * or closed: a folder that was already open and gains its first rows (its
 * listing arrived late) also counts, one that merely gained a row among others
 * does not.
 */
export function detectDisclosureChange(prev: readonly TreeRow[], next: readonly TreeRow[]): DisclosureChange | null {
	if (prev.length === next.length) return null;
	const grew = next.length > prev.length;
	const long = grew ? next : prev;
	const short = grew ? prev : next;
	const count = long.length - short.length;

	let head = 0;
	while (head < short.length && long[head]?.entry.path === short[head]?.entry.path) head += 1;
	if (head === 0) return null;
	for (let index = head; index < short.length; index += 1) {
		if (long[index + count]?.entry.path !== short[index]?.entry.path) return null;
	}

	const parentLong = long[head - 1];
	const parentShort = short[head - 1];
	if (parentLong === undefined || parentShort === undefined) return null;
	const block = long.slice(head, head + count);
	if (block.some((row) => row.depth <= parentLong.depth)) return null;
	// The block is the folder's whole run: whatever follows it is back at the folder's level.
	const after = long[head + count];
	if (after !== undefined && after.depth > parentLong.depth) return null;

	if (grew) {
		if (parentLong.disclosure !== "expanded") return null;
		if (parentShort.disclosure !== "collapsed" && parentShort.disclosure !== "expanded") return null;
		return { kind: "expand", parent: parentLong.entry.path, parentIndex: head - 1, block };
	}
	if (parentLong.disclosure !== "expanded" || parentShort.disclosure !== "collapsed") return null;
	return { kind: "collapse", parent: parentLong.entry.path, parentIndex: head - 1, block };
}

/* ----------------------------------------------------------------- the motion */

/** One running motion: what moves, and between which openness values. */
export interface DisclosureMotion {
	readonly id: number;
	readonly kind: DisclosureKind;
	readonly parent: string;
	readonly parentIndex: number;
	/** Every row of the block. Only the first `drawn` are put on screen. */
	readonly block: readonly TreeRow[];
	/** How many block rows can reach the screen (and are drawn while the motion runs). */
	readonly drawn: number;
	/** Openness the motion starts from (0 closed .. 1 open); not 0/1 when it reverses another one midway. */
	readonly from: number;
	readonly to: 0 | 1;
}

/**
 * How many rows of a block are worth drawing: those whose resting place lies
 * between the folder row and the bottom of what the viewport (plus overscan)
 * shows. A 5,000-row folder draws one screenful, never all of it.
 */
export function drawnBlockRows(input: {
	readonly count: number;
	/** Content-space bottom edge of the folder row. */
	readonly parentBottom: number;
	/** Content-space bottom of what the window renders. */
	readonly reach: number;
}): number {
	const room = Math.max(0, input.reach - input.parentBottom);
	return Math.min(Math.max(0, input.count), Math.ceil(room / ROW_HEIGHT));
}

/** What a scroll container shows, in the same content space as `groupedLayout`. */
export interface ScrollRange {
	readonly offset: number;
	readonly viewport: number;
}

/**
 * Starts the motion for a change, or returns null when nothing of the block can
 * be seen (the folder row is scrolled away, or the block lies below the window).
 * `current` is the motion that is still running, if any: the same folder moving
 * the other way continues from where it is instead of jumping.
 */
export function startDisclosure(input: {
	readonly change: DisclosureChange;
	readonly sections: readonly GroupSection<TreeRow>[];
	readonly scroll: ScrollRange;
	readonly overscan: number;
	readonly id: number;
	readonly current: DisclosureMotion | null;
	/** Openness the running motion has reached. */
	readonly currentOpenness: number;
}): DisclosureMotion | null {
	const { change, scroll } = input;
	const parentBottom = groupedRowTop(input.sections, change.parentIndex) + ROW_HEIGHT;
	// A folder row scrolled past the window has nothing to slide out from.
	if (parentBottom <= scroll.offset - input.overscan * ROW_HEIGHT) return null;
	const reach = scroll.offset + scroll.viewport + input.overscan * ROW_HEIGHT;
	const drawn = drawnBlockRows({ count: change.block.length, parentBottom, reach });
	if (drawn === 0) return null;
	const to = change.kind === "expand" ? 1 : 0;
	const reverses = input.current !== null && input.current.parent === change.parent && input.current.to !== to;
	const from = reverses ? clamp01(input.currentOpenness) : change.kind === "expand" ? 0 : 1;
	return { id: input.id, kind: change.kind, parent: change.parent, parentIndex: change.parentIndex, block: change.block, drawn, from, to };
}

function clamp01(value: number): number {
	return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/* --------------------------------------------------------------------- timing */

export const DEFAULT_DISCLOSURE_MS = 220;
/** Mirrors `--ease-disclosure` in tokens.css; used when the token cannot be read. */
export const DEFAULT_DISCLOSURE_EASE: readonly [number, number, number, number] = [0.2, 0.8, 0.2, 1];

/** "220ms" or "0.22s" as milliseconds; null for anything else. */
export function parseDuration(value: string): number | null {
	const match = /^\s*(\d*\.?\d+)\s*(ms|s)\s*$/.exec(value);
	if (match === null) return null;
	const amount = Number(match[1]);
	return match[2] === "s" ? amount * 1000 : amount;
}

/** `cubic-bezier(a, b, c, d)` as its four numbers; null for any other timing function. */
export function parseCubicBezier(value: string): readonly [number, number, number, number] | null {
	const match = /^\s*cubic-bezier\(\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^)]+)\)\s*$/.exec(value);
	if (match === null) return null;
	const numbers = [match[1], match[2], match[3], match[4]].map((part) => Number(part));
	const [x1, y1, x2, y2] = numbers;
	if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return null;
	if (numbers.some((number) => !Number.isFinite(number)) || x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return null;
	return [x1, y1, x2, y2];
}

/** The CSS `cubic-bezier` easing as a function of linear time (both in 0..1). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (time: number) => number {
	const cx = 3 * x1;
	const bx = 3 * (x2 - x1) - cx;
	const ax = 1 - cx - bx;
	const cy = 3 * y1;
	const by = 3 * (y2 - y1) - cy;
	const ay = 1 - cy - by;
	const sampleX = (s: number): number => ((ax * s + bx) * s + cx) * s;
	const sampleY = (s: number): number => ((ay * s + by) * s + cy) * s;
	const slopeX = (s: number): number => (3 * ax * s + 2 * bx) * s + cx;
	return (time) => {
		if (time <= 0) return 0;
		if (time >= 1) return 1;
		let s = time;
		for (let step = 0; step < 8; step += 1) {
			const error = sampleX(s) - time;
			if (Math.abs(error) < 1e-6) return sampleY(s);
			const slope = slopeX(s);
			if (Math.abs(slope) < 1e-6) break;
			s -= error / slope;
		}
		let low = 0;
		let high = 1;
		s = time;
		while (low < high) {
			const x = sampleX(s);
			if (Math.abs(x - time) < 1e-6) break;
			if (time > x) low = s;
			else high = s;
			s = (high - low) / 2 + low;
			if (high - low < 1e-7) break;
		}
		return sampleY(s);
	};
}

/**
 * How long a motion runs: the full duration for a whole open or close, less
 * when it only has the rest of the way to go (a reversal midway).
 */
export function motionDuration(base: number, from: number, to: number): number {
	return base * Math.abs(to - from);
}

/** Openness `elapsed` ms into a motion that lasts `duration`, eased by `ease`. */
export function opennessAt(
	motion: Pick<DisclosureMotion, "from" | "to">,
	elapsed: number,
	duration: number,
	ease: (time: number) => number,
): number {
	if (!(duration > 0)) return motion.to;
	const time = Math.min(1, Math.max(0, elapsed / duration));
	return motion.from + (motion.to - motion.from) * ease(time);
}

/* ----------------------------------------------------------------------- view */

/** What a row or header is doing while the motion runs. */
export type SlidePart = "block" | "ghost" | "below";

export interface RowSlide {
	readonly part: SlidePart;
	/** Distance of a block row's top below the folder row's bottom edge, in its resting place. */
	readonly offset: number;
}

/** The list as the motion draws it: the plain list's window with the capped block hung under the folder row. */
export interface DisclosureView {
	/** The sections without the block: the layout and the window run on these. */
	readonly base: readonly GroupSection<TreeRow>[];
	readonly layout: GroupedLayout;
	readonly window: GroupedWindow;
	/** Index in `layout.items` of the folder row. */
	readonly parentItem: number;
	/** Index of the folder row in the flattened `base` rows. */
	readonly parentIndex: number;
	/** The block rows put on screen, in order. */
	readonly drawn: readonly TreeRow[];
	/** Rows in the whole block. */
	readonly count: number;
	/** Height the drawn rows span: how far everything below the folder row travels. */
	readonly travel: number;
	/** Scroll height of the block rows that are not drawn. */
	readonly hidden: number;
}

function locate(sections: readonly GroupSection<TreeRow>[], flatIndex: number): { section: number; index: number } | null {
	let rest = flatIndex;
	for (let section = 0; section < sections.length; section += 1) {
		const rows = sections[section]?.rows.length ?? 0;
		if (rest < rows) return { section, index: rest };
		rest -= rows;
	}
	return null;
}

function layoutOf(sections: readonly GroupSection<TreeRow>[]): GroupedLayout {
	return groupedLayout(
		sections.map((section) => ({ label: section.label, rows: section.rows.length })),
		{ columns: 1, rowStride: ROW_HEIGHT, headerStride: GROUP_HEADER_HEIGHT },
	);
}

/**
 * The list for one frame of `motion`, or null when the motion has nothing to
 * show any more: the rows no longer match it, or the folder row is not in the
 * window (scrolled away mid-motion), in which case the plain list is right.
 *
 * `sections` always hold the settled rows: with the block on expand, without
 * it on collapse (whose block the motion keeps).
 */
export function disclosureView(
	sections: readonly GroupSection<TreeRow>[],
	motion: DisclosureMotion,
	scroll: ScrollRange,
	overscan: number,
): DisclosureView | null {
	const spot = locate(sections, motion.parentIndex);
	if (spot === null) return null;
	const owner = sections[spot.section];
	const parentRow = owner?.rows[spot.index];
	if (owner === undefined || parentRow === undefined || parentRow.entry.path !== motion.parent) return null;

	const count = motion.block.length;
	let base = sections;
	let drawn: readonly TreeRow[];
	if (motion.kind === "expand") {
		const entered = owner.rows.slice(spot.index + 1, spot.index + 1 + count);
		if (entered.length !== count || entered[0]?.entry.path !== motion.block[0]?.entry.path) return null;
		drawn = entered.slice(0, motion.drawn);
		const rows = [...owner.rows.slice(0, spot.index + 1), ...owner.rows.slice(spot.index + 1 + count)];
		base = sections.map((section, index) => (index === spot.section ? { ...section, rows } : section));
	} else {
		drawn = motion.block.slice(0, motion.drawn);
	}

	const layout = layoutOf(base);
	const travel = drawn.length * ROW_HEIGHT;
	const hidden = (count - drawn.length) * ROW_HEIGHT;

	// The list is taller than `layout.total` while the block is out, so the
	// window must not clamp the offset to the plain list. A closing block can
	// leave the scroller shorter than where it stands now, and the browser
	// then pulls it up as the height shrinks: the rows that scroll into view
	// have to be drawn already.
	const settled = Math.max(0, layout.total - scroll.viewport);
	const offset = motion.kind === "collapse" ? Math.min(scroll.offset, settled) : scroll.offset;
	const viewport = scroll.viewport + (scroll.offset - offset);
	const window = groupedWindow({ ...layout, total: layout.total + travel + hidden }, { offset, viewport, overscan });

	// One row per item in the list view, so the folder row is the item that starts at its index.
	const parentItem = layout.items.findIndex(
		(item) => item.kind === "rows" && item.section === spot.section && item.start === spot.index,
	);
	if (parentItem < window.start || parentItem >= window.end) return null;
	return { base, layout, window, parentItem, parentIndex: motion.parentIndex, drawn, count, travel, hidden };
}
