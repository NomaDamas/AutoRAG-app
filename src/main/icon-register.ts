import { protocol } from "electron";
import type { IconStore } from "./file-icon";
import { THUMB_SCHEME, handleIconRequest } from "./icon-protocol";

/**
 * Register `autorag-thumb://` as a privileged scheme. Like the preview scheme
 * this must run before `app.whenReady()` so Chromium treats it as standard and
 * secure, letting `<img src>` load it from the isolated renderer.
 */
export function registerIconSchemes(): void {
	protocol.registerSchemesAsPrivileged([
		{
			scheme: THUMB_SCHEME,
			privileges: {
				standard: true,
				secure: true,
				supportFetchAPI: true,
				corsEnabled: true,
			},
		},
	]);
}

/** Serve cached icon bytes after app-ready; reads the shared provider cache. */
export function registerIconProtocol(store: IconStore): void {
	protocol.handle(THUMB_SCHEME, (request) => handleIconRequest(request, store));
}
