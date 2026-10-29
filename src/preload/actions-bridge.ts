import type { IpcRenderer, IpcRendererEvent } from "electron";
import { ACTIONS_CHANNELS, type ActionProgressEvent, type ActionsBridge } from "../shared/actions-contract";

/** Typed window.autorag.actions wrappers over ipcRenderer.invoke on the contract channels. */
export function createActionsBridge(ipcRenderer: IpcRenderer): ActionsBridge {
	return {
		capabilities: () => ipcRenderer.invoke(ACTIONS_CHANNELS.capabilities),
		run: (paths, request) => ipcRenderer.invoke(ACTIONS_CHANNELS.run, paths, request),
		cancel: (id) => ipcRenderer.invoke(ACTIONS_CHANNELS.cancel, id),
		onProgress: (listener) => {
			const handler = (_event: IpcRendererEvent, payload: ActionProgressEvent): void => listener(payload);
			ipcRenderer.on(ACTIONS_CHANNELS.progress, handler);
			return () => {
				ipcRenderer.removeListener(ACTIONS_CHANNELS.progress, handler);
			};
		},
		openWithApplications: (path) => ipcRenderer.invoke(ACTIONS_CHANNELS.openWithApplications, path),
		share: (paths, anchor) => ipcRenderer.invoke(ACTIONS_CHANNELS.share, paths, anchor),
	};
}
