/**
 * Why a first index stopped, in the few terms the UI can act on. The app decides
 * this from diagnostics it emits itself (`src/main/index-failure.ts`), never from
 * the wording of a third-party error.
 */

/**
 * - `embedder-config`: the embedder answered and refused (wrong key, no credit, wrong URL or dimension): a setting has to change.
 * - `embedder-offline`: the embedder could not be reached or timed out: waiting or retrying can fix it.
 * - `model-download`: the on-device model is missing or its download failed.
 * - `disk-full`: the disk has no room for what the run writes.
 * - `folder-unreadable`: a selected folder cannot be listed (drive not mounted, permission gone).
 * - `unknown`: nothing the app can tell apart.
 */
export const INDEX_FAILURE_REASONS = ["embedder-config", "embedder-offline", "model-download", "disk-full", "folder-unreadable", "unknown"] as const;
export type IndexFailureReason = (typeof INDEX_FAILURE_REASONS)[number];

/** The four groups the first-index screens are designed for. */
export type IndexFailureKind = "config" | "transient" | "environment" | "unknown";

export interface IndexFailure {
	readonly reason: IndexFailureReason;
	/** Folders that cannot be read; empty for every other reason. */
	readonly folders: readonly string[];
	/** The app's own diagnostic code that decided the reason; `null` when none did. Shown nowhere, kept for the log. */
	readonly code: string | null;
}

export function failureKind(reason: IndexFailureReason): IndexFailureKind {
	switch (reason) {
		case "embedder-config":
			return "config";
		case "embedder-offline":
		case "model-download":
			return "transient";
		case "disk-full":
		case "folder-unreadable":
			return "environment";
		case "unknown":
			return "unknown";
	}
}

export function isIndexFailureReason(value: unknown): value is IndexFailureReason {
	return INDEX_FAILURE_REASONS.some((reason) => reason === value);
}
