import type { MarkRect, TextRun } from "../../../preview/shared/text-marks";

export interface PdfSearchHit {
	/** 0-based PDF page index. */
	readonly pageIndex: number;
	/** Highlight boxes in page-space coordinates (scale 1, origin top-left). */
	readonly rects: readonly MarkRect[];
}

function charEdge(run: TextRun, offset: number): number {
	const edges = run.charX;
	if (edges !== undefined && edges.length === run.text.length + 1) return run.x + edges[offset]!;
	return run.x + (run.text.length === 0 ? 0 : (run.width * offset) / run.text.length);
}

/**
 * Finds EVERY case-insensitive occurrence of `query` within one page's `TextRun[]`
 * (including matches that span adjacent pdf.js text runs on the same line, such as
 * Hangul/Latin/digit splits) and returns one `PdfSearchHit` per match with exact
 * merged bounding rectangles in scale-1 page coordinates.
 */
export function findPageTextMatches(
	pageIndex: number,
	runs: readonly TextRun[],
	rawQuery: string,
	maxHitsPerPage = 200,
): readonly PdfSearchHit[] {
	const query = rawQuery.trim().replace(/\s+/gu, " ").toLowerCase();
	if (query.length === 0 || runs.length === 0) return [];

	// Build a flat searchable string with per-character mapping back to (runIndex, charOffset)
	// collapsing whitespace runs to a single space so PDF kerning/line-breaks match naturally.
	const chars: string[] = [];
	const runIds: number[] = [];
	const charOffsets: number[] = [];

	const pushSpaceIfNeeded = (runIdx: number, offset: number): void => {
		if (chars.length > 0 && chars.at(-1) !== " ") {
			chars.push(" ");
			runIds.push(runIdx);
			charOffsets.push(offset);
		}
	};

	for (let rIdx = 0; rIdx < runs.length; rIdx += 1) {
		const run = runs[rIdx]!;
		if (rIdx > 0) {
			const prev = runs[rIdx - 1]!;
			const sameLine = Math.abs(prev.y - run.y) < Math.max(4, prev.height * 0.6);
			const gap = run.x - (prev.x + prev.width);
			if (!sameLine || gap > Math.max(1.5, prev.height * 0.18)) {
				pushSpaceIfNeeded(rIdx - 1, Math.max(0, prev.text.length - 1));
			}
		}
		for (let i = 0; i < run.text.length; i += 1) {
			const ch = run.text[i]!;
			if (/\s/u.test(ch)) {
				pushSpaceIfNeeded(rIdx, i);
			} else {
				chars.push(ch.toLowerCase());
				runIds.push(rIdx);
				charOffsets.push(i);
			}
		}
	}

	const haystack = chars.join("");
	if (haystack.length === 0) return [];

	const hits: PdfSearchHit[] = [];
	let searchFrom = 0;
	while (hits.length < maxHitsPerPage) {
		const start = haystack.indexOf(query, searchFrom);
		if (start < 0) break;
		const end = start + query.length;
		searchFrom = start + query.length;

		// Group matched character indices by run so each run produces one box,
		// then merge contiguous boxes on the same baseline.
		const spansByRun = new Map<number, { start: number; end: number }>();
		for (let k = start; k < end; k += 1) {
			if (chars[k] === " ") continue;
			const rIdx = runIds[k]!;
			const offset = charOffsets[k]!;
			const existing = spansByRun.get(rIdx);
			if (existing === undefined) {
				spansByRun.set(rIdx, { start: offset, end: offset + 1 });
			} else {
				existing.start = Math.min(existing.start, offset);
				existing.end = Math.max(existing.end, offset + 1);
			}
		}

		const rects: MarkRect[] = [];
		const orderedRuns = [...spansByRun.entries()].sort((a, b) => a[0] - b[0]);
		for (const [rIdx, span] of orderedRuns) {
			const run = runs[rIdx]!;
			const left = charEdge(run, span.start);
			const right = charEdge(run, span.end);
			const width = Math.max(2, right - left);
			const rect: MarkRect = { x: left, y: run.y, width, height: Math.max(4, run.height) };
			const last = rects.at(-1);
			if (
				last !== undefined &&
				Math.abs(last.y - rect.y) < 3 &&
				Math.abs(last.height - rect.height) < 3 &&
				rect.x >= last.x - 2 &&
				rect.x <= last.x + last.width + rect.height
			) {
				rects[rects.length - 1] = {
					...last,
					width: Math.max(last.x + last.width, rect.x + rect.width) - last.x,
				};
			} else {
				rects.push(rect);
			}
		}

		if (rects.length > 0) {
			hits.push({ pageIndex, rects });
		}
	}

	return hits;
}
