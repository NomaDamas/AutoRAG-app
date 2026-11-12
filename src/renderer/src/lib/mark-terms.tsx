import type { ReactElement } from "react";

/** The passage with every query term (two characters or more) wrapped in `<mark>`, for a snippet line. */
export function markTerms(snippet: string, query: string): ReactElement[] {
	const terms = query.trim().split(/\s+/u).filter((term) => term.length > 1).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	if (terms.length === 0) return [<span key="0">{snippet}</span>];
	const pattern = new RegExp(`(${terms.join("|")})`, "giu");
	return snippet.split(pattern).map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : <span key={index}>{part}</span>));
}
