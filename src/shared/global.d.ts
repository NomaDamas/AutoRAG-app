import type { PreviewBridge } from "../preview/shared/contract";
import type { ActionsBridge } from "./actions-contract";
import type { AutoRagBridge } from "./bridge";
import type { FsBridge } from "./fs-contract";
import type { LiveBridge } from "./live-contract";
import type { OnboardingBridge } from "./onboarding-contract";
import type { OsRequestBridge } from "./os-request-contract";
import type { SearchBridge } from "./search-contract";
import type { SettingsBridge } from "./settings-contract";
import type { ServicesBridge } from "./services-contract";

declare global {
	interface Window {
		readonly autorag: AutoRagBridge & {
			readonly fs: FsBridge;
			readonly actions: ActionsBridge;
			readonly live: LiveBridge;
			readonly onboarding: OnboardingBridge;
			readonly osRequests: OsRequestBridge;
			readonly preview: PreviewBridge;
			readonly search: SearchBridge;
			readonly settings: SettingsBridge;
			readonly services: ServicesBridge;
			/** Absolute path of a dropped File (Electron `webUtils.getPathForFile`); "" when it has none on disk. */
			readonly pathForFile: (file: File) => string;
		};
	}
}
