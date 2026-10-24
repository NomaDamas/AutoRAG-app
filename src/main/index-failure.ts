import type { IndexFailure } from "../shared/index-failure";
import type { ConfigRefreshDiagnostic } from "../shared/settings-contract";
import { t } from "../shared/i18n/core";
import { isEmbeddingTimeout } from "./embedding-batch";

/**
 * Classifies a failed first index from what the app itself emitted: the
 * `diagnostics[].code` values of `index-refresh.ts` and the structured
 * `reason`/`folders` they carry. The wording of an error from MinSync or the
 * librarian is never read for a cause, except the two checks the app already
 * trusts elsewhere: `isEmbeddingTimeout` (the batch watchdog) and Node's own
 * errno name `ENOSPC`. Anything else is `unknown`; the raw text stays in the log.
 */

/** Preflight outcomes where the embedder never answered: waiting or retrying can fix them. */
const PREFLIGHT_OFFLINE: Readonly<Record<string, true>> = { unreachable: true, timeout: true, "server-error": true };

/** Node's errno name for a full disk, as it appears inside a download or write error. */
export function isDiskFull(message: string | null): boolean {
	return message !== null && /\bENOSPC\b/u.test(message);
}

/**
 * The outcome of a first-index run that could not get the on-device model: the message the
 * user sees and the diagnostic the classifier reads (`disk-full` is told apart by Node's own errno name).
 */
export function modelDownloadFailure(missing: string): { readonly error: string; readonly diagnostics: readonly ConfigRefreshDiagnostic[] } {
	const error = t("main.onboarding.modelDownloadFailed", { error: missing });
	return {
		error,
		diagnostics: [{ code: "embedding-model-download-failed", severity: "error", message: error, reason: isDiskFull(missing) ? "disk-full" : "network" }],
	};
}

export interface FailureInput {
	readonly diagnostics: readonly ConfigRefreshDiagnostic[];
	readonly error: string | null;
}

export function classifyIndexFailure({ diagnostics, error }: FailureInput): IndexFailure {
	const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
	const find = (code: string): ConfigRefreshDiagnostic | undefined => errors.find((diagnostic) => diagnostic.code === code);
	const decided = (reason: IndexFailure["reason"], source: ConfigRefreshDiagnostic | null, folders: readonly string[] = []): IndexFailure => ({
		reason,
		folders,
		code: source?.code ?? null,
	});

	// Nothing can be read at all: this outranks every embedder problem.
	const root = find("search-root-unavailable");
	if (root !== undefined) return decided("folder-unreadable", root, root.folders ?? []);

	const download = find("embedding-model-download-failed");
	if (download !== undefined) return decided(download.reason === "disk-full" ? "disk-full" : "model-download", download);

	const preflight = find("embedder-preflight-failed");
	if (preflight !== undefined) return decided(PREFLIGHT_OFFLINE[preflight.reason ?? ""] === true ? "embedder-offline" : "embedder-config", preflight);

	const missing = find("embedding-model-missing");
	if (missing !== undefined) return decided("model-download", missing);

	if (isEmbeddingTimeout([error ?? undefined, ...errors.map((diagnostic) => diagnostic.message)])) return decided("embedder-offline", errors[0] ?? null);
	if (isDiskFull(error)) return decided("disk-full", null);
	return decided("unknown", errors[0] ?? null);
}

/** Codes whose `count` is a number of files the run left out. */
const LEFT_OUT_CODES: Readonly<Record<string, true>> = { "files-left-out": true, "parse-killed": true };

/**
 * Files a finished run left out, from the app's own warnings. Each `minsync-file-skipped`
 * is one file; the others carry the number they left out in `count`.
 */
export function skippedFileCount(diagnostics: readonly ConfigRefreshDiagnostic[]): number {
	let total = 0;
	for (const diagnostic of diagnostics) {
		if (diagnostic.code === "minsync-file-skipped") total += 1;
		else if (LEFT_OUT_CODES[diagnostic.code] === true) total += diagnostic.count ?? 0;
	}
	return total;
}
