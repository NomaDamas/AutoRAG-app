import type { IpcRenderer } from "electron";
import { CONVERSION_CHANNELS, type ConversionBridge } from "../shared/conversion-contract";

/** Typed window.autorag.conversion wrappers over ipcRenderer.invoke on the contract channels. */
export function createConversionBridge(ipcRenderer: IpcRenderer): ConversionBridge {
	return {
		plan: (oldName, newName) => ipcRenderer.invoke(CONVERSION_CHANNELS.plan, oldName, newName),
		run: (request) => ipcRenderer.invoke(CONVERSION_CHANNELS.run, request),
		cancel: (id) => ipcRenderer.invoke(CONVERSION_CHANNELS.cancel, id),
	};
}
