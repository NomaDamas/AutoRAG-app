import type { IpcRenderer, IpcRendererEvent } from "electron";
import { MODEL_DOWNLOAD_CHANNELS, type ModelDownloadBridge, type ModelDownloadStatus } from "../shared/model-download-contract";

/** Typed window.autorag.modelDownload wrappers over the contract channels. */
export function createModelDownloadBridge(ipcRenderer: IpcRenderer): ModelDownloadBridge {
	return {
		get: () => ipcRenderer.invoke(MODEL_DOWNLOAD_CHANNELS.get),
		start: () => ipcRenderer.invoke(MODEL_DOWNLOAD_CHANNELS.start),
		cancel: () => ipcRenderer.invoke(MODEL_DOWNLOAD_CHANNELS.cancel),
		onChange: (listener) => {
			const handler = (_event: IpcRendererEvent, status: ModelDownloadStatus): void => listener(status);
			ipcRenderer.on(MODEL_DOWNLOAD_CHANNELS.changed, handler);
			return () => {
				ipcRenderer.removeListener(MODEL_DOWNLOAD_CHANNELS.changed, handler);
			};
		},
	};
}
