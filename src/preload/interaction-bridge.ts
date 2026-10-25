import type { IpcRenderer } from "electron";
import {
	INTERACTION_CHANNELS,
	type ApprovalMode,
	type InteractionBridge,
	type InteractionClosed,
	type InteractionRequest,
} from "../shared/interaction-contract";

function subscribe<T>(ipcRenderer: IpcRenderer, channel: string, listener: (payload: T) => void): () => void {
	const handler = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload);
	ipcRenderer.on(channel, handler);
	return () => ipcRenderer.removeListener(channel, handler);
}

export function createInteractionBridge(ipcRenderer: IpcRenderer): InteractionBridge {
	return {
		getMode: () => ipcRenderer.invoke(INTERACTION_CHANNELS.getMode),
		setMode: (mode) => ipcRenderer.invoke(INTERACTION_CHANNELS.setMode, mode),
		pending: () => ipcRenderer.invoke(INTERACTION_CHANNELS.pending),
		answer: (id, answer) => ipcRenderer.invoke(INTERACTION_CHANNELS.answer, id, answer),
		onMode: (listener) => subscribe<ApprovalMode>(ipcRenderer, INTERACTION_CHANNELS.modeChanged, listener),
		onRequest: (listener) => subscribe<InteractionRequest>(ipcRenderer, INTERACTION_CHANNELS.request, listener),
		onClosed: (listener) => subscribe<InteractionClosed>(ipcRenderer, INTERACTION_CHANNELS.closed, listener),
	};
}
