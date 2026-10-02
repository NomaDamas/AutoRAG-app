import type { IpcRenderer } from "electron";
import { LIVE_CHANNELS, type LiveBridge, type LiveMessage } from "../shared/live-contract";

export function createLiveBridge(ipcRenderer: IpcRenderer): LiveBridge {
	return {
		setWatchSet: (dirs) => ipcRenderer.invoke(LIVE_CHANNELS.setWatchSet, dirs),
		layers: () => ipcRenderer.invoke(LIVE_CHANNELS.layers),
		onMessage: (listener) => {
			const handler = (_event: unknown, message: LiveMessage): void => listener(message);
			ipcRenderer.on(LIVE_CHANNELS.message, handler);
			return () => {
				ipcRenderer.removeListener(LIVE_CHANNELS.message, handler);
			};
		},
	};
}
