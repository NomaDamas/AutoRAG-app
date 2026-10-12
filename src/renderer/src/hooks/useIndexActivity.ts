import { useSyncExternalStore } from "react";
import { IDLE_INDEX_ACTIVITY, type IndexActivityBridge, type IndexActivitySnapshot } from "../../../shared/index-activity-contract";

/** `window.autorag` as the preload installs it; absent in a browser-only dev run. */
type IndexActivityWindow = Window & { readonly autorag?: { readonly indexActivity?: IndexActivityBridge } };

/**
 * One subscription for the window: the sidebar block and the Settings card read
 * the same snapshot. The main process pushes only when it changed.
 */
let current: IndexActivitySnapshot = IDLE_INDEX_ACTIVITY;
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;

function publish(next: IndexActivitySnapshot): void {
	current = next;
	for (const listener of listeners) listener();
}

function connect(): void {
	// The preload contract is installed before the renderer bundle executes.
	const rendererWindow: IndexActivityWindow = window;
	const bridge = rendererWindow.autorag?.indexActivity;
	if (bridge === undefined) return;
	unsubscribe = bridge.onChange(publish);
	void bridge.get().then(publish, () => undefined);
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

export function useIndexActivity(): IndexActivitySnapshot {
	return useSyncExternalStore(
		subscribe,
		() => current,
		() => IDLE_INDEX_ACTIVITY,
	);
}
