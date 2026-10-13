/**
 * Display formatting for list metadata, status text, and toasts.
 *
 * Every literal here is the reference's own string (handoff README §2). The
 * date and size shapes match the prototype fixtures: "Sep 13, 16:48", "84 KB",
 * "4.8 MB" — KB is whole, MB and above carry one decimal below 10.
 */

import { isTagPath, RECENTS_PATH, tagNameOf, type FsHistoryOperation, type FsUndoOutcome } from "../../../shared/fs-contract";
import { t } from "../../../shared/i18n/core";
import { basename } from "./paths";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const UNITS = ["KB", "MB", "GB", "TB"] as const;
/** Folders and unknown values render as an em dash, like the reference. */
const NO_VALUE = "—";

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/**
 * Cell labels are computed when a row renders, so the same few thousand
 * values are formatted again on every scroll. Memoized by input with a hard
 * cap: past it the map is dropped and refills from what is on screen.
 */
const LABEL_CACHE_LIMIT = 4096;

function memoize<K, V>(compute: (key: K) => V): (key: K) => V {
	const cache = new Map<K, V>();
	return (key) => {
		const hit = cache.get(key);
		if (hit !== undefined) return hit;
		const value = compute(key);
		if (cache.size >= LABEL_CACHE_LIMIT) cache.clear();
		cache.set(key, value);
		return value;
	};
}

const SECOND_MS = 1000;

/**
 * "Sep 13, 16:48" for one epoch second. Keyed by the second, not the minute:
 * time zone offsets are whole seconds (historical LMT offsets are not whole
 * minutes), so every stamp inside one second shares a local wall minute.
 */
const modifiedLabelForSecond = memoize((second: number): string => {
	const date = new Date(second * SECOND_MS);
	return `${MONTHS[date.getMonth()] ?? NO_VALUE} ${date.getDate()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
});

/** The Date Modified label for an epoch-ms stamp; an unusable stamp renders as an em dash. */
export function formatModified(ms: number): string {
	// `mtimeMs` carries sub-millisecond digits. Node builds `stats.mtime` (what the label
	// showed when the listing sent an ISO string) with `Math.round`, so a stamp half a
	// millisecond below a minute boundary belongs to the next minute; truncating or
	// flooring would put it in the previous one.
	const whole = Math.round(ms);
	if (!Number.isFinite(whole) || Number.isNaN(new Date(whole).getTime())) {
		return NO_VALUE;
	}
	return modifiedLabelForSecond(Math.floor(whole / SECOND_MS));
}

/** Full local date and time for the Info panel, e.g. "2026-01-02 03:04:05". */
export function formatTimestamp(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return NO_VALUE;
	}
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Sortable stamp for a "Sep 13, 16:48" label; 0 when it cannot be read. */
export function parseModifiedLabel(label: string): number {
	const match = /^(\w{3}) (\d+), (\d+):(\d+)$/.exec(label);
	if (match === null) {
		return 0;
	}
	const month = MONTHS.indexOf((match[1] ?? "") as (typeof MONTHS)[number]) + 1;
	const day = Number(match[2]);
	const hour = Number(match[3]);
	const minute = Number(match[4]);
	return ((month * 100 + day) * 100 + hour) * 100 + minute;
}

export function formatSize(bytes: number | null): string {
	return bytes === null ? NO_VALUE : sizeLabel(bytes);
}

const sizeLabel = memoize((bytes: number): string => {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const label = unit >= 1 && value < 10 ? value.toFixed(1) : String(Math.round(value));
	return `${label} ${UNITS[unit] ?? "KB"}`;
});

/** Sortable byte count for a "84 KB" label. */
export function parseSizeLabel(label: string): number {
	const match = /^([\d.]+)\s*(B|KB|MB|GB|TB)$/.exec(label.trim());
	if (match === null) {
		return 0;
	}
	const scale: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
	return Number(match[1]) * (scale[match[2] ?? "B"] ?? 1);
}

export function trashToast(paths: readonly string[]): string {
	if (paths.length === 1) {
		return t("finderState.toast.trashSingle", { name: basename(paths[0] ?? "") });
	}
	return t("toasts.trashCount", { count: paths.length });
}

export function putBackToast(paths: readonly string[]): string {
	if (paths.length === 1) {
		return t("finderState.toast.putBackSingle", { name: basename(paths[0] ?? "") });
	}
	return t("finderState.toast.putBackCount", { count: paths.length });
}

/** The toast for an emptied Trash: what went, and the first verbatim refusal. */
export function emptyTrashToast(result: {
	readonly ok: readonly string[];
	readonly failed: readonly { readonly path: string; readonly message: string }[];
}): string {
	const first = result.failed[0];
	if (first === undefined) {
		return t("finderState.toast.emptyTrashDone");
	}
	return result.ok.length === 0
		? t("finderState.toast.emptyTrashFailed", { message: first.message })
		: t("finderState.toast.emptyTrashPartial", {
				count: result.ok.length,
				name: basename(first.path),
				message: first.message,
			});
}

/** A batch file operation's verb, as the toast names it. */
export type BatchVerb = "trash" | "putBack" | "move" | "copy" | "duplicate";

const BATCH_DONE = {
	trash: "finderState.toast.batchDone.trash",
	putBack: "finderState.toast.batchDone.putBack",
	move: "finderState.toast.batchDone.move",
	copy: "finderState.toast.batchDone.copy",
	duplicate: "finderState.toast.batchDone.duplicate",
} as const satisfies Readonly<Record<BatchVerb, string>>;

const BATCH_FAILED = {
	trash: "finderState.toast.batchFailed.trash",
	putBack: "finderState.toast.batchFailed.putBack",
	move: "finderState.toast.batchFailed.move",
	copy: "finderState.toast.batchFailed.copy",
	duplicate: "finderState.toast.batchFailed.duplicate",
} as const satisfies Readonly<Record<BatchVerb, string>>;

/**
 * The toast for a finished batch. A partial batch names both counts and the
 * first failure's verbatim reason, so items that stayed put never look done.
 */
export function batchToast(
	verb: BatchVerb,
	result: { readonly ok: readonly string[]; readonly failed: readonly { readonly path: string; readonly message: string }[] },
): string {
	const doneCount = (): string => t("finderState.toast.batchDoneCount", { count: result.ok.length, action: t(BATCH_DONE[verb]) });
	const first = result.failed[0];
	if (first === undefined) {
		if (verb === "trash") return trashToast(result.ok);
		if (verb === "putBack") return putBackToast(result.ok);
		return doneCount();
	}
	const failedPart =
		result.failed.length === 1
			? t("finderState.toast.batchFailedSingle", {
					name: basename(first.path),
					reason: t(BATCH_FAILED[verb]),
					message: first.message,
				})
			: t("finderState.toast.batchFailedCount", {
					count: result.failed.length,
					reason: t(BATCH_FAILED[verb]),
					name: basename(first.path),
					message: first.message,
				});
	return result.ok.length === 0 ? failedPart : t("finderState.toast.batchCombined", { done: doneCount(), failure: failedPart });
}

/** How each recorded operation is named in the "…취소" / "…다시 실행" toast. */
const HISTORY_LABEL = {
	copy: "finderState.history.op.copy",
	move: "finderState.history.op.move",
	duplicate: "finderState.history.op.duplicate",
	rename: "finderState.history.op.rename",
	createFolder: "finderState.history.op.createFolder",
	createFile: "finderState.history.op.createFile",
	trash: "finderState.history.op.trash",
	restore: "finderState.history.op.restore",
	extract: "finderState.history.op.extract",
	compress: "finderState.history.op.compress",
} as const satisfies Readonly<Record<FsHistoryOperation, string>>;

/**
 * The toast for a ⌘Z / ⇧⌘Z: the operation it undid or redid ("이름 변경 취소"),
 * or the first failed step's verbatim reason. Null when the history was empty —
 * Finder does nothing then either.
 */
export function historyToast(direction: "undo" | "redo", outcome: FsUndoOutcome): string | null {
	if (outcome.empty) return null;
	const operation = outcome.operation === undefined ? t("finderState.history.op.generic") : t(HISTORY_LABEL[outcome.operation]);
	const label = direction === "undo" ? t("finderState.history.undo", { operation }) : t("finderState.history.redo", { operation });
	const first = outcome.failed[0];
	if (first === undefined) return label;
	const more = outcome.failed.length > 1 ? t("finderState.history.more", { count: outcome.failed.length - 1 }) : "";
	return t("finderState.history.failed", { label, name: basename(first.path), message: first.message, more });
}

export function indexToast(name: string, included: boolean): string {
	return included ? t("toasts.indexIncluded", { name }) : t("toasts.indexExcluded", { name });
}

export function emptyStateText(
	query: string,
	path = ""
): string {
	const trimmed = query.trim();
	if (trimmed !== "") {
		return t("finder.emptySearch", { query: trimmed });
	}
	if (path === RECENTS_PATH) {
		return t("finder.emptyRecents");
	}
	if (isTagPath(path)) {
		return t("finder.emptyTag", { name: tagNameOf(path) });
	}
	return t("finder.emptyFolder");
}

/** Display width in Latin-letter units: CJK and other wide scripts count 2. */
function labelWidth(text: string): number {
	let width = 0;
	for (const char of text) {
		width += (char.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1;
	}
	return width;
}

/** The longest prefix of `text` that fits in `budget` width units. */
function fitHead(text: string, budget: number): string {
	let out = "";
	let width = 0;
	for (const char of text) {
		const next = width + labelWidth(char);
		if (next > budget) break;
		out += char;
		width = next;
	}
	return out;
}

/** Characters kept before the extension (or at the end) of a shortened name. */
const TILE_TAIL_CHARS = 3;

/**
 * Icon-view caption (about two lines under a tile): long names are cut in the
 * middle, keeping the start, the last few characters, and the extension, the
 * way Finder does.
 */
export function tileLabel(name: string, budget = 26): string {
	if (labelWidth(name) <= budget) {
		return name;
	}
	const dot = name.lastIndexOf(".");
	const hasExt = dot > 0 && name.length - dot <= 8;
	const stem = hasExt ? name.slice(0, dot) : name;
	const ext = hasExt ? name.slice(dot) : "";
	const stemChars = [...stem];
	const tail = stemChars.slice(-TILE_TAIL_CHARS).join("") + ext;
	const head = fitHead(stemChars.slice(0, -TILE_TAIL_CHARS).join(""), budget - 1 - labelWidth(tail));
	return `${head.trimEnd()}…${tail}`;
}
