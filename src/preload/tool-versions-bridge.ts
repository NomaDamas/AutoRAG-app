import type { IpcRenderer } from "electron";
import { TOOL_VERSIONS_CHANNELS, type ToolVersionsBridge } from "../shared/tool-versions-contract";

/** Typed `window.autorag.toolVersions` wrappers over the contract channels. */
export function createToolVersionsBridge(ipcRenderer: IpcRenderer): ToolVersionsBridge {
	return {
		get: () => ipcRenderer.invoke(TOOL_VERSIONS_CHANNELS.get),
		restartDaemon: () => ipcRenderer.invoke(TOOL_VERSIONS_CHANNELS.restartDaemon),
	};
}
