import { useSyncExternalStore } from "react";
import type { FinderController } from "./useFinderController";

/**
 * Every pane owns a Finder controller; the window chrome (sidebar, toolbar,
 * inspector, context menu) follows the focused one. Panes publish their
 * controller here after each render, and the chrome subscribes, so a pane
 * re-render updates the chrome without re-rendering the other panes and a
 * focus change never remounts the chrome.
 */
export interface ControllerStore {
	publish(paneId: number, controller: FinderController): void;
	remove(paneId: number, controller: FinderController): void;
	get(paneId: number): FinderController | undefined;
	subscribe(listener: () => void): () => void;
}

export function createControllerStore(): ControllerStore {
	const controllers = new Map<number, FinderController>();
	const listeners = new Set<() => void>();
	const notify = (): void => {
		for (const listener of listeners) listener();
	};
	return {
		publish(paneId, controller) {
			if (controllers.get(paneId) === controller) return;
			controllers.set(paneId, controller);
			notify();
		},
		remove(paneId, controller) {
			// A StrictMode remount publishes again before this cleanup can drop a newer controller.
			if (controllers.get(paneId) !== controller) return;
			controllers.delete(paneId);
			notify();
		},
		get: (paneId) => controllers.get(paneId),
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

/** The focused pane's controller; undefined for the one pre-paint pass before it first publishes. */
export function usePaneController(store: ControllerStore, paneId: number): FinderController | undefined {
	return useSyncExternalStore(store.subscribe, () => store.get(paneId));
}
