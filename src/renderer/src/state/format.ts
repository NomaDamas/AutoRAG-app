/**
 * Display formatting for list metadata, status text, and toasts.
 *
 * Every literal here is the reference's own string (handoff README §2). The
 * date and size shapes match the prototype fixtures: "Sep 13, 16:48", "84 KB",
 * "4.8 MB" — KB is whole, MB and above carry one decimal below 10.
 */

import { RECENTS_PATH } from "../../../shared/fs-contract";
import { basename } from "./paths";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const UNITS = ["KB", "MB", "GB", "TB"] as const;
/** Folders and unknown values render as an em dash, like the reference. */
const NO_VALUE = "—";

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

export function formatModified(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return NO_VALUE;
	}
	return `${MONTHS[date.getMonth()] ?? NO_VALUE} ${date.getDate()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
	if (bytes === null) {
		return NO_VALUE;
	}
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
}

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
		return `${basename(paths[0] ?? "")} — 휴지통으로 이동했습니다`;
	}
	return `${paths.length}개 항목을 휴지통으로 이동했습니다`;
}

export function putBackToast(paths: readonly string[]): string {
	if (paths.length === 1) {
		return `${basename(paths[0] ?? "")} — 원래 위치로 복원했습니다`;
	}
	return `${paths.length}개 항목을 원래 위치로 복원했습니다`;
}

/** The toast for an emptied Trash: what went, and the first verbatim refusal. */
export function emptyTrashToast(result: {
	readonly ok: readonly string[];
	readonly failed: readonly { readonly path: string; readonly message: string }[];
}): string {
	const first = result.failed[0];
	if (first === undefined) {
		return "휴지통을 비웠습니다";
	}
	return result.ok.length === 0
		? `휴지통 비우기 실패: ${first.message}`
		: `${result.ok.length}개 항목을 삭제했습니다 · ${basename(first.path)} — 삭제하지 못했습니다: ${first.message}`;
}

/** A batch file operation's verb, as the toast names it. */
export type BatchVerb = "trash" | "putBack" | "move" | "copy" | "duplicate";

const BATCH_DONE: Record<BatchVerb, string> = {
	trash: "휴지통으로 이동했습니다",
	putBack: "원래 위치로 복원했습니다",
	move: "옮겼습니다",
	copy: "복사했습니다",
	duplicate: "복제했습니다",
};

const BATCH_FAILED: Record<BatchVerb, string> = {
	trash: "휴지통으로 이동하지 못했습니다",
	putBack: "원래 위치로 복원하지 못했습니다",
	move: "옮기지 못했습니다",
	copy: "복사하지 못했습니다",
	duplicate: "복제하지 못했습니다",
};

/**
 * The toast for a finished batch. A partial batch names both counts and the
 * first failure's verbatim reason, so items that stayed put never look done.
 */
export function batchToast(
	verb: BatchVerb,
	result: { readonly ok: readonly string[]; readonly failed: readonly { readonly path: string; readonly message: string }[] },
): string {
	const first = result.failed[0];
	if (first === undefined) {
		if (verb === "trash") return trashToast(result.ok);
		if (verb === "putBack") return putBackToast(result.ok);
		return `${result.ok.length}개 항목을 ${BATCH_DONE[verb]}`;
	}
	const failedPart =
		result.failed.length === 1
			? `${basename(first.path)} — ${BATCH_FAILED[verb]}: ${first.message}`
			: `${result.failed.length}개 항목을 ${BATCH_FAILED[verb]} (${basename(first.path)}: ${first.message})`;
	return result.ok.length === 0 ? failedPart : `${result.ok.length}개 항목을 ${BATCH_DONE[verb]} · ${failedPart}`;
}

export function indexToast(name: string, included: boolean): string {
	return included ? `${name} — 인덱싱에 포함했습니다` : `${name} — 인덱싱에서 제외했습니다`;
}

export function emptyStateText(
	query: string,
	path = "",
	translate?: (key: string, def: string, opt?: Record<string, unknown>) => string,
): string {
	const trimmed = query.trim();
	if (trimmed !== "") {
		return translate
			? translate("finder.emptySearch", `"${trimmed}"와 일치하는 파일이 없습니다`, { query: trimmed })
			: `"${trimmed}"와 일치하는 파일이 없습니다`;
	}
	if (path === RECENTS_PATH) {
		return translate ? translate("finder.emptyRecents", "최근에 연 파일이 없습니다") : "최근에 연 파일이 없습니다";
	}
	return translate ? translate("finder.emptyFolder", "빈 폴더") : "빈 폴더";
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
