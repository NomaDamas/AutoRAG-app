/**
 * Corrections the librarian made to the first answer the person had already read (`revise_answer`, AutoRAG#2186).
 *
 * The librarian splits the first answer into claims and corrects it claim by claim. Each correction names the claim as
 * the person read it (`original`) and what replaces it, so the app can show the change where it happened: the words
 * that were struck out, the words that replace them, and why. This module is the pure part: it applies the corrections
 * to the text, and cuts the text into the answer to draw and the changes to animate.
 *
 * Everything is plain strings: no DOM, no React. The main process, the panel and the inspector chat load it alike.
 */

export type AnswerRevisionOp = "confirm" | "retract" | "replace" | "add";

/** One correction, as the librarian's `revision` event carries it. Citations are the `[n]` numbers the person was shown. */
export interface AnswerRevision {
	readonly op: AnswerRevisionOp;
	/** The claim (`c1`, `c2`, …) of the first answer; absent for an addition. */
	readonly claimId?: string;
	/** The claim exactly as the person read it; absent for an addition. */
	readonly original?: string;
	/** What replaces the claim, or the added finding; absent for a confirmation or a retraction. */
	readonly replacement?: string;
	/** One line in the person's language: why. */
	readonly reason: string;
}

/** A confirmation says a claim holds. It changes nothing the person reads, so it is never drawn. */
export function isAnswerChange(revision: AnswerRevision): boolean {
	return revision.op !== "confirm";
}

const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s/u;

function lastLine(text: string): string {
	return text.slice(text.lastIndexOf("\n") + 1);
}

/** How an added finding joins the answer: on the next line after a list, after a blank line otherwise. */
function joiner(text: string, addition: string): string {
	if (text === "") return "";
	return LIST_ITEM.test(lastLine(text)) && LIST_ITEM.test(addition) ? "\n" : "\n\n";
}

/**
 * The span of `original` in `text` that has not been taken by an earlier correction, so two claims with the same words
 * are corrected one each. Returns null when the text no longer holds it.
 */
function locate(text: string, original: string, taken: readonly (readonly [number, number])[]): readonly [number, number] | null {
	let from = 0;
	for (;;) {
		const at = text.indexOf(original, from);
		if (at === -1) return null;
		const end = at + original.length;
		if (!taken.some(([start, stop]) => at < stop && end > start)) return [at, end];
		from = at + 1;
	}
}

interface Edit {
	readonly span: readonly [number, number];
	readonly revision: AnswerRevision;
}

/** Where each change that has a claim to point at lands in `text`, in the order the corrections were made. */
function claimEdits(text: string, revisions: readonly AnswerRevision[]): readonly Edit[] {
	const taken: (readonly [number, number])[] = [];
	const edits: Edit[] = [];
	for (const revision of revisions) {
		if (revision.op !== "replace" && revision.op !== "retract") continue;
		if (revision.original === undefined || revision.original === "") continue;
		const span = locate(text, revision.original, taken);
		if (span === null) continue;
		taken.push(span);
		edits.push({ span, revision });
	}
	return edits;
}

/** What follows `end` in `text` up to the next claim: the whitespace between two claims. */
function gapAfter(text: string, end: number): number {
	let cursor = end;
	while (cursor < text.length && /\s/u.test(text.charAt(cursor))) cursor += 1;
	return cursor;
}

/**
 * The first answer with every correction applied: a replaced claim is where it was, a retracted claim is gone with the
 * whitespace that separated it, an addition follows the rest. A correction whose original the text does not hold is
 * skipped, so the result is never something the librarian could not have produced.
 */
export function revisedAnswer(first: string, revisions: readonly AnswerRevision[]): string {
	const edits = [...claimEdits(first, revisions)].sort((a, b) => a.span[0] - b.span[0]);
	let out = "";
	let cursor = 0;
	for (const { span, revision } of edits) {
		out += first.slice(cursor, span[0]);
		if (revision.op === "replace") {
			out += revision.replacement ?? "";
			cursor = span[1];
		} else {
			cursor = gapAfter(first, span[1]);
		}
	}
	out += first.slice(cursor);
	out = out.trim();
	for (const revision of revisions) {
		if (revision.op !== "add" || revision.replacement === undefined || revision.replacement === "") continue;
		out += joiner(out, revision.replacement) + revision.replacement;
	}
	return out;
}

/**
 * What the librarian's final answer says after the corrected first answer, or null when it does not start with it.
 * The librarian appends a closing reply only when that reply cites evidence of its own, so a non-empty remainder is
 * something new the person has not read. Whitespace is ignored while matching: the librarian re-trims the answer.
 */
export function remainderAfterRevised(first: string, revisions: readonly AnswerRevision[], finalAnswer: string): string | null {
	const corrected = revisedAnswer(first, revisions);
	if (corrected === "" || corrected === first.trim()) return null;
	const want = corrected.replace(/\s+/gu, "");
	let matched = 0;
	let index = 0;
	while (index < finalAnswer.length && matched < want.length) {
		const char = finalAnswer.charAt(index);
		if (!/\s/u.test(char)) {
			if (char !== want.charAt(matched)) return null;
			matched += 1;
		}
		index += 1;
	}
	if (matched < want.length) return null;
	return finalAnswer.slice(index).trim();
}

/** A character the answer text cannot hold, wrapped around a change's number, so the renderer can find the change inside the text. */
export const REVISION_MARK = "\u0001";

/** One correction the renderer draws in place of its mark. */
export interface AnswerChange {
	readonly kind: "replace" | "retract" | "add";
	readonly claimId?: string;
	/** The words struck out, without the claim's own list mark; empty for an addition. */
	readonly deleted: string;
	/** The words that replace them; empty for a retraction. */
	readonly inserted: string;
	readonly reason: string;
}

export interface MarkedAnswer {
	/** The first answer with each correction swapped for `REVISION_MARK<index>REVISION_MARK`; the claim's own list mark stays. */
	readonly text: string;
	/** The corrections drawn, indexed by the number inside their mark, in the order they were made. */
	readonly changes: readonly AnswerChange[];
}

const LIST_MARK = /^(\s*(?:[-*+•]|\d+[.)])\s+)/u;

/** `- text` -> `["- ", "text"]`; a claim that is no list item has no mark. */
function splitListMark(claim: string): readonly [string, string] {
	const match = LIST_MARK.exec(claim);
	return match === null ? ["", claim] : [match[1] ?? "", claim.slice((match[1] ?? "").length)];
}

/**
 * The answer to draw: the first answer with each single-line correction replaced by a mark the renderer swaps for the
 * struck words, the new words, and the reason. A multi-line claim (a code block, a table) cannot hold a mark, so its
 * correction is written into the text and not marked: it is told in the correction's details only.
 */
export function markRevisedAnswer(first: string, revisions: readonly AnswerRevision[]): MarkedAnswer {
	const edits = claimEdits(first, revisions);
	const changes: AnswerChange[] = [];
	const slots = new Map<AnswerRevision, string>();
	const slot = (revision: AnswerRevision, deleted: string, inserted: string): string => {
		const mark = `${REVISION_MARK}${changes.length}${REVISION_MARK}`;
		changes.push({
			kind: revision.op as AnswerChange["kind"],
			...(revision.claimId === undefined ? {} : { claimId: revision.claimId }),
			deleted,
			inserted,
			reason: revision.reason,
		});
		return mark;
	};
	// Numbered in the order the corrections were made, which is the order `claimEdits` returns them.
	for (const { revision } of edits) {
		const original = revision.original ?? "";
		if (original.includes("\n")) continue;
		const written = splitListMark(revision.replacement ?? "")[1];
		slots.set(revision, slot(revision, splitListMark(original)[1], revision.op === "replace" ? written : ""));
	}

	let out = "";
	let cursor = 0;
	for (const { span, revision } of [...edits].sort((a, b) => a.span[0] - b.span[0])) {
		out += first.slice(cursor, span[0]);
		const mark = slots.get(revision);
		if (mark !== undefined) {
			out += splitListMark(revision.original ?? "")[0] + mark;
			cursor = span[1];
		} else if (revision.op === "replace") {
			out += revision.replacement ?? "";
			cursor = span[1];
		} else {
			cursor = gapAfter(first, span[1]);
		}
	}
	out = (out + first.slice(cursor)).trim();

	for (const revision of revisions) {
		const added = revision.replacement ?? "";
		if (revision.op !== "add" || added === "") continue;
		// An added finding is drawn as its own block (`AnswerRevisionMark`), so it takes no bullet of the list it follows.
		const body = splitListMark(added)[1];
		out += joiner(out, added) + (added.includes("\n") ? added : slot(revision, "", body));
	}
	return { text: out, changes };
}
