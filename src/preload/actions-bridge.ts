import type { IpcRenderer } from "electron";
import { ACTIONS_CHANNELS, type ActionsBridge } from "../shared/actions-contract";

/** Typed window.autorag.actions wrappers over ipcRenderer.invoke on the contract channels. */
export function createActionsBridge(ipcRenderer: IpcRenderer): ActionsBridge {
	return {
		capabilities: () => ipcRenderer.invoke(ACTIONS_CHANNELS.capabilities),
		run: (paths, request) => ipcRenderer.invoke(ACTIONS_CHANNELS.run, paths, request),
		openWithApplications: (path) => ipcRenderer.invoke(ACTIONS_CHANNELS.openWithApplications, path),
		share: (paths, anchor) => ipcRenderer.invoke(ACTIONS_CHANNELS.share, paths, anchor),
	};
}
