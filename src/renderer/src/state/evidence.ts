/**
 * Evidence-panel view model (DESIGN.md §5 Evidence panel; handoff README §1).
 * Pure helpers for the citation-driven Evidence half: tile kind inference from
 * the evidence title, thumbs-up/down toggle state, and the reference toast copy.
 */

import { webUrl } from "../../../shared/fs-contract";
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

/** Confidence as a percentage, shown right of the source line; `null` when the librarian measured none. */
export function evidenceDetail(confidence: number | undefined): string | null {
	return confidence === undefined ? null : `관련도 ${Math.round(confidence * 100)}%`;
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
