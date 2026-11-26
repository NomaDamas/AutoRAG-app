import type { IpcRenderer, IpcRendererEvent } from "electron";
import {
	DEFAULT_FILE_MANAGER_CHANNELS,
	type DefaultFileManagerBridge,
	type DefaultFileManagerStatus,
} from "../shared/default-file-manager-contract";

export function createDefaultFileManagerBridge(ipcRenderer: IpcRenderer): DefaultFileManagerBridge {
	return {
		status: () => ipcRenderer.invoke(DEFAULT_FILE_MANAGER_CHANNELS.status),
		apply: (request) => ipcRenderer.invoke(DEFAULT_FILE_MANAGER_CHANNELS.apply, request),
		onChange: (listener) => {
			const handler = (_event: IpcRendererEvent, status: DefaultFileManagerStatus): void => listener(status);
			ipcRenderer.on(DEFAULT_FILE_MANAGER_CHANNELS.changed, handler);
			return () => {
				ipcRenderer.removeListener(DEFAULT_FILE_MANAGER_CHANNELS.changed, handler);
			};
		},
	};
}
