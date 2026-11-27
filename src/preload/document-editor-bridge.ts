import type { IpcRenderer, IpcRendererEvent } from "electron";
import { isDocumentEditEvent } from "../preview/shared/annotation";
import {
	DOCUMENT_EDITOR_CHANNELS,
	isPdfChangedEvent,
	type DocumentEditorBridge,
} from "../shared/document-editor-contract";

export function createDocumentEditorBridge(ipcRenderer: IpcRenderer): DocumentEditorBridge {
	return {
		open: (path) => ipcRenderer.invoke(DOCUMENT_EDITOR_CHANNELS.open, path),
		save: (request) => ipcRenderer.invoke(DOCUMENT_EDITOR_CHANNELS.save, request),
		pdfApply: (request) => ipcRenderer.invoke(DOCUMENT_EDITOR_CHANNELS.pdfApply, request),
		pdfExtract: (request) => ipcRenderer.invoke(DOCUMENT_EDITOR_CHANNELS.pdfExtract, request),
		pdfSplit: (request) => ipcRenderer.invoke(DOCUMENT_EDITOR_CHANNELS.pdfSplit, request),
		pdfPickMergeFiles: () => ipcRenderer.invoke(DOCUMENT_EDITOR_CHANNELS.pdfPickMergeFiles),
		pdfRestore: (snapshotId) => ipcRenderer.invoke(DOCUMENT_EDITOR_CHANNELS.pdfRestore, snapshotId),
		pdfReadMetadata: (path) => ipcRenderer.invoke(DOCUMENT_EDITOR_CHANNELS.pdfReadMetadata, path),
		pdfReadFormFields: (path) => ipcRenderer.invoke(DOCUMENT_EDITOR_CHANNELS.pdfReadFormFields, path),
		pdfSaveFormFields: (request) => ipcRenderer.invoke(DOCUMENT_EDITOR_CHANNELS.pdfSaveFormFields, request),
		onPdfChanged: (listener) => {
			const handler = (_event: IpcRendererEvent, event: unknown): void => {
				if (isPdfChangedEvent(event)) listener(event);
			};
			ipcRenderer.on(DOCUMENT_EDITOR_CHANNELS.pdfChanged, handler);
			return () => {
				ipcRenderer.removeListener(DOCUMENT_EDITOR_CHANNELS.pdfChanged, handler);
			};
		},
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
