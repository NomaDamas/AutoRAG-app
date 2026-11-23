/**
 * The app has one window now (the Finder), so the only close rule left is the
 * quit gate: closing the last window while the first index still runs would stop
 * it, so that close asks first. The first index can outlive the first run (a person
 * may start the app once a question is ready and let the rest be read in the
 * background), so the rule follows the index, not the onboarding flag. Pure, so the
 * Electron wiring stays thin.
 */

export type CloseDecision = "allow" | "confirm";

/** Closing asks first only when it is the last window and the first index is still running. */
export function closeDecision(input: { readonly indexing: boolean; readonly windowsOpen: number }): CloseDecision {
	return input.indexing && input.windowsOpen <= 1 ? "confirm" : "allow";
}
