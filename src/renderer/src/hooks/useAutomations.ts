import { useMemo, useSyncExternalStore } from "react";
import type { AutomationBridge } from "../../../shared/automation-contract";
import { createAutomationsStore, type AutomationsStore, type AutomationsView } from "../state/automations-store";

/** `window.autorag` as the preload installs it; absent in a browser-only dev run. */
type AutomationsWindow = Window & { readonly autorag?: { readonly automations?: AutomationBridge } };

/**
 * The window's one copy of the automation rules. The store listens to the main
 * process only while a component is subscribed, so a window that never opens the
 * 자동화 tab or a folder with rules costs nothing beyond the first read.
 */
export function useAutomations(): { readonly view: AutomationsView; readonly store: AutomationsStore } {
	const store = useMemo(() => {
		const rendererWindow: AutomationsWindow = window;
		return createAutomationsStore(rendererWindow.autorag?.automations);
	}, []);
	const view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
	return { view, store };
}
