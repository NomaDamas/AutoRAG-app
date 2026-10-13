import type { IpcRenderer, IpcRendererEvent } from "electron";
import { isAppLanguage, LANGUAGE_CHANNELS } from "../../shared/language-contract";
import type { AppSettings } from "../../shared/settings-contract";
import {
	isNavigateDelta,
	isQuickLookApp,
	isQuickLookLoad,
	isQuickLookZoom,
	PREVIEW_CHANNELS,
	type AudioMetadata,
	type FileDetails,
	type FolderSize,
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
		show: async (target, origin) => {
			await ipcRenderer.invoke(PREVIEW_CHANNELS.show, { path: target.path, name: target.name }, origin);
		},
		hide: async (origin) => {
			await ipcRenderer.invoke(PREVIEW_CHANNELS.hide, origin);
		},
		onClosed: (listener) => subscribe(ipcRenderer, PREVIEW_CHANNELS.closed, () => listener()),
		onNavigate: (listener) =>
			subscribe(ipcRenderer, PREVIEW_CHANNELS.navigate, (delta) => {
				if (isNavigateDelta(delta)) listener(delta);
			}),
	};
}

export function createQuickLookWindowBridge(ipcRenderer: IpcRenderer, platform: string, language: AppSettings["language"]): QuickLookWindowBridge {
	return {
		platform,
		language,
		onLanguage: (listener) =>
			subscribe(ipcRenderer, LANGUAGE_CHANNELS.changed, (next) => {
				if (isAppLanguage(next)) listener(next);
			}),
		onLoad: (listener) =>
			subscribe(ipcRenderer, PREVIEW_CHANNELS.load, (load) => {
				if (isQuickLookLoad(load)) listener(load);
			}),
		onUnload: (listener) => subscribe(ipcRenderer, PREVIEW_CHANNELS.unload, () => listener()),
		onZoom: (listener) =>
			subscribe(ipcRenderer, PREVIEW_CHANNELS.zoom, (zoom) => {
				if (isQuickLookZoom(zoom)) listener(zoom);
			}),
		onApp: (listener) =>
			subscribe(ipcRenderer, PREVIEW_CHANNELS.app, (update) => {
				if (isQuickLookApp(update)) listener(update);
			}),
		ready: (report) => ipcRenderer.send(PREVIEW_CHANNELS.ready, report),
		zoomed: (report) => ipcRenderer.send(PREVIEW_CHANNELS.zoomed, report),
		request: async (action) => {
			await ipcRenderer.invoke(PREVIEW_CHANNELS.request, action);
		},
		details: (path): Promise<FileDetails> => ipcRenderer.invoke(PREVIEW_CHANNELS.details, path),
		sha256: (path): Promise<string> => ipcRenderer.invoke(PREVIEW_CHANNELS.sha256, path),
		folderSize: (path): Promise<FolderSize> => ipcRenderer.invoke(PREVIEW_CHANNELS.folderSize, path),
		audioMetadata: (path): Promise<AudioMetadata> => ipcRenderer.invoke(PREVIEW_CHANNELS.audioMetadata, path),
		share: async (anchor) => {
			await ipcRenderer.invoke(PREVIEW_CHANNELS.share, { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height });
		},
		copyText: async (text) => {
			await ipcRenderer.invoke(PREVIEW_CHANNELS.copyText, text);
		},
	};
}
