import type { PreviewBridge } from "../preview/shared/contract";
import type { AutoRagBridge } from "./bridge";
import type { FsBridge } from "./fs-contract";
import type { LiveBridge } from "./live-contract";
import type { SearchBridge } from "./search-contract";
import type { SettingsBridge } from "./settings-contract";

declare global {
	interface Window {
		readonly autorag: AutoRagBridge & {
			readonly fs: FsBridge;
			readonly live: LiveBridge;
			readonly preview: PreviewBridge;
			readonly search: SearchBridge;
			readonly settings: SettingsBridge;
		};
	}
}
