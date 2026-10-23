/**
 * What a person reads about a file-automation rule. The librarian stores a rule as
 * machine fields (absolute folders, globs, an argv); every function here turns them
 * into the plain sentence the 자동화 view, its inspector, Quick Look, and the AI Search
 * draft show, in the interface language.
 */

import type { AutomationEventType, AutomationRule, AutomationRun } from "../../../shared/automation-contract";
import { i18n, t } from "../../../shared/i18n/core";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** An instruction longer than this is cut where a narrow list or the inspector has no room. */
const SHORT_INSTRUCTION = 22;
/** Kinds named in a sentence before the rest collapse into "외 N종". */
const KINDS_SHOWN = 3;

/* ------------------------------------------------------------------ folders -- */

const HOME_FOLDERS: Readonly<Record<string, "downloads" | "documents" | "desktop" | "pictures" | "movies" | "music">> = {
	Downloads: "downloads",
	Documents: "documents",
	Desktop: "desktop",
	Pictures: "pictures",
	Movies: "movies",
	Videos: "movies",
	Music: "music",
};

/** `/Users/<me>/<folder>`, `/home/<me>/<folder>`, `C:\Users\<me>\<folder>`: the user's own standard folders. */
const HOME_CHILD = /^(?:~|\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)\/([^/]+)$/;

/** Forward slashes, no trailing slash: the form every path comparison here uses. */
function normalizePath(path: string): string {
	const slashed = path.replaceAll("\\", "/");
	const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
	// Windows paths ignore case; a POSIX path keeps it.
	return /^[A-Za-z]:\//.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

/** A folder as the sidebar names it: the user's standard folders localized, any other folder by its own name. */
export function folderLabel(path: string): string {
	const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
	const standard = HOME_CHILD.exec(normalized)?.[1];
	const key = standard === undefined ? undefined : HOME_FOLDERS[standard];
	if (key !== undefined) return t(`places.${key}`);
	return normalized.split("/").pop() || path;
}

export function foldersText(paths: readonly string[]): string {
	const [first, ...rest] = paths;
	if (first === undefined) return "";
	return rest.length === 0 ? folderLabel(first) : t("automations.foldersMore", { first: folderLabel(first), count: rest.length });
}

/** The rules whose recursive watch covers `folder`: the watched folder itself or anything inside it. */
export function rulesWatching(rules: readonly AutomationRule[], folder: string): readonly AutomationRule[] {
	const target = normalizePath(folder);
	return rules.filter((rule) =>
		rule.paths.some((watched) => {
			const root = normalizePath(watched);
			return target === root || target.startsWith(root === "/" ? "/" : `${root}/`);
		}),
	);
}

/* -------------------------------------------------------------- file kinds -- */

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "jpe", "heic", "heif", "tif", "tiff", "bmp", "gif", "webp", "avif", "jp2"]);
const KIND_NAMES: Readonly<Record<string, string>> = {
	pdf: "PDF",
	md: "Markdown",
	markdown: "Markdown",
	hwp: "HWP",
	hwpx: "HWP",
	doc: "Word",
	docx: "Word",
	xls: "Excel",
	xlsx: "Excel",
	csv: "CSV",
	ppt: "PowerPoint",
	pptx: "PowerPoint",
	json: "JSON",
	zip: "ZIP",
	mp3: "MP3",
	mp4: "MP4",
};
const TEXT_EXTENSIONS = new Set(["txt", "text"]);

const SCREENSHOT = /screen ?shot|스크린샷|スクリーンショット|截屏|截图/i;
const EVERY_FILE = new Set(["**", "**/*", "*"]);

function kindOfPattern(pattern: string): string {
	if (SCREENSHOT.test(pattern)) return t("automations.kinds.screenshot");
	const extension = /\*\.([A-Za-z0-9]+)$/.exec(pattern)?.[1]?.toLowerCase();
	if (extension === undefined) return pattern;
	if (IMAGE_EXTENSIONS.has(extension)) return t("automations.kinds.image");
	if (TEXT_EXTENSIONS.has(extension)) return t("automations.kinds.text");
	return KIND_NAMES[extension] ?? `.${extension}`;
}

/** The file kinds an `include` list matches, as a person says them: "PDF", "이미지", "PDF·Word". */
export function kindsText(include: readonly string[]): string {
	if (include.length === 0 || include.some((pattern) => EVERY_FILE.has(pattern))) return t("automations.kinds.all");
	const names = [...new Set(include.map(kindOfPattern))];
	if (names.length <= KINDS_SHOWN) return names.join("·");
	return t("automations.kinds.more", { kinds: names.slice(0, KINDS_SHOWN).join("·"), count: names.length - KINDS_SHOWN });
}

function isEveryFile(rule: AutomationRule): boolean {
	return kindsText(rule.include) === t("automations.kinds.all");
}

/** "PDF 파일", or just "파일" when the rule takes every file. */
function kindNoun(rule: AutomationRule): string {
	return isEveryFile(rule) ? t("automations.kinds.allNoun") : t("automations.kinds.noun", { kinds: kindsText(rule.include) });
}

/* -------------------------------------------------------------- the sentence -- */

type TriggerKey = "create" | "createUpdate" | "any" | "update" | "delete" | "createDelete" | "updateDelete";

function triggerKey(events: readonly AutomationEventType[]): TriggerKey {
	const on = (event: AutomationEventType): boolean => events.includes(event);
	if (on("create") && on("update") && on("delete")) return "any";
	if (on("create") && on("update")) return "createUpdate";
	if (on("create") && on("delete")) return "createDelete";
	if (on("update") && on("delete")) return "updateDelete";
	if (on("update")) return "update";
	if (on("delete")) return "delete";
	return "create";
}

/** The command's own name: the script a runtime starts, else the program itself ("to-png.mjs", "hwp5"). */
const RUNTIMES = new Set(["node", "bun", "deno", "python", "python3", "ruby"]);

function leafName(path: string): string {
	return path.replaceAll("\\", "/").split("/").pop() ?? path;
}

function commandName(rule: AutomationRule): string {
	const [program = "", second] = rule.run;
	const name = leafName(program).replace(/\.exe$/i, "");
	if (RUNTIMES.has(name.toLowerCase()) && second !== undefined && !second.startsWith("-")) return leafName(second);
	return name;
}

function isAutorag(rule: AutomationRule, subcommand: string): boolean {
	return rule.run[0] === "autorag" && rule.run[1] === subcommand;
}

export function actionShort(rule: AutomationRule): string {
	if (isAutorag(rule, "refresh")) return t("automations.action.refresh");
	if (isAutorag(rule, "search")) return t("automations.action.search");
	return t("automations.action.run", { name: commandName(rule) });
}

/** "새 PDF → Dazzi에게 맡기기": the name a person reads in a list. */
export function ruleTitle(rule: AutomationRule): string {
	const everyFile = isEveryFile(rule);
	const kinds = kindsText(rule.include);
	const createdOnly = rule.events.length === 1 && rule.events[0] === "create";
	const trigger = createdOnly
		? everyFile ? t("automations.title.createdAll") : t("automations.title.created", { kinds })
		: everyFile ? t("automations.title.changedAll") : t("automations.title.changed", { kinds });
	return t("automations.title.rule", { trigger, action: actionShort(rule) });
}

/** "다운로드에 PDF 파일이 새로 생기면". */
export function whenText(rule: AutomationRule): string {
	return t("automations.whenIn", {
		folder: foldersText(rule.paths),
		trigger: t(`automations.trigger.${triggerKey(rule.events)}`, { kind: kindNoun(rule) }),
	});
}

/** The kind and trigger without the folder, for Quick Look, where the folder has its own row. */
export function triggerText(rule: AutomationRule): string {
	return t(`automations.trigger.${triggerKey(rule.events)}`, { kind: kindNoun(rule) });
}

function shortInstruction(text: string): string {
	return text.length > SHORT_INSTRUCTION ? `${text.slice(0, SHORT_INSTRUCTION).trimEnd()}…` : text;
}

/** What the rule does. `full` keeps the whole instruction: Quick Look and cards have room, the inspector does not. */
export function whatText(rule: AutomationRule, { full = false }: { readonly full?: boolean } = {}): string {
	if (isAutorag(rule, "refresh")) return t("automations.what.refresh");
	const instruction = rule.run[2];
	if (isAutorag(rule, "search") && instruction !== undefined) return `“${full ? instruction : shortInstruction(instruction)}”`;
	return t("automations.what.program", { name: commandName(rule) });
}

/* ---------------------------------------------------------------- last run -- */

export type RunTone = "ok" | "fail" | "never";

export function runTone(run: AutomationRun | null): RunTone {
	if (run === null) return "never";
	return run.timedOut || run.error !== undefined || run.exitCode !== 0 ? "fail" : "ok";
}

export function failReason(run: AutomationRun): string {
	if (run.timedOut) return t("automations.fail.timeout");
	if (run.error !== undefined) {
		const missing = /spawn (\S+) ENOENT/.exec(run.error)?.[1];
		return missing === undefined ? run.error : t("automations.fail.missing", { name: missing });
	}
	if (run.signal !== null) return t("automations.fail.signal", { signal: run.signal });
	if (run.exitCode !== null) return t("automations.fail.code", { code: run.exitCode });
	return t("automations.fail.unknown");
}

/** "3분 전" / "3 minutes ago", in the interface language. */
export function relativeTime(at: number, now: number = Date.now()): string {
	const age = now - at;
	if (age < MINUTE_MS) return t("automations.time.now");
	const format = new Intl.RelativeTimeFormat(i18n.language, { numeric: "always" });
	if (age < HOUR_MS) return format.format(-Math.floor(age / MINUTE_MS), "minute");
	if (age < DAY_MS) return format.format(-Math.floor(age / HOUR_MS), "hour");
	return format.format(-Math.floor(age / DAY_MS), "day");
}

export function lastRunText(rule: AutomationRule, now: number = Date.now()): string {
	const run = rule.lastRun;
	if (run === null) return t("automations.lastRun.never");
	const time = relativeTime(run.startedAt, now);
	return runTone(run) === "ok" ? t("automations.lastRun.ok", { time }) : t("automations.lastRun.fail", { time });
}

/* -------------------------------------------------------- AI Search drafts -- */

/**
 * The draft an edit opens an AI Search tab with: it names the rule and says what it
 * does now, then stops where the person types the change. It is never sent for them.
 */
export function editPrompt(rule: AutomationRule): string {
	return t("automations.prompt.edit", { id: rule.id, when: whenText(rule) });
}

export function addPrompt(): string {
	return t("automations.prompt.add");
}
