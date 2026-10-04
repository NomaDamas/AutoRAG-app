/**
 * Multi-selection model for the Inspector's Info panel: when more than one
 * entry is selected the panel stops showing the last-focused file and instead
 * summarizes the set — the paper-stack cards up top, then "<n>개 항목", the
 * per-kind breakdown with the total size, and created/modified date ranges.
 *
 * Everything here is pure over the row model; the component only renders.
 */

import type { FinderEntry } from "../data/entries";
import { formatSize } from "./format";

/** The fan shows at most this many papers; the rest of the selection is implied. */
export const STACK_CARD_MAX = 5;
/** Kind breakdown keeps at most this many groups before folding the tail into 외 N종. */
const KIND_GROUP_MAX = 2;

export interface SelectionSummary {
	readonly count: number;
	/** "2개 항목" — the panel title. */
	readonly title: string;
	/** "PDF document 2개" or "PDF document 2개, JPEG image 1개"; long tails fold into 외 N종. */
	readonly kindSummary: string;
	/** Byte total over files; folders contribute nothing. */
	readonly totalBytes: number;
	/** formatSize of the total, or null when the selection holds no file (all folders). */
	readonly sizeLabel: string | null;
	/** "2026-09-28 – 2026-10-03", one date for a shared day, null when no entry knows. */
	readonly createdRange: string | null;
	readonly modifiedRange: string | null;
}

/** Local calendar day, "2026-10-03". */
function formatDate(ms: number): string {
	const date = new Date(ms);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * min–max over the real stamps (unparseable zeros and absent values drop
 * out). One shared calendar day collapses to a single date, like Finder.
 */
export function dateRangeLabel(values: readonly number[]): string | null {
	const real = values.filter((value) => Number.isFinite(value) && value > 0);
	if (real.length === 0) return null;
	const first = formatDate(Math.min(...real));
	const last = formatDate(Math.max(...real));
	return first === last ? first : `${first} – ${last}`;
}

/** "<label> <n>개" groups, most numerous first (labels break ties), tail folded. */
function kindSummary(entries: readonly FinderEntry[]): string {
	const counts = new Map<string, number>();
	for (const entry of entries) {
		counts.set(entry.kindLabel, (counts.get(entry.kindLabel) ?? 0) + 1);
	}
	const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"));
	const shown = groups.slice(0, KIND_GROUP_MAX).map(([label, count]) => `${label} ${count}개`);
	const rest = groups.length - shown.length;
	return rest > 0 ? `${shown.join(", ")}, 외 ${rest}종` : shown.join(", ");
}

export function summarizeSelection(entries: readonly FinderEntry[]): SelectionSummary {
	const totalBytes = entries.reduce((sum, entry) => sum + (entry.kind === "file" ? entry.sizeValue : 0), 0);
	const hasFile = entries.some((entry) => entry.kind === "file");
	return {
		count: entries.length,
		title: `${entries.length}개 항목`,
		kindSummary: kindSummary(entries),
		totalBytes,
		sizeLabel: hasFile ? formatSize(totalBytes) : null,
		createdRange: dateRangeLabel(entries.flatMap((entry) => (entry.createdValue === undefined ? [] : [entry.createdValue]))),
		modifiedRange: dateRangeLabel(entries.map((entry) => entry.modifiedValue)),
	};
}

/**
 * The papers to fan, front first: the focused entry leads, the rest follow in
 * visual (list) order. Capped at STACK_CARD_MAX; the component renders the
 * array in reverse so the front card lands on top of the DOM stack.
 */
export function stackCards(
	entries: readonly FinderEntry[],
	focusPath: string | null,
	max = STACK_CARD_MAX,
): readonly FinderEntry[] {
	if (entries.length === 0) return [];
	const focused = focusPath === null ? undefined : entries.find((entry) => entry.path === focusPath);
	const ordered = focused === undefined ? entries : [focused, ...entries.filter((entry) => entry !== focused)];
	return ordered.slice(0, Math.max(1, max));
}
