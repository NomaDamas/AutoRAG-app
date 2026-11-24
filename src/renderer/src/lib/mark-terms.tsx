import type { ReactElement } from "react";

/** The passage with every query term (two characters or more) wrapped in `<mark>`, for a snippet line. */
export function markTerms(snippet: string, query: string): ReactElement[] {
	const terms = query.trim().split(/\s+/u).filter((term) => term.length > 1).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	if (terms.length === 0) return [<span key="0">{snippet}</span>];
	const pattern = new RegExp(`(${terms.join("|")})`, "giu");
	return snippet.split(pattern).map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : <span key={index}>{part}</span>));
}

/**
 * A file name with every query term in bold, for the result list (Figma 428:1845): `계약서` in `2026-공급계약서.pdf`.
 * Unlike a snippet, a one-character term counts, since a name search matches it.
 */
export function emphasizeTerms(name: string, query: string): ReactElement | string {
	const terms = query.trim().split(/\s+/u).filter((term) => term.length > 0).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	if (terms.length === 0) return name;
	const pattern = new RegExp(`(${terms.join("|")})`, "giu");
	const parts = name.split(pattern);
	if (parts.length === 1) return name;
	return <>{parts.map((part, index) => (index % 2 === 1 ? <strong key={index} className="font-bold">{part}</strong> : part))}</>;
}
