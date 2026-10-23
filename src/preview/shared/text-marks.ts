import { buildTextIndex, locateExcerpt } from "./locate";

/**
 * Where an evidence excerpt is on a paged document, as boxes to draw over the
 * pages. A viewer hands over its text runs per page (pdf.js items, rhwp
 * runs) in page units with a top-left origin, the same units its page boxes
 * use, so a mark scales with the page like the drawing under it.
 */

export interface TextRun {
	readonly text: string;
	readonly x: number;
	/** Top of the run's box. */
	readonly y: number;
	readonly width: number;
	readonly height: number;
	/**
	 * Left edge of every character relative to `x` plus the run's right edge
	 * (`text.length + 1` values), when the viewer knows them; otherwise the
	 * characters share the width evenly.
	 */
	readonly charX?: readonly number[];
}

export interface MarkRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface PageMarks {
	readonly page: number;
	readonly rects: readonly MarkRect[];
}

export interface LocatedMarks extends PageMarks {
	/** Which excerpt matched: the first one, in order, the document contains. */
	readonly excerpt: number;
	/** Pages after `page` the same excerpt continues on. */
	readonly next: readonly PageMarks[];
}

function charEdge(run: TextRun, offset: number): number {
	const edges = run.charX;
	if (edges !== undefined && edges.length === run.text.length + 1) return run.x + edges[offset]!;
	return run.x + (run.text.length === 0 ? 0 : (run.width * offset) / run.text.length);
}

export function locateMarks(pages: readonly (readonly TextRun[])[], excerpts: readonly string[]): LocatedMarks | null {
	const runs = pages.flatMap((page, index) => page.map((run) => ({ page: index, run })));
	if (runs.length === 0) return null;
	const index = buildTextIndex(runs.map((entry) => entry.run.text));
	for (const [excerpt, text] of excerpts.entries()) {
		const located = locateExcerpt(index, text);
		if (located === null) continue;
		const byPage = new Map<number, MarkRect[]>();
		for (const range of located.ranges) {
			const { page, run } = runs[range.piece]!;
			const left = charEdge(run, range.start);
			const rect = { x: left, y: run.y, width: charEdge(run, range.end) - left, height: run.height };
			const rects = byPage.get(page) ?? [];
			const last = rects.at(-1);
			// Hangul and ASCII digits split into separate runs on the same line; join them so no seam shows between them.
			if (last !== undefined && Math.abs(last.y - rect.y) < 2 && Math.abs(last.height - rect.height) < 2 && rect.x >= last.x && rect.x <= last.x + last.width + rect.height) {
				rects[rects.length - 1] = { ...last, width: Math.max(last.x + last.width, rect.x + rect.width) - last.x };
			} else {
				rects.push(rect);
			}
			byPage.set(page, rects);
		}
		const [first, ...rest] = [...byPage.entries()].map(([page, rects]) => ({ page, rects }));
		if (first === undefined) continue;
		return { ...first, excerpt, next: rest };
	}
	return null;
}

/** The fields of a pdf.js `TextItem` a mark needs; marked-content entries carry no `str`. */
interface PdfTextItem {
	readonly str: string;
	readonly transform: readonly number[];
	readonly width: number;
	readonly height: number;
}

function isPdfTextItem(item: unknown): item is PdfTextItem {
	return typeof item === "object" && item !== null && "str" in item && typeof item.str === "string" && "transform" in item && Array.isArray(item.transform);
}

/**
 * pdf.js text items as runs. `viewport` is the page viewport's transform at
 * scale 1, which flips PDF space (origin bottom-left, y up) into the page's
 * top-left units and applies the page's rotation; an item's box runs from
 * 82% of the font size above the baseline to 22% below it.
 */
export function pdfRuns(items: readonly unknown[], viewport: readonly number[]): readonly TextRun[] {
	const [a, b, c, d, e, f] = viewport as [number, number, number, number, number, number];
	const runs: TextRun[] = [];
	for (const item of items) {
		if (!isPdfTextItem(item) || item.str.length === 0) continue;
		const [ia, ib, ic, id, ix, iy] = item.transform as [number, number, number, number, number, number];
		// The item's transform composed with the viewport's: device-space matrix of the glyph run.
		const ma = a * ia + c * ib;
		const mb = b * ia + d * ib;
		const mc = a * ic + c * id;
		const md = b * ic + d * id;
		const x = a * ix + c * iy + e;
		const y = b * ix + d * iy + f;
		const size = Math.hypot(mc, md);
		const angle = Math.atan2(mb, ma);
		if (Math.abs(angle) < 1e-3) {
			const width = item.width * Math.hypot(a, b);
			runs.push({ text: item.str, x, y: y - size * 0.82, width, height: size * 1.04 });
			continue;
		}
		// A rotated run: its axis-aligned bounding box, characters spread evenly along it.
		const length = item.width * Math.hypot(a, b);
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);
		const xs = [x, x + length * cos, x + size * sin, x + length * cos + size * sin];
		const ys = [y, y + length * sin, y - size * cos, y + length * sin - size * cos];
		const left = Math.min(...xs);
		const top = Math.min(...ys);
		runs.push({ text: item.str, x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top });
	}
	return runs;
}

/**
 * 0-based line indices of the first excerpt `text` contains (including blank
 * lines between matched lines); empty when none of `excerpts` is found.
 */
export function locateLines(text: string, excerpts: readonly string[]): ReadonlySet<number> {
	const lines = text.split("\n");
	const index = buildTextIndex(lines);
	for (const excerpt of excerpts) {
		const located = locateExcerpt(index, excerpt);
		if (located === null || located.ranges.length === 0) continue;
		const first = located.ranges[0]!.piece;
		const last = located.ranges.at(-1)!.piece;
		const pieces = new Set(located.ranges.map((range) => range.piece));
		const matched = new Set<number>();
		for (let line = first; line <= last; line += 1) {
			if (pieces.has(line) || lines[line]?.trim() === "") matched.add(line);
		}
		return matched;
	}
	return new Set();
}
