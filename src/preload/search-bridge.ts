import type { IpcRenderer } from "electron";
import { SEARCH_CHANNELS, type SearchBridge, type SearchStreamEvent } from "../shared/search-contract";

export function createSearchBridge(ipcRenderer: IpcRenderer): SearchBridge {
	return {
		start: (searchId, chatId, query, attachments) =>
			ipcRenderer.invoke(SEARCH_CHANNELS.start, searchId, chatId, query, attachments),
		steer: (searchId, text) => ipcRenderer.invoke(SEARCH_CHANNELS.steer, searchId, text),
		cancel: (searchId) => ipcRenderer.invoke(SEARCH_CHANNELS.cancel, searchId),
		historyList: () => ipcRenderer.invoke(SEARCH_CHANNELS.historyList),
		historyGet: (chatId) => ipcRenderer.invoke(SEARCH_CHANNELS.historyGet, chatId),
		historySearch: (query) => ipcRenderer.invoke(SEARCH_CHANNELS.historySearch, query),
		historyClear: () => ipcRenderer.invoke(SEARCH_CHANNELS.historyClear),
		onEvent: (listener: (event: SearchStreamEvent) => void) => {
			const handler = (_event: Electron.IpcRendererEvent, payload: SearchStreamEvent): void => listener(payload);
			ipcRenderer.on(SEARCH_CHANNELS.event, handler);
			return () => ipcRenderer.removeListener(SEARCH_CHANNELS.event, handler);
		},
	};
}
