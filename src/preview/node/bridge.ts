import type { IpcRenderer } from "electron";
import { isPreviewDocument, PREVIEW_CHANNELS, type PreviewBridge } from "../shared/contract";

export function createPreviewBridge(ipcRenderer: IpcRenderer): PreviewBridge {
	return {
		read: async (path, includeBytes) => {
			const value: unknown = await ipcRenderer.invoke(PREVIEW_CHANNELS.read, { path, includeBytes });
			if (!isPreviewDocument(value)) throw new Error("미리보기 응답이 올바르지 않습니다");
			return value;
		},
	};
}
