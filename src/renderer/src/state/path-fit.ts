/**
 * Path bar fitting. The bar is a single line and never wraps. When the whole
 * trail does not fit, whole folders fold into one "…" button (a dropdown of the
 * folders it hides), the way Windows Explorer's address bar does, so what stays
 * on the bar is always readable: the folder you are in and as many of its
 * parents as fit.
 *
 * Order, first to fold to last:
 *   1. the middle segments, left to right ("Users", the home folder, …);
 *   2. the root ("Macintosh HD", "C:");
 *   3. the parent of the last segment.
 * The last segment (the current folder, or the selected file) never folds; when
 * even it does not fit beside "…", its label narrows behind a trailing fade.
 *
 * The bar reads: root › … next › last. "…" stands where the first folded
 * segment was, after the separator of the segment before it, and the segment
 * that follows it carries no separator of its own.
 */

export interface PathFitInput {
	/** Width the trail may occupy. */
	readonly available: number;
	/** Each segment button's natural width (icon, label, padding), in trail order. */
	readonly segments: readonly number[];
	/** A separator plus the gap that joins it to the segment it introduces. */
	readonly separator: number;
	/** The gap between two items of the trail. */
	readonly gap: number;
	/** The "…" button's width. */
	readonly more: number;
	/** Natural width of the last segment's label slot (the part a clip narrows). */
	readonly lastLabel: number;
	/** Narrowest clipped label still worth showing. */
	readonly minLabel: number;
}

export interface PathFit {
	/** Indices folded into "…", in trail order. Empty when everything shows. */
	readonly hidden: readonly number[];
	/** Width of the last segment's label slot when it is clipped; null when it shows in full. */
	readonly lastClip: number | null;
	/** Even "…" plus the narrowest last label is wider than `available`. */
	readonly overflow: boolean;
}

export const FITS: PathFit = { hidden: [], lastClip: null, overflow: false };

/** Segment indices in the order they fold into "…" (the last segment never does). */
export function foldOrder(count: number): number[] {
	if (count <= 1) return [];
	const order: number[] = [];
	for (let index = 1; index <= count - 3; index++) order.push(index);
	order.push(0);
	if (count >= 3) order.push(count - 2);
	return order;
}

/** Width of the trail that shows every segment not in `hidden`, with "…" in place of the folded run. */
export function trailWidth(input: Omit<PathFitInput, "available" | "lastLabel" | "minLabel">, hidden: ReadonlySet<number>): number {
	let width = 0;
	let items = 0;
	let afterMore = false;
	let moreShown = false;
	input.segments.forEach((segment, index) => {
		if (hidden.has(index)) {
			if (!moreShown) {
				// "…" takes the separator the first folded segment would have had.
				width += input.more + (items > 0 ? input.separator : 0);
				items += 1;
				moreShown = true;
			}
			afterMore = true;
			return;
		}
		width += segment + (items > 0 && !afterMore ? input.separator : 0);
		items += 1;
		afterMore = false;
	});
	return width + Math.max(0, items - 1) * input.gap;
}

export function fitPathBar(input: PathFitInput): PathFit {
	const { available, segments, lastLabel, minLabel } = input;
	const hidden = new Set<number>();
	if (trailWidth(input, hidden) <= available) return FITS;
	for (const index of foldOrder(segments.length)) {
		hidden.add(index);
		if (trailWidth(input, hidden) <= available) return { hidden: [...hidden].sort((a, b) => a - b), lastClip: null, overflow: false };
	}
	// Only "…" and the last segment are left: narrow the last label.
	const deficit = trailWidth(input, hidden) - available;
	const width = Math.floor(lastLabel - deficit);
	return {
		hidden: [...hidden].sort((a, b) => a - b),
		lastClip: Math.max(minLabel, width),
		overflow: width < minLabel,
	};
}

export function sameFit(a: PathFit, b: PathFit): boolean {
	return a.lastClip === b.lastClip && a.overflow === b.overflow && a.hidden.length === b.hidden.length && a.hidden.every((index, at) => b.hidden[at] === index);
}
