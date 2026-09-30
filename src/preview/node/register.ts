import { ipcMain, protocol, type IpcMain } from "electron";
import { PREVIEW_CHANNELS } from "../shared/contract";
import { handlePreviewRequest } from "./protocol";
import { readPreviewFile } from "./read-file";

export function registerPreviewSchemes(): void {
	protocol.registerSchemesAsPrivileged([
		{
			scheme: "autorag-preview",
			privileges: {
				standard: true,
				secure: true,
				supportFetchAPI: true,
				stream: true,
				corsEnabled: true,
			},
		},
	]);
}

export function registerPreviewProtocol(): void {
	protocol.handle("autorag-preview", (request) => handlePreviewRequest(request));
}

function isReadRequest(value: unknown): value is { readonly path: string; readonly includeBytes: boolean } {
	if (typeof value !== "object" || value === null) return false;
	if (!("path" in value) || !("includeBytes" in value)) return false;
	return typeof value.path === "string" && value.path.length > 0 && typeof value.includeBytes === "boolean";
}

export function registerPreviewIpc(ipc: IpcMain = ipcMain): void {
	ipc.handle(PREVIEW_CHANNELS.read, (_event, request: unknown) => {
		if (!isReadRequest(request)) throw new Error("미리보기 요청이 올바르지 않습니다");
		return readPreviewFile(request.path, request.includeBytes);
	});
}
