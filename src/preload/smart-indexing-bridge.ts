import type { IpcRenderer, IpcRendererEvent } from "electron";
import { SMART_INDEXING_CHANNELS, type SmartIndexingBridge, type SmartIndexingEvent } from "../shared/smart-indexing-contract";

export function createSmartIndexingBridge(ipcRenderer: IpcRenderer): SmartIndexingBridge {
	return {
		analyze: (runId, roots) => ipcRenderer.invoke(SMART_INDEXING_CHANNELS.analyze, runId, roots),
		cancel: (runId) => ipcRenderer.invoke(SMART_INDEXING_CHANNELS.cancel, runId),
		onEvent: (listener) => {
			const handler = (_event: IpcRendererEvent, payload: SmartIndexingEvent): void => listener(payload);
			ipcRenderer.on(SMART_INDEXING_CHANNELS.event, handler);
			return () => ipcRenderer.removeListener(SMART_INDEXING_CHANNELS.event, handler);
		},
	};
}
