import type { IpcRenderer, IpcRendererEvent } from "electron";
import { LTR_CHANNELS, type LtrBridge } from "../shared/ltr-contract";

/** Typed window.autorag.ltr wrappers over the contract channels. */
export function createLtrBridge(ipcRenderer: IpcRenderer): LtrBridge {
	return {
		get: () => ipcRenderer.invoke(LTR_CHANNELS.get),
		train: () => ipcRenderer.invoke(LTR_CHANNELS.train),
		deleteModel: (id) => ipcRenderer.invoke(LTR_CHANNELS.deleteModel, id),
		onTraining: (listener) => {
			const handler = (_event: IpcRendererEvent, running: boolean): void => listener(running);
			ipcRenderer.on(LTR_CHANNELS.training, handler);
			return () => {
				ipcRenderer.removeListener(LTR_CHANNELS.training, handler);
			};
		},
	};
}
