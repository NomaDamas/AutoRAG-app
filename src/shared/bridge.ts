import { APP_VERSION, type DevLabel } from "./app-info";
import type { AppSettings } from "./settings-contract";

export interface AutoRagBridge {
	readonly version: string;
	/** The host `process.platform`, so the renderer labels shortcuts for the real OS. */
	readonly platform: string;
	/** Present only for unpackaged/dev runs: which clone this window runs from. */
	readonly dev: DevLabel | null;
	/** Initial interface language passed via Electron argv so React mounts without blocking on an IPC round-trip. */
	readonly initialLanguage?: AppSettings["language"];
}

export function createBridge(
	dev: DevLabel | null = null,
	platform: string = "darwin",
	initialLanguage?: AppSettings["language"],
): AutoRagBridge {
	return initialLanguage === undefined ? { version: APP_VERSION, platform, dev } : { version: APP_VERSION, platform, dev, initialLanguage };
}
