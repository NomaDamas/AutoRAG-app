import { APP_VERSION, type DevLabel } from "./app-info";

export interface AutoRagBridge {
	readonly version: string;
	/** The host `process.platform`, so the renderer labels shortcuts for the real OS. */
	readonly platform: string;
	/** Present only for unpackaged/dev runs: which clone this window runs from. */
	readonly dev: DevLabel | null;
}

export function createBridge(dev: DevLabel | null = null, platform: string = "darwin"): AutoRagBridge {
	return { version: APP_VERSION, platform, dev };
}
