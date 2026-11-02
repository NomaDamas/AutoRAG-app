import type { IpcRenderer, IpcRendererEvent } from "electron";
import { MAGIC_ACTION_CHANNELS, type MagicActionBridge, type MagicActionEvent } from "../shared/magic-actions-contract";

export function createMagicActionBridge(ipcRenderer: IpcRenderer): MagicActionBridge {
	return {
		start: (runId, request) => ipcRenderer.invoke(MAGIC_ACTION_CHANNELS.start, runId, request),
		cancel: (runId) => ipcRenderer.invoke(MAGIC_ACTION_CHANNELS.cancel, runId),
		onEvent: (listener) => {
			const handler = (_event: IpcRendererEvent, event: MagicActionEvent): void => listener(event);
			ipcRenderer.on(MAGIC_ACTION_CHANNELS.event, handler);
			return () => {
				ipcRenderer.removeListener(MAGIC_ACTION_CHANNELS.event, handler);
			};
		},
	};
}
