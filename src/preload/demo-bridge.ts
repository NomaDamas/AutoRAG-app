import type { IpcRenderer } from "electron";
import { DEMO_CHANNELS, type DemoBridge } from "../shared/demo-contract";

/** Typed window.autorag.demo wrappers over the contract channels. */
export function createDemoBridge(ipcRenderer: IpcRenderer): DemoBridge {
	return {
		prepareAutomation: () => ipcRenderer.invoke(DEMO_CHANNELS.prepareAutomation),
		triggerAutomation: () => ipcRenderer.invoke(DEMO_CHANNELS.triggerAutomation),
		prepareMagicAction: () => ipcRenderer.invoke(DEMO_CHANNELS.prepareMagicAction),
	};
}
