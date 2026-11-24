import type { IpcRenderer, IpcRendererEvent } from "electron";
import { isDocumentEditEvent } from "../preview/shared/annotation";
import {
	DOCUMENT_EDITOR_CHANNELS,
	type DocumentEditorBridge,
} from "../shared/document-editor-contract";

export function createDocumentEditorBridge(ipcRenderer: IpcRenderer): DocumentEditorBridge {
	return {
		open: (path) => ipcRenderer.invoke(DOCUMENT_EDITOR_CHANNELS.open, path),
		save: (request) => ipcRenderer.invoke(DOCUMENT_EDITOR_CHANNELS.save, request),
		aiStart: (runId, request, capture) => ipcRenderer.invoke(DOCUMENT_EDITOR_CHANNELS.aiStart, runId, request, capture),
		aiCancel: (runId) => ipcRenderer.invoke(DOCUMENT_EDITOR_CHANNELS.aiCancel, runId),
		aiUndo: (runId) => ipcRenderer.invoke(DOCUMENT_EDITOR_CHANNELS.aiUndo, runId),
		onAiEvent: (listener) => {
			const handler = (_event: IpcRendererEvent, event: unknown): void => {
				if (isDocumentEditEvent(event)) listener(event);
			};
			ipcRenderer.on(DOCUMENT_EDITOR_CHANNELS.aiEvent, handler);
			return () => {
				ipcRenderer.removeListener(DOCUMENT_EDITOR_CHANNELS.aiEvent, handler);
			};
		},
	};
}
