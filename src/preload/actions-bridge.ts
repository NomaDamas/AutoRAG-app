import type { IpcRenderer } from "electron";
import { ACTIONS_CHANNELS, type ActionsBridge } from "../shared/actions-contract";

/** Typed window.autorag.actions wrappers over ipcRenderer.invoke on the contract channels. */
export function createActionsBridge(ipcRenderer: IpcRenderer): ActionsBridge {
	return {
		capabilities: () => ipcRenderer.invoke(ACTIONS_CHANNELS.capabilities),
		run: (path, request) => ipcRenderer.invoke(ACTIONS_CHANNELS.run, path, request),
		openWithApplications: (path) => ipcRenderer.invoke(ACTIONS_CHANNELS.openWithApplications, path),
		share: (path, anchor) => ipcRenderer.invoke(ACTIONS_CHANNELS.share, path, anchor),
	};
}
