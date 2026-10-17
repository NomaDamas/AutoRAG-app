/**
 * Evidence-panel view model (DESIGN.md §5 Evidence panel; handoff README §1).
 * Pure helpers for the citation-driven Evidence half: tile kind inference from
 * the evidence title, thumbs-up/down toggle state, and the reference toast copy.
 */

import { webUrl } from "../../../shared/fs-contract";
import { t } from "../../../shared/i18n/core";
import type { AnswerPhase, CitationEvidence } from "../../../shared/search-contract";
import { citedNumbers } from "./answer-markdown";
import { type FileKind, kindFromExtension } from "./kinds";

/**
 * A web evidence source (the model cited a page, not a file): its normalized
 * http(s) URL, opened in the OS browser instead of revealed in the Finder.
 */
export const evidenceSourceUrl = webUrl;

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

/**
 * Heading for an evidence entry. A local file's title is its file name, which
 * is what the user knows. A datasource result's derived title is the last path
 * segment of its virtual id (`/kakao/work/chunks/msg-1` -> `msg-1`), an opaque
 * chunk id that says nothing, so label it by where it came from instead:
 * `kakao · work`. Anything that is not a datasource virtual id keeps its title.
 */
export function evidenceHeading(title: string, source: string | null): string {
	if (source === null || !source.startsWith("/") || webUrl(source) !== null) return title;
	const [datasource, instance, surface] = source.split("/").filter((part) => part.length > 0);
	const opaque = surface === "chunks" || surface === "messages" || surface === "images";
	if (datasource === undefined || instance === undefined || !opaque) return title;
	return `${datasource} · ${instance}`;
}

/**
 * True when `source` names a local filesystem path rather than null, a web
 * URL (`http:`/`https:`), or an opaque datasource chunk/message/image id
 * (`/kakao/.../chunks/...`).
 */
export function isLocalEvidenceSource(source: string | null): source is string {
	if (source === null) return false;
	const trimmed = source.trim();
	if (trimmed === "" || webUrl(trimmed) !== null) return false;
	if (trimmed.startsWith("/")) {
		const [datasource, instance, surface] = trimmed.split("/").filter((part) => part.length > 0);
		if (
			datasource !== undefined &&
			instance !== undefined &&
			(surface === "chunks" || surface === "messages" || surface === "images")
		) {
			return false;
		}
	}
	return true;
}

/**
 * Gather every citation across all phases of a session (earlier turns and the
 * current turn's Quick/Deep phases) in chronological order.
 */
export function collectSessionEvidence(
	phases: readonly (AnswerPhase | null | undefined)[],
): readonly CitationEvidence[] {
	const items: CitationEvidence[] = [];
	for (const phase of phases) {
		if (phase === null || phase === undefined) continue;
		for (const entry of phase.evidence) {
			items.push(entry);
		}
	}
	return items;
}

/**
 * Unique local file paths from a session's evidence list, in first-seen order
 * (canonicalized by NFC for deduplication while keeping the first spelling).
 */
export function sessionEvidencePaths(evidence: readonly CitationEvidence[]): readonly string[] {
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const entry of evidence) {
		if (!isLocalEvidenceSource(entry.source)) continue;
		const trimmed = entry.source.trim();
		const key = trimmed.normalize("NFC");
		if (seen.has(key)) continue;
		seen.add(key);
		paths.push(trimmed);
	}
	return paths;
}

export interface TurnEvidencePhases {
	readonly quick: AnswerPhase | null;
	readonly deep: AnswerPhase | null;
}

export interface EvidenceSelectionSource {
	readonly turnIndex: number;
	readonly phase: "quick" | "deep";
}

/**
 * Merge a turn's primary and secondary phase evidence lists by citation number:
 * every entry from `primary` wins for its number, and any numbers present only
 * in `secondary` are kept so no citation chip in either phase of the turn is
 * left without an evidence tab.
 */
export function mergePhaseEvidence(
	primary: readonly CitationEvidence[],
	secondary: readonly CitationEvidence[],
): readonly CitationEvidence[] {
	if (secondary.length === 0) return primary;
	if (primary.length === 0) return secondary;
	const byNumber = new Map<number, CitationEvidence>();
	for (const item of secondary) byNumber.set(item.number, item);
	for (const item of primary) byNumber.set(item.number, item);
	return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/**
 * Resolve the evidence list the Inspector should show for a conversation's
 * turns (`turns`, oldest first) and an optional `source` (the turn and phase
 * whose citation chip the user clicked last).
 */
export function resolveActiveEvidence(
	turns: readonly TurnEvidencePhases[],
	source: EvidenceSelectionSource | null,
): readonly CitationEvidence[] {
	if (source !== null) {
		const turn = turns[source.turnIndex];
		if (turn !== undefined) {
			const primary = (source.phase === "quick" ? turn.quick?.evidence : turn.deep?.evidence) ?? [];
			const secondary = (source.phase === "quick" ? turn.deep?.evidence : turn.quick?.evidence) ?? [];
			const merged = mergePhaseEvidence(primary, secondary);
			if (merged.length > 0) return merged;
		}
	}
	for (let index = turns.length - 1; index >= 0; index -= 1) {
		const turn = turns[index];
		if (turn === undefined) continue;
		const merged = mergePhaseEvidence(turn.deep?.evidence ?? [], turn.quick?.evidence ?? []);
		if (merged.length > 0) return merged;
	}
	return [];
}

/** Confidence as a percentage, shown right of the source line; `null` when the librarian measured none. */
export function evidenceDetail(confidence: number | undefined): string | null {
	return confidence === undefined ? null : t("finderState.evidenceDetail", { percent: Math.round(confidence * 100) });
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
