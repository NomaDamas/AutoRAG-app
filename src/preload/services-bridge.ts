import type { IpcRenderer } from "electron";
import { SERVICES_CHANNELS, type ServicesBridge } from "../shared/services-contract";

/** Typed window.autorag.services wrappers over ipcRenderer.invoke on the contract channels. */
export function createServicesBridge(ipcRenderer: IpcRenderer): ServicesBridge {
	return {
		list: (paths) => ipcRenderer.invoke(SERVICES_CHANNELS.list, paths),
		run: (id, paths) => ipcRenderer.invoke(SERVICES_CHANNELS.run, id, paths),
	};
}
