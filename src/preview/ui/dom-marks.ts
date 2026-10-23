import { buildTextIndex, locateExcerpt } from "../shared/locate";

/** The name `::highlight()` styles in quick-look.css. */
export const EVIDENCE_HIGHLIGHT = "ql-evidence";

function textNodes(root: Node): Text[] {
	const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node as Text);
	return nodes;
}

/**
 * Where the first excerpt `root`'s rendered text contains is, as DOM ranges in
 * document order. The text nodes are the pieces the shared matcher compares
 * against, so markup between them (cells, list items, emphasis) never breaks a
 * match; the excerpt may still be raw Markdown.
 */
export function locateDomRanges(root: HTMLElement, excerpts: readonly string[]): readonly Range[] {
	const nodes = textNodes(root);
	if (nodes.length === 0) return [];
	const index = buildTextIndex(nodes.map((node) => node.data));
	for (const excerpt of excerpts) {
		const located = locateExcerpt(index, excerpt);
		if (located === null || located.ranges.length === 0) continue;
		const last = located.ranges.length - 1;
		return located.ranges.map(({ piece, start, end }, order) => {
			const node = nodes[piece]!;
			// Spaces beside inline markup sit in the neighbouring text node; paint those between two marked pieces so the mark has no seam.
			const from = order > 0 && node.data.slice(0, start).trim() === "" ? 0 : start;
			const to = order < last && node.data.slice(end).trim() === "" ? node.data.length : end;
			const range = root.ownerDocument!.createRange();
			range.setStart(node, from);
			range.setEnd(node, to);
			return range;
		});
	}
	return [];
}

/** Paints `ranges` with the evidence tint; returns what removes them again. A runtime without the Highlight API paints nothing. */
export function paintDomRanges(ranges: readonly Range[]): () => void {
	if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined" || ranges.length === 0) return () => undefined;
	const highlight = new Highlight(...ranges);
	CSS.highlights.set(EVIDENCE_HIGHLIGHT, highlight);
	return () => {
		if (CSS.highlights.get(EVIDENCE_HIGHLIGHT) === highlight) CSS.highlights.delete(EVIDENCE_HIGHLIGHT);
	};
}

/** Scrolls `scroller` so `range` sits a quarter of the way down it. */
export function scrollRangeIntoView(scroller: HTMLElement, range: Range): void {
	const box = range.getBoundingClientRect();
	const bounds = scroller.getBoundingClientRect();
	scroller.scrollTop = Math.max(0, scroller.scrollTop + box.top - bounds.top - scroller.clientHeight * 0.25);
}
