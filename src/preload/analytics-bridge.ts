import type { IpcRenderer } from "electron";
import { ANALYTICS_CHANNELS, type AnalyticsBridge } from "../shared/analytics-contract";

/** Typed window.autorag.analytics: a one-way send; the main process validates it and decides whether anything leaves the machine. */
export function createAnalyticsBridge(ipcRenderer: IpcRenderer): AnalyticsBridge {
	return {
		track: (event, properties) => ipcRenderer.send(ANALYTICS_CHANNELS.track, event, properties),
	};
}
