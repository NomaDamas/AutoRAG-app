import { useEffect, useState } from "react";
import type { AppUpdateBridge, AppUpdateSnapshot } from "../../../shared/update-contract";

/** `window.autorag` as the preload installs it; absent in a browser-only dev run. */
type AppUpdateWindow = Window & { readonly autorag?: { readonly appUpdate?: AppUpdateBridge } };

/** The updater's snapshot, live; `null` before the first read and when there is no preload bridge. */
export function useAppUpdate(): { readonly snapshot: AppUpdateSnapshot | null; readonly bridge: AppUpdateBridge | null } {
	const rendererWindow: AppUpdateWindow = window;
	const bridge = rendererWindow.autorag?.appUpdate ?? null;
	const [snapshot, setSnapshot] = useState<AppUpdateSnapshot | null>(null);
	useEffect(() => {
		if (bridge === null) return undefined;
		let live = true;
		const unsubscribe = bridge.onChange((next) => {
			if (live) setSnapshot(next);
		});
		void bridge.get().then(
			(next) => {
				if (live) setSnapshot(next);
			},
			() => undefined,
		);
		return () => {
			live = false;
			unsubscribe();
		};
	}, [bridge]);
	return { snapshot, bridge };
}
