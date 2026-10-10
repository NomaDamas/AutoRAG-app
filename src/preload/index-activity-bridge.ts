import type { IpcRenderer, IpcRendererEvent } from "electron";
import { INDEX_ACTIVITY_CHANNELS, type IndexActivityBridge, type IndexActivitySnapshot } from "../shared/index-activity-contract";

/** Typed window.autorag.indexActivity wrappers over the contract channels. */
export function createIndexActivityBridge(ipcRenderer: IpcRenderer): IndexActivityBridge {
	return {
		get: () => ipcRenderer.invoke(INDEX_ACTIVITY_CHANNELS.get),
		onChange: (listener) => {
			const handler = (_event: IpcRendererEvent, snapshot: IndexActivitySnapshot): void => listener(snapshot);
			ipcRenderer.on(INDEX_ACTIVITY_CHANNELS.changed, handler);
			return () => {
				ipcRenderer.removeListener(INDEX_ACTIVITY_CHANNELS.changed, handler);
			};
		},
	};
}
