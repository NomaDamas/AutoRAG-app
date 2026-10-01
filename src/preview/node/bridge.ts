import type { IpcRenderer, IpcRendererEvent } from "electron";
import {
	isNavigateDelta,
	isQuickLookLoad,
	PREVIEW_CHANNELS,
	type PreviewBridge,
	type QuickLookWindowBridge,
} from "../shared/contract";

function subscribe(ipcRenderer: IpcRenderer, channel: string, listener: (payload: unknown) => void): () => void {
	const handler = (_event: IpcRendererEvent, payload: unknown): void => listener(payload);
	ipcRenderer.on(channel, handler);
	return () => {
		ipcRenderer.off(channel, handler);
	};
}

export function createPreviewBridge(ipcRenderer: IpcRenderer): PreviewBridge {
	return {
		show: async (target) => {
			await ipcRenderer.invoke(PREVIEW_CHANNELS.show, { path: target.path, name: target.name });
		},
		hide: async () => {
			await ipcRenderer.invoke(PREVIEW_CHANNELS.hide);
		},
		onClosed: (listener) => subscribe(ipcRenderer, PREVIEW_CHANNELS.closed, () => listener()),
		onNavigate: (listener) =>
			subscribe(ipcRenderer, PREVIEW_CHANNELS.navigate, (delta) => {
				if (isNavigateDelta(delta)) listener(delta);
			}),
	};
}

export function createQuickLookWindowBridge(ipcRenderer: IpcRenderer, platform: string): QuickLookWindowBridge {
	return {
		platform,
		onLoad: (listener) =>
			subscribe(ipcRenderer, PREVIEW_CHANNELS.load, (load) => {
				if (isQuickLookLoad(load)) listener(load);
			}),
		onUnload: (listener) => subscribe(ipcRenderer, PREVIEW_CHANNELS.unload, () => listener()),
		ready: (report) => ipcRenderer.send(PREVIEW_CHANNELS.ready, report),
		request: async (action) => {
			await ipcRenderer.invoke(PREVIEW_CHANNELS.request, action);
		},
	};
}
