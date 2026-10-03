/**
 * Path bar fitting (macOS Finder path bar). The bar is a single line and never
 * wraps. When the whole trail does not fit, segments give up their label one at
 * a time: a label first narrows behind a trailing fade, and once less than
 * `minLabel` of it would remain the segment drops to its icon and the next one
 * starts narrowing.
 *
 * Order, first to give up its label to last:
 *   1. the middle segments, left to right ("Users", the home folder, …);
 *   2. the root ("Macintosh HD");
 *   3. the parent of the last segment;
 *   4. the last segment — the current folder, or the selected file.
 */

export type SegmentFit =
	/** The whole label is shown. */
	| { readonly mode: "full" }
	/** The label slot is `width` px wide and fades out at its trailing edge. */
	| { readonly mode: "clip"; readonly width: number }
	/** Icon only. */
	| { readonly mode: "icon" };

export interface PathFitInput {
	/** Width the trail may occupy. */
	readonly available: number;
	/** Width of the trail with every label slot at zero: icons, padding, separators. */
	readonly fixed: number;
	/** Natural width of each label slot, in trail order. */
	readonly labels: readonly number[];
	/** Narrowest clipped slot still worth showing. */
	readonly minLabel: number;
}

export interface PathFit {
	readonly segments: readonly SegmentFit[];
	/** Even the icon-only trail is wider than `available`. */
	readonly overflow: boolean;
}

const FULL: SegmentFit = { mode: "full" };
const ICON: SegmentFit = { mode: "icon" };

/** Segment indices in the order they give up their label. */
export function collapseOrder(count: number): number[] {
	if (count <= 0) return [];
	const order: number[] = [];
	for (let index = 1; index <= count - 3; index++) order.push(index);
	order.push(0);
	if (count >= 3) order.push(count - 2);
	if (count >= 2) order.push(count - 1);
	return order;
}

export function fitPathBar({ available, fixed, labels, minLabel }: PathFitInput): PathFit {
	const segments: SegmentFit[] = labels.map(() => FULL);
	let deficit = labels.reduce((total, label) => total + label, fixed) - available;
	for (const index of collapseOrder(labels.length)) {
		if (deficit <= 0) break;
		const label = labels[index] ?? 0;
		const width = Math.floor(label - deficit);
		if (width >= minLabel) {
			segments[index] = { mode: "clip", width };
			return { segments, overflow: false };
		}
		segments[index] = ICON;
		deficit -= label;
	}
	return { segments, overflow: deficit > 0 };
}

export function sameFit(a: PathFit, b: PathFit): boolean {
	if (a.overflow !== b.overflow || a.segments.length !== b.segments.length) return false;
	return a.segments.every((segment, index) => {
		const other = b.segments[index];
		if (other === undefined || other.mode !== segment.mode) return false;
		return segment.mode !== "clip" || (other.mode === "clip" && other.width === segment.width);
	});
}
