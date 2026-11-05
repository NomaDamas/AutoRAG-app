import { posix } from "node:path";
import type { MinsyncJournalTally } from "../shared/index-progress";
import { isJsonObject } from "../shared/settings-contract";

/**
 * Reading MinSync's crash-resume log, `.autorag/minsync/.minsync/progress.jsonl`.
 *
 * This is MinSync's private interrupted-run format (the librarian's docs say AutoRAG does not read it), read only to
 * draw the progress display, and little of it has been observed: the header and the `committed` lines were measured
 * with MinSync 0.6.1 and no other version, the `failed` and `deleted` lines were not seen in a real run, and the
 * supported floor, 0.6.0, was not measured. Anything unrecognized is skipped, and the display falls back to the counts
 * MinSync writes into `refresh-progress.json`.
 *
 * Measured with MinSync 0.6.1: line 1 is a run header
 * (`{"format":3,"source_id":...,"stage":"vector","run_token":...,"full":true,"created_at":...}`), and every
 * following line is one file whose work is durable:
 * `{"item":"files/Users/me/a.pdf.md","version":"sha256:...","outcome":"committed"}`, with `outcome` one of
 * `committed`, `deleted`, `failed` (plus `error`) or, from the stage protocol, `skipped`. The log carries no
 * sizes and no timestamps; the item is the parsed document under the MinSync workspace, so its size is the size of
 * the staged `.md` file. The log is removed when a sync finishes and resumed (records carried over) when one
 * is interrupted, so a file's last record is its state.
 */

export const MINSYNC_JOURNAL_PARTS = [".autorag", "minsync", ".minsync", "progress.jsonl"] as const;

type Outcome = "committed" | "deleted" | "failed";

function outcomeOf(record: Record<string, unknown>): Outcome | null {
	const { outcome } = record;
	if (outcome === "committed" || outcome === "deleted" || outcome === "failed") return outcome;
	// Logs written before outcomes existed: a record with a version is a completion, without one a deletion.
	if (outcome === undefined) return typeof record.version === "string" ? "committed" : "deleted";
	return null;
}

/** `files/Users/me/docs/a.pdf.md` -> `a.pdf`: the name of the user's file, not of its parsed copy. */
export function journalItemName(item: string): string {
	const name = posix.basename(item.replaceAll("\\", "/"));
	return name.endsWith(".md") && name.length > 3 ? name.slice(0, -3) : name;
}

/**
 * Tally the log. A torn last line (the process was killed mid-append) and any line that is not a record are
 * ignored: this is only a display, so a bad line must never hide the rest.
 * `sizeOf` maps an item to the size of its parsed document; without it the tally carries no bytes. A committed file whose
 * size it cannot give (not staged when the sizes were read) leaves the figure unknown: adding it as 0 would show "0 B of X"
 * for work that was done.
 */
export function tallyMinsyncJournal(
	text: string,
	options: { readonly sizeOf?: ((item: string) => number | undefined) | undefined; readonly modifiedAt?: number | null | undefined } = {},
): MinsyncJournalTally {
	const latest = new Map<string, Outcome>();
	let lastCommitted: string | null = null;
	let lastAny: string | null = null;
	let first = true;
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		if (first) {
			first = false;
			// Line 1 is the header. A log whose first line already is a record (very old format) has no header.
			if (!line.includes('"item"')) continue;
		}
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isJsonObject(record) || typeof record.item !== "string") continue;
		const outcome = outcomeOf(record);
		if (outcome === null) continue;
		latest.set(record.item, outcome);
		lastAny = record.item;
		if (outcome === "committed") lastCommitted = record.item;
	}
	let committed = 0;
	let deleted = 0;
	let failed = 0;
	let bytes = 0;
	let sized = options.sizeOf !== undefined;
	for (const [item, outcome] of latest) {
		if (outcome === "committed") {
			committed += 1;
			const size = options.sizeOf?.(item);
			if (size === undefined) sized = false;
			else bytes += size;
		} else if (outcome === "deleted") deleted += 1;
		else failed += 1;
	}
	const last = lastCommitted ?? lastAny;
	return {
		committed,
		deleted,
		failed,
		bytesDone: sized ? bytes : null,
		lastFile: last === null ? null : journalItemName(last),
		modifiedAt: options.modifiedAt ?? null,
	};
}
