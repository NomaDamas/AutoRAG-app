import type { IpcRenderer, IpcRendererEvent } from "electron";
import { APP_UPDATE_CHANNELS, type AppUpdateBridge, type AppUpdateSnapshot } from "../shared/update-contract";

/** Typed window.autorag.appUpdate wrappers over the contract channels. */
export function createAppUpdateBridge(ipcRenderer: IpcRenderer): AppUpdateBridge {
	return {
		get: () => ipcRenderer.invoke(APP_UPDATE_CHANNELS.get),
		check: () => ipcRenderer.invoke(APP_UPDATE_CHANNELS.check),
		download: () => ipcRenderer.invoke(APP_UPDATE_CHANNELS.download),
		install: () => ipcRenderer.invoke(APP_UPDATE_CHANNELS.install),
		onChange: (listener) => {
			const handler = (_event: IpcRendererEvent, snapshot: AppUpdateSnapshot): void => listener(snapshot);
			ipcRenderer.on(APP_UPDATE_CHANNELS.changed, handler);
			return () => {
				ipcRenderer.removeListener(APP_UPDATE_CHANNELS.changed, handler);
			};
		},
	};
}
