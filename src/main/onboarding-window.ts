import type { IndexingStatus } from "../shared/onboarding-contract";

/**
 * First-run onboarding lives in its own window beside the Finder, so neither window is the app's only door.
 * These two rules decide what closing a window means; they are pure so the Electron wiring stays thin.
 */

export type CloseDecision = "allow" | "confirm";

/**
 * Closing asks first only when it is the last window and a first index is still running: quitting would stop it.
 * While the other window stays open, the index (owned by the main process) keeps going.
 */
export function closeDecision(input: { readonly pending: boolean; readonly indexing: boolean; readonly windowsOpen: number }): CloseDecision {
	return input.pending && input.indexing && input.windowsOpen <= 1 ? "confirm" : "allow";
}

/**
 * Closing the onboarding window on a first index that stopped ends onboarding, the way "open anyway" used to:
 * the Finder then gets its keyword index. Closing before the index ran, or while it runs, keeps onboarding
 * for the next launch.
 */
export function completesOnClose(input: { readonly pending: boolean; readonly state: IndexingStatus["state"] }): boolean {
	return input.pending && input.state === "failed";
}
