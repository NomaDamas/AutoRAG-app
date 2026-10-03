import { protocol, type CustomScheme } from "electron";
import type { IconStore } from "./file-icon";
import { THUMB_SCHEME, handleIconRequest } from "./icon-protocol";

/**
 * `autorag-thumb://` privileges. Chromium must treat it as standard and
 * secure so `<img src>` loads it from the isolated renderer; it is registered
 * with the other schemes before `app.whenReady()` (src/main/index.ts).
 */
export const THUMB_PRIVILEGED_SCHEME: CustomScheme = {
	scheme: THUMB_SCHEME,
	privileges: {
		standard: true,
		secure: true,
		supportFetchAPI: true,
		corsEnabled: true,
	},
};

/** Serve cached icon bytes after app-ready; reads the shared provider cache. */
export function registerIconProtocol(store: IconStore): void {
	protocol.handle(THUMB_SCHEME, (request) => handleIconRequest(request, store));
}
