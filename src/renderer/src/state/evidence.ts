/**
 * Evidence-panel view model (DESIGN.md §5 Evidence panel; handoff README §1).
 * Pure helpers for the citation-driven Evidence half: tile kind inference from
 * the evidence title, thumbs-up/down toggle state, and the reference toast copy.
 */

import { citedNumbers } from "./answer-markdown";
import { type FileKind, kindFromExtension } from "./kinds";

/**
 * Cited numbers in an answer that have no matching evidence entry. The
 * librarian's verification phase may cite the fast answer's numbered units, so
 * an answer can reference `[n]` values absent from its own `results`
 * (Marker-Inc-Korea/AutoRAG#1788); the renderer drops those markers instead of
 * leaving a dead citation that could open an unrelated result.
 */
export function unresolvedCitationNumbers(answer: string, evidence: readonly { readonly number: number }[]): readonly number[] {
	const known = new Set(evidence.map((entry) => entry.number));
	return citedNumbers(answer).filter((number) => !known.has(number));
}

/** Prefer the exact path; otherwise resolve NFC/NFD spelling to the listing's real identity. */
export function findEvidenceSource<T extends { readonly path: string }>(entries: readonly T[], source: string): T | undefined {
	const exact = entries.find((entry) => entry.path === source);
	if (exact !== undefined) return exact;
	const normalized = source.normalize("NFC");
	return entries.find((entry) => entry.path.normalize("NFC") === normalized);
}

/** Confidence as a percentage, shown right of the source line. */
export function evidenceDetail(confidence: number): string {
	return `관련도 ${Math.round(confidence * 100)}%`;
}

const EXTENSION = /\.([A-Za-z0-9]{1,6})$/u;

/**
 * Tile kind for an evidence entry: the title is the file name for local
 * results; datasource titles (subjects, page names) fall back to the
 * generic document tile.
 */
export function evidenceKind(title: string): FileKind {
	const match = EXTENSION.exec(title.trim());
	return match === null ? "md" : kindFromExtension(match[1]?.toLowerCase() ?? "");
}

export type EvidenceFeedback = "up" | "down" | null;

/** Toggle per the reference: same vote clears it; the opposite side replaces it. */
export function nextEvidenceFeedback(current: EvidenceFeedback, pick: "up" | "down"): EvidenceFeedback {
	return current === pick ? null : pick;
}

/** Reference toast copy (`proto:1197`, strip when the vote clears). */
export function feedbackToastText(number: number, value: "up" | "down"): string {
	return value === "up"
		? `근거 ${number} — 도움이 됨으로 기록했습니다`
		: `근거 ${number} — 다음 검색부터 우선순위를 낮춥니다`;
}
