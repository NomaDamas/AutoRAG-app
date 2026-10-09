import type { IpcRenderer, IpcRendererEvent } from "electron";
import { OS_REQUEST_CHANNELS, type OsRequestBridge } from "../shared/os-request-contract";

/** Typed window.autorag.osRequests wrappers over the contract channels. */
export function createOsRequestBridge(ipcRenderer: IpcRenderer): OsRequestBridge {
	return {
		take: () => ipcRenderer.invoke(OS_REQUEST_CHANNELS.take),
		onAvailable(listener) {
			const handler = (_event: IpcRendererEvent): void => listener();
			ipcRenderer.on(OS_REQUEST_CHANNELS.available, handler);
			return () => {
				ipcRenderer.off(OS_REQUEST_CHANNELS.available, handler);
			};
		},
	};
}
