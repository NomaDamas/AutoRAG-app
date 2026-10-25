import { useSyncExternalStore } from "react";
import { NO_INDEX_PROBLEM, type IndexProblem, type IndexProblemBridge } from "../../../shared/index-problem-contract";

/** `window.autorag` as the preload installs it; absent in a browser-only dev run. */
type IndexProblemWindow = Window & { readonly autorag?: { readonly indexProblem?: IndexProblemBridge } };

/**
 * One subscription for the window: the sidebar block, the banner above the file
 * list, and the Settings card read the same record. Unlike the activity
 * snapshot, the main process keeps this one until the index works again or the
 * user dismisses it, so it is what a user sees after a relaunch.
 */
let current: IndexProblem = NO_INDEX_PROBLEM;
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;

function bridge(): IndexProblemBridge | undefined {
	const rendererWindow: IndexProblemWindow = window;
	return rendererWindow.autorag?.indexProblem;
}

function publish(next: IndexProblem): void {
	current = next;
	for (const listener of listeners) listener();
}

function connect(): void {
	// The preload contract is installed before the renderer bundle executes.
	const api = bridge();
	if (api === undefined) return;
	unsubscribe = api.onChange(publish);
	void api.get().then(publish, () => undefined);
}

function subscribe(listener: () => void): () => void {
	if (listeners.size === 0) connect();
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) {
			unsubscribe?.();
			unsubscribe = null;
		}
	};
}

export function useIndexProblem(): IndexProblem {
	return useSyncExternalStore(
		subscribe,
		() => current,
		() => NO_INDEX_PROBLEM,
	);
}

/**
 * Run the local index again. A rejection here has no caller to reach — the click
 * that asked for it is long gone — and the window's toast lives in App's state,
 * out of reach of a window-wide hook, so it goes to the console with the
 * problem still on screen for another try.
 */
export function retryIndexProblem(): void {
	void bridge()?.retry().catch((error: unknown) => {
		console.error("index retry failed", error);
	});
}

/** Hide the problem until a run leaves a new one. */
export function dismissIndexProblem(): void {
	void bridge()?.dismiss().catch((error: unknown) => {
		console.error("index problem dismiss failed", error);
	});
}
