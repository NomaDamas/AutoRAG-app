import search from "approx-string-match";

/**
 * Finds an AI Search evidence excerpt in a document the preview has open.
 *
 * The excerpt is chunk text from the indexer's parse (markdown, tables as GFM
 * or HTML, whitespace collapsed, cut at 400 characters), while the viewer has
 * its own text: pdf.js items, rhwp runs, or source lines. Both sides are
 * compared as a key of letters and digits only (grapheme-wise NFKC, lower
 * case), so spacing, punctuation, markup, full-width forms, and decomposed
 * Hangul do not matter. The excerpt is split where its markup breaks the
 * reading order (table cells, lines, `...` elisions); each long segment is
 * found exactly or, failing that, with up to 20% edit errors (Myers'
 * bit-parallel search), and the result is the cluster of segment matches
 * around the best anchor. Short segments only join a cluster, exactly and
 * nearby, because on their own they match too much.
 *
 * Measured on real Dazzi evidence (2026-10): 95.7% of PDF excerpts and 98.6%
 * of HWP excerpts with document text were found; a match takes under 1 ms
 * (p95 0.37 ms) once the viewer's text is extracted.
 */

/** A span of one viewer text piece, in that piece's own UTF-16 offsets (end exclusive). */
export interface LocatedRange {
	readonly piece: number;
	readonly start: number;
	readonly end: number;
}

export interface LocatedExcerpt {
	/** In document order; adjacent segment matches are merged. */
	readonly ranges: readonly LocatedRange[];
	/** Share of the excerpt's letters and digits that matched, edits subtracted (0..1]. */
	readonly score: number;
}

/** The viewer's text pieces as one comparison key, with each key unit's source span. */
export interface TextIndex {
	readonly key: string;
	readonly starts: Int32Array;
	readonly ends: Int32Array;
	/** Key offset where each piece begins; an empty piece begins where the next one does. */
	readonly pieceStarts: Int32Array;
}

/** Segments shorter than this never anchor a match. */
const MIN_ANCHOR = 8;
const MAX_ERROR_RATE = 0.2;
/** Occurrences considered per segment; a repeated phrase beyond this is not worth ranking. */
const MAX_HITS = 64;
/** A segment joins the anchor's cluster only this close to it (key units), or 3× the excerpt. */
const MIN_WINDOW = 600;
/** Accept a cluster covering this share of the excerpt, or this many key units outright. */
const MIN_COVERAGE = 0.4;
const MIN_COVERED = 40;

const WORD = /[\p{L}\p{N}]/u;
const ASCII = /^[\x00-\x7f]*$/;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Calls `emit` for each key code point with the source span of the grapheme it came from. */
function normalize(text: string, emit: (char: string, start: number, end: number) => void): void {
	if (ASCII.test(text)) {
		for (let index = 0; index < text.length; index += 1) {
			const code = text.charCodeAt(index);
			if ((code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39)) emit(text[index]!, index, index + 1);
			else if (code >= 0x41 && code <= 0x5a) emit(String.fromCharCode(code + 0x20), index, index + 1);
		}
		return;
	}
	for (const { segment, index } of graphemes.segment(text)) {
		for (const char of segment.normalize("NFKC").toLowerCase()) {
			if (WORD.test(char)) emit(char, index, index + segment.length);
		}
	}
}

export function buildTextIndex(pieces: readonly string[]): TextIndex {
	const parts: string[] = [];
	const starts: number[] = [];
	const ends: number[] = [];
	const pieceStarts = new Int32Array(pieces.length);
	pieces.forEach((piece, index) => {
		pieceStarts[index] = starts.length;
		normalize(piece, (char, start, end) => {
			parts.push(char);
			// An astral character is two key units; both point at its grapheme.
			for (let unit = 0; unit < char.length; unit += 1) {
				starts.push(start);
				ends.push(end);
			}
		});
	});
	return { key: parts.join(""), starts: Int32Array.from(starts), ends: Int32Array.from(ends), pieceStarts };
}

/** An absolute path: the citation names the file, not a passage in it. */
const BARE_PATH = /^(?:~?\/|[A-Za-z]:[\\/])(?:[^\n\\/]*[\\/])+[^\n\\/]*$/;
/** Where an excerpt's markup breaks the reading order. */
const SEGMENT_BREAK = /\n|\||\.{3}|…|\s\/\s|(?:^|\s)#{1,6}\s|-{3,}/;

function excerptSegments(excerpt: string): readonly string[] {
	const text = excerpt
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "\n")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/<[^>]*>/g, "\n");
	const segments: string[] = [];
	for (const part of text.split(SEGMENT_BREAK)) {
		let key = "";
		normalize(part, (char) => {
			key += char;
		});
		if (key.length > 0) segments.push(key);
	}
	return segments;
}

interface Hit {
	readonly start: number;
	readonly end: number;
	readonly errors: number;
}

function segmentHits(key: string, segment: string): readonly Hit[] {
	const hits: Hit[] = [];
	for (let at = key.indexOf(segment); at >= 0 && hits.length < MAX_HITS; at = key.indexOf(segment, at + 1)) {
		hits.push({ start: at, end: at + segment.length, errors: 0 });
	}
	if (hits.length > 0 || segment.length < MIN_ANCHOR) return hits;
	return search(key, segment, Math.floor(segment.length * MAX_ERROR_RATE)).slice(0, MAX_HITS);
}

function distance(a: Hit, b: Hit): number {
	return Math.max(0, b.start - a.end, a.start - b.end);
}

/** The largest piece whose start is at or before key offset `at`. */
function pieceAt(index: TextIndex, at: number): number {
	let low = 0;
	let high = index.pieceStarts.length - 1;
	while (low < high) {
		const middle = (low + high + 1) >> 1;
		if (index.pieceStarts[middle]! <= at) low = middle;
		else high = middle - 1;
	}
	return low;
}

function toRanges(index: TextIndex, hits: readonly Hit[]): readonly LocatedRange[] {
	const merged: { start: number; end: number }[] = [];
	for (const hit of [...hits].sort((a, b) => a.start - b.start)) {
		const last = merged.at(-1);
		if (last !== undefined && hit.start <= last.end) last.end = Math.max(last.end, hit.end);
		else merged.push({ start: hit.start, end: hit.end });
	}
	const ranges: LocatedRange[] = [];
	for (const span of merged) {
		let at = span.start;
		for (let piece = pieceAt(index, at); at < span.end; piece += 1) {
			const pieceEnd = piece + 1 < index.pieceStarts.length ? index.pieceStarts[piece + 1]! : index.key.length;
			const stop = Math.min(span.end, pieceEnd);
			if (stop > at) ranges.push({ piece, start: index.starts[at]!, end: index.ends[stop - 1]! });
			at = Math.max(at, stop);
		}
	}
	return ranges;
}

/** Where `excerpt` is in the indexed text, or null when it is not there with enough confidence. */
export function locateExcerpt(index: TextIndex, excerpt: string): LocatedExcerpt | null {
	if (index.key.length === 0 || BARE_PATH.test(excerpt.trim())) return null;
	const segments = excerptSegments(excerpt).map((segment) => ({ length: segment.length, hits: segmentHits(index.key, segment) }));
	const total = segments.reduce((sum, segment) => sum + segment.length, 0);
	if (total === 0) return null;
	const window = Math.max(MIN_WINDOW, total * 3);

	let best: { readonly covered: number; readonly gap: number; readonly hits: readonly Hit[] } | null = null;
	segments.forEach((anchorSegment, anchorIndex) => {
		if (anchorSegment.length < MIN_ANCHOR) return;
		for (const anchor of anchorSegment.hits) {
			const hits: Hit[] = [];
			let covered = 0;
			segments.forEach((segment, index) => {
				let pick: Hit | null = index === anchorIndex ? anchor : null;
				if (pick === null) {
					for (const hit of segment.hits) {
						const away = distance(anchor, hit);
						if (away <= window && (pick === null || away < distance(anchor, pick))) pick = hit;
					}
				}
				if (pick === null) return;
				hits.push(pick);
				covered += segment.length - pick.errors;
			});
			const span = Math.max(...hits.map((hit) => hit.end)) - Math.min(...hits.map((hit) => hit.start));
			const gap = Math.max(0, span - hits.reduce((sum, hit) => sum + hit.end - hit.start, 0));
			if (best === null || covered > best.covered || (covered === best.covered && gap < best.gap)) best = { covered, gap, hits };
		}
	});
	if (best === null) return null;
	const { covered, hits } = best;
	if (covered < total * MIN_COVERAGE && covered < MIN_COVERED) return null;
	return { ranges: toRanges(index, hits), score: covered / total };
}
