import { protocol, type CustomScheme } from "electron";
import { PREVIEW_SCHEME } from "../shared/contract";
import { handlePreviewRequest } from "./protocol";

export { attachQuickLook, registerQuickLookIpc } from "./window";

/**
 * `autorag-preview://` privileges. Electron honours only one
 * `registerSchemesAsPrivileged` call, so the main process registers every
 * scheme together (src/main/index.ts). `supportFetchAPI` lets the audio
 * waveform fetch the file; `stream` lets media seek.
 */
export const PREVIEW_PRIVILEGED_SCHEME: CustomScheme = {
	scheme: PREVIEW_SCHEME,
	privileges: {
		standard: true,
		secure: true,
		supportFetchAPI: true,
		stream: true,
		corsEnabled: true,
	},
};

export function registerPreviewProtocol(): void {
	protocol.handle(PREVIEW_SCHEME, (request) => handlePreviewRequest(request));
}
