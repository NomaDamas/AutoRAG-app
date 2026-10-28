import type { IpcRenderer, IpcRendererEvent } from "electron";
import { ERROR_FIX_CHANNELS, type ErrorFixBridge, type ErrorFixEvent } from "../shared/error-fix-contract";

export function createErrorFixBridge(ipcRenderer: IpcRenderer): ErrorFixBridge {
	return {
		start: (runId, request) => ipcRenderer.invoke(ERROR_FIX_CHANNELS.start, runId, request),
		cancel: (runId) => ipcRenderer.invoke(ERROR_FIX_CHANNELS.cancel, runId),
		onEvent: (listener) => {
			const handler = (_event: IpcRendererEvent, payload: ErrorFixEvent): void => listener(payload);
			ipcRenderer.on(ERROR_FIX_CHANNELS.event, handler);
			return () => ipcRenderer.removeListener(ERROR_FIX_CHANNELS.event, handler);
		},
	};
}
