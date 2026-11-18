/**
 * What the renderer needs to draw the librarian's corrections of the Quick answer (`revision` events, AutoRAG#2186).
 * The cutting of the text is the shared core's (`shared/answer-revision.ts`); this is the renderer's side of it:
 * whether there is anything to draw, and how a line that holds a correction's mark falls apart into text and changes.
 */

import { isAnswerChange, markRevisedAnswer, REVISION_MARK, type AnswerChange, type AnswerRevision } from "../../../shared/answer-revision";
import type { AnswerPhase, CitationEvidence } from "../../../shared/search-contract";
import { citedNumbers } from "./answer-markdown";
import { mergePhaseEvidence, unresolvedCitationNumbers } from "./evidence";

/** The Quick answer's text with a mark where each correction goes, and the corrections the marks stand for. */
export interface QuickAnswerMarks {
	readonly text: string;
	readonly changes: readonly AnswerChange[];
}

/**
 * The Quick answer to draw, or null when the corrections change nothing the person reads (none, or only
 * confirmations), so the answer is drawn as it always was.
 */
export function markQuickAnswer(answer: string, revisions: readonly AnswerRevision[]): QuickAnswerMarks | null {
	if (!revisions.some(isAnswerChange)) return null;
	const marked = markRevisedAnswer(answer, revisions);
	return marked.changes.length === 0 ? null : marked;
}

/** One piece of a line: words as they are, or the correction (by its index in {@link QuickAnswerMarks.changes}) drawn there. */
export type RevisionPiece = { readonly text: string } | { readonly change: number };

const MARK = new RegExp(`${REVISION_MARK}(\\d+)${REVISION_MARK}`, "gu");

/** Cut a line at its marks. A line without one comes back whole. */
export function splitRevisionMarks(line: string): readonly RevisionPiece[] {
	const pieces: RevisionPiece[] = [];
	let cursor = 0;
	for (const match of line.matchAll(MARK)) {
		const index = match.index ?? 0;
		if (index > cursor) pieces.push({ text: line.slice(cursor, index) });
		pieces.push({ change: Number(match[1]) });
		cursor = index + match[0].length;
	}
	if (cursor < line.length) pieces.push({ text: line.slice(cursor) });
	return pieces.length === 0 ? [{ text: line }] : pieces;
}

/**
 * The words a marked answer cites: the text with each mark replaced by the new words that stand in its place. A struck
 * claim's citations are not among them, so they are neither counted nor looked up.
 */
export function markedCitationText(marked: QuickAnswerMarks): string {
	return marked.text.replace(MARK, (_whole, index: string) => marked.changes[Number(index)]?.inserted ?? "");
}

/** A corrected Quick answer, ready to draw. */
export interface QuickAnswerDraw extends QuickAnswerMarks {
	/** Citation numbers with nothing to open: they are left out of the drawing. */
	readonly unresolved: readonly number[];
	/** The sources the answer's chips open. */
	readonly evidence: readonly CitationEvidence[];
	/** The sources the corrections brought in: cited by their new words, not by the answer the person first read. */
	readonly fresh: readonly number[];
}

/**
 * The sources a correction newly cites: the numbers its new words cite that the first answer did not and that have
 * something to open. A source the first answer already showed is not new however often a correction cites it again.
 */
export function newCitationNumbers(firstAnswer: string, changes: readonly AnswerChange[], evidence: readonly { readonly number: number }[]): readonly number[] {
	const had = new Set(citedNumbers(firstAnswer));
	const known = new Set(evidence.map((item) => item.number));
	const added = new Set<number>();
	for (const change of changes) {
		for (const number of citedNumbers(change.inserted)) {
			if (!had.has(number) && known.has(number)) added.add(number);
		}
	}
	return [...added].sort((a, b) => a - b);
}

/**
 * The Quick answer as the person should read it once the librarian has corrected it, or null when nothing was
 * corrected. Its chips open the sources of the first answer and those the final answer sent for the new citations
 * (a source keeps its number for the whole conversation, so the two lists never disagree on one).
 */
export function drawQuickAnswer(quick: AnswerPhase | null, deep: AnswerPhase | null, revisions: readonly AnswerRevision[]): QuickAnswerDraw | null {
	if (quick === null) return null;
	const marked = markQuickAnswer(quick.answer, revisions);
	if (marked === null) return null;
	const evidence = mergePhaseEvidence(deep?.evidence ?? [], quick.evidence);
	return { ...marked, evidence, unresolved: unresolvedCitationNumbers(markedCitationText(marked), evidence), fresh: newCitationNumbers(quick.answer, marked.changes, evidence) };
}
