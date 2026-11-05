import type { IpcRenderer } from "electron";
import { DEMO_CHANNELS, type DemoBridge } from "../shared/demo-contract";

/** Typed window.autorag.demo wrappers over the contract channels. */
export function createDemoBridge(ipcRenderer: IpcRenderer): DemoBridge {
	return {
		preparePhoto: () => ipcRenderer.invoke(DEMO_CHANNELS.preparePhoto),
		ensureDaemon: () => ipcRenderer.invoke(DEMO_CHANNELS.ensureDaemon),
		prepareMagicAction: () => ipcRenderer.invoke(DEMO_CHANNELS.prepareMagicAction),
	};
}
