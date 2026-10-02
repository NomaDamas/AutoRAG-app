import { protocol } from "electron";
import { PREVIEW_SCHEME } from "../shared/contract";
import { handlePreviewRequest } from "./protocol";

export { attachQuickLook, registerQuickLookIpc } from "./window";

export function registerPreviewSchemes(): void {
	protocol.registerSchemesAsPrivileged([
		{
			scheme: PREVIEW_SCHEME,
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
	protocol.handle(PREVIEW_SCHEME, (request) => handlePreviewRequest(request));
}
