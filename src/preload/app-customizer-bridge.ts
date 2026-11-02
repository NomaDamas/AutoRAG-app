import type { IpcRenderer, IpcRendererEvent } from "electron";
import { APP_CUSTOMIZER_CHANNELS, type AppCustomizerBridge, type AppCustomizerEvent } from "../shared/app-customizer-contract";

export function createAppCustomizerBridge(ipcRenderer: IpcRenderer): AppCustomizerBridge {
	return {
		send: (runId, request) => ipcRenderer.invoke(APP_CUSTOMIZER_CHANNELS.send, runId, request),
		cancel: (runId) => ipcRenderer.invoke(APP_CUSTOMIZER_CHANNELS.cancel, runId),
		reset: (sessionId) => ipcRenderer.invoke(APP_CUSTOMIZER_CHANNELS.reset, sessionId),
		onEvent: (listener) => {
			const handler = (_event: IpcRendererEvent, event: AppCustomizerEvent): void => listener(event);
			ipcRenderer.on(APP_CUSTOMIZER_CHANNELS.event, handler);
			return () => {
				ipcRenderer.removeListener(APP_CUSTOMIZER_CHANNELS.event, handler);
			};
		},
	};
}
