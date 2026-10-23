import type { IpcRenderer, IpcRendererEvent } from "electron";
import { AUTOMATION_CHANNELS, type AutomationBridge, type AutomationsSnapshot } from "../shared/automation-contract";

/** Typed window.autorag.automations wrappers over the contract channels. */
export function createAutomationBridge(ipcRenderer: IpcRenderer): AutomationBridge {
	return {
		get: () => ipcRenderer.invoke(AUTOMATION_CHANNELS.get),
		remove: (id) => ipcRenderer.invoke(AUTOMATION_CHANNELS.remove, id),
		restore: (removal) => ipcRenderer.invoke(AUTOMATION_CHANNELS.restore, removal),
		setDaemon: (enabled) => ipcRenderer.invoke(AUTOMATION_CHANNELS.setDaemon, enabled),
		onChange: (listener) => {
			const handler = (_event: IpcRendererEvent, snapshot: AutomationsSnapshot): void => listener(snapshot);
			ipcRenderer.on(AUTOMATION_CHANNELS.changed, handler);
			return () => {
				ipcRenderer.removeListener(AUTOMATION_CHANNELS.changed, handler);
			};
		},
	};
}
