import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfigRefreshResult } from "../shared/settings-contract";

/**
 * Everything error reporting decides without touching Sentry or Electron, so the
 * main process, the fs worker and the tests share one definition of what a
 * report contains and what is stripped from it. This file must stay free of
 * `electron`: `file-timeout.ts` imports it and runs inside the scheduled
 * refresh job, which is plain Node.
 */

/** Longest string a report carries; error text can echo document content, so it is cut. */
const MAX_TEXT = 500;

const PATH_START = String.raw`(?:[A-Za-z]:[\\/]|~[\\/]|/(?=[^\s/]))`;
/** A path inside quotes ends at the closing quote, so folders with spaces go whole. */
const QUOTED_PATH = new RegExp(String.raw`(['"\x60])(${PATH_START}[^'"\x60\n]*)\1`, "gu");
/** A bare path ends at whitespace. `app:///` and `https://host/x` are never matched: the slash follows `:`, `/` or a word character. */
const BARE_PATH = new RegExp(String.raw`(?<![\w:/.\\~-])${PATH_START}[^\s'"\x60<>|*?]*`, "gu");

/** `<path>` plus the file extension, the one part of a file name a report may keep. */
function pathPlaceholder(path: string): string {
	const last = path.split(/[\\/]/u).at(-1) ?? "";
	const extension = /(\.[A-Za-z0-9]{1,8})(?::\d+)*[)\]]?$/u.exec(last)?.[1] ?? "";
	return `<path>${extension}`;
}

/** Replace absolute and home-relative paths with `<path>.ext` and cap the length. */
export function scrubText(text: string): string {
	const scrubbed = text
		.replace(QUOTED_PATH, (_match, quote: string, path: string) => `${quote}${pathPlaceholder(path)}${quote}`)
		.replace(BARE_PATH, (path) => pathPlaceholder(path));
	return scrubbed.length > MAX_TEXT ? `${scrubbed.slice(0, MAX_TEXT)}…` : scrubbed;
}

function scrubValue(value: unknown): unknown {
	if (typeof value === "string") return scrubText(value);
	if (Array.isArray(value)) return value.map(scrubValue);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, scrubValue(inner)]));
	}
	return value;
}

/** Event fields that identify the person or the machine, or carry a request: never sent. */
const DROPPED_EVENT_FIELDS = ["user", "server_name", "request"] as const;

/**
 * The last step before an event leaves the machine: drop identity fields and
 * console breadcrumbs (they echo whatever the app logged), then scrub every
 * remaining string. Returns a copy.
 */
export function scrubEvent<E extends object>(event: E): E {
	const scrubbed = scrubValue(event) as Record<string, unknown>;
	for (const field of DROPPED_EVENT_FIELDS) delete scrubbed[field];
	if (Array.isArray(scrubbed.breadcrumbs)) {
		scrubbed.breadcrumbs = scrubbed.breadcrumbs.filter((crumb: unknown) => !(typeof crumb === "object" && crumb !== null && "category" in crumb && crumb.category === "console"));
	}
	return scrubbed as E;
}

/** Whether the user turned error reporting on, read before the app is ready (the settings store loads asynchronously). Off unless the stored setting is exactly `true`. */
export function readErrorReportingEnabled(userDataDir: string): boolean {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(userDataDir, "settings", "settings-state.json"), "utf8"));
		const settings = typeof parsed === "object" && parsed !== null && "settings" in parsed ? parsed.settings : null;
		return typeof settings === "object" && settings !== null && "errorReporting" in settings && settings.errorReporting === true;
	} catch {
		return false;
	}
}

export interface ErrorReport {
	readonly title: string;
	/** Reports with the same fingerprint are one issue on the server. */
	readonly fingerprint: readonly string[];
	readonly tags: Readonly<Record<string, string>>;
	/** Counts, sizes and scrubbed messages only. */
	readonly extra: Readonly<Record<string, string | number | boolean | null>>;
}

let reporter: ((report: ErrorReport) => void) | null = null;
const sentThisRun = new Set<string>();

/** Where reports go in this process; none installed (tests, the scheduled job) means they are dropped. */
export function installErrorReporter(next: ((report: ErrorReport) => void) | null): void {
	reporter = next;
	sentThisRun.clear();
}

/** Send one report; an identical one (same fingerprint) is sent once per run so a loop cannot flood. Never throws. */
export function reportError(report: ErrorReport): void {
	const key = report.fingerprint.join("\u0000");
	if (reporter === null || sentThisRun.has(key)) return;
	sentThisRun.add(key);
	try {
		reporter(report);
	} catch {
		// Reporting must never break the thing it reports on.
	}
}

const REFRESH_STEPS = ["minsync", "everything", "fsearch", "datasources"] as const;

/** `minsync: …; datasources x: …` → the steps that failed. */
function failingSteps(error: string): string[] {
	const steps = error.split("; ").map((part) => REFRESH_STEPS.find((step) => part.startsWith(step)) ?? "other");
	return [...new Set(steps)].sort();
}

/** Same failure, different numbers (ports, counts, ids) → same text. */
function groupingText(text: string): string {
	return text.replace(/\d+/gu, "N").slice(0, 120);
}

/** A refresh that reported `ok: false`, or null when it succeeded. */
export function refreshFailureReport(result: ConfigRefreshResult): ErrorReport | null {
	if (result.ok) return null;
	const error = scrubText(result.error ?? "refresh failed");
	const steps = failingSteps(error);
	return {
		title: `Index refresh failed: ${steps.join(", ")}`,
		fingerprint: ["refresh-failed", steps.join(","), groupingText(error)],
		tags: { "index.step": steps.join(",") },
		extra: {
			error,
			methods: result.methods.join(","),
			scanned: result.scanned,
			written: result.written,
			deleted: result.deleted,
			skipped: result.skipped,
			diagnosticCodes: result.diagnostics.map((diagnostic) => diagnostic.code).join(","),
		},
	};
}

/** A file whose parse outlived the per-file budget. The callback only sees the bytes, so size is all there is. */
export function fileTimeoutReport(timeoutMs: number, fileSizeBytes: number): ErrorReport {
	return {
		title: "Parsing a file timed out",
		fingerprint: ["file-timeout"],
		tags: { "index.step": "parse" },
		extra: { timeoutMs, fileSizeBytes },
	};
}

/** A datasource sync that failed. Identified by its built-in type: the id is a name the user chose. */
export function datasourceFailureReport(type: string, error: string, durationMs: number): ErrorReport {
	const text = scrubText(error);
	return {
		title: `Datasource sync failed: ${type}`,
		fingerprint: ["datasource-failed", type, groupingText(text)],
		tags: { "index.step": "datasources", "datasource.type": type },
		extra: { error: text, durationMs },
	};
}

/** The embedder used no CPU for minutes; the watchdog killed it and the sync was started again `retries` times. */
export function embedderStallReport(retries: number): ErrorReport {
	return {
		title: "Embedder hung and was restarted",
		fingerprint: ["embedder-stalled"],
		tags: { "index.step": "minsync" },
		extra: { retries },
	};
}
