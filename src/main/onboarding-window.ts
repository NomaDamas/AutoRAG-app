/**
 * The app has one window now (the Finder), so the only close rule left is the
 * quit gate: closing the last window while the first index still runs would stop
 * it, so that close asks first. Pure, so the Electron wiring stays thin.
 */

export type CloseDecision = "allow" | "confirm";

/** Closing asks first only when it is the last window and a first index is still running. */
export function closeDecision(input: { readonly pending: boolean; readonly indexing: boolean; readonly windowsOpen: number }): CloseDecision {
	return input.pending && input.indexing && input.windowsOpen <= 1 ? "confirm" : "allow";
}
