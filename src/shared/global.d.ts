import type { PreviewBridge } from "../preview/shared/contract";
import type { AccountBridge } from "./account-contract";
import type { AnalyticsBridge } from "./analytics-contract";
import type { ActionsBridge } from "./actions-contract";
import type { AutoRagBridge } from "./bridge";
import type { ConversionBridge } from "./conversion-contract";
import type { FsBridge } from "./fs-contract";
import type { IndexActivityBridge } from "./index-activity-contract";
import type { InteractionBridge } from "./interaction-contract";
import type { IndexProblemBridge } from "./index-problem-contract";
import type { LiveBridge } from "./live-contract";
import type { ModelDownloadBridge } from "./model-download-contract";
import type { OnboardingBridge } from "./onboarding-contract";
import type { OsRequestBridge } from "./os-request-contract";
import type { SearchBridge } from "./search-contract";
import type { SmartIndexingBridge } from "./smart-indexing-contract";
import type { SettingsBridge } from "./settings-contract";
import type { ServicesBridge } from "./services-contract";
import type { AppUpdateBridge } from "./update-contract";
import type { AutomationBridge } from "./automation-contract";

declare global {
	interface Window {
		readonly autorag: AutoRagBridge & {
			readonly fs: FsBridge;
			readonly actions: ActionsBridge;
			readonly analytics: AnalyticsBridge;
			readonly appUpdate: AppUpdateBridge;
			readonly account: AccountBridge;
			readonly automations: AutomationBridge;
			readonly conversion: ConversionBridge;
			readonly indexActivity: IndexActivityBridge;
			readonly interaction: InteractionBridge;
			readonly indexProblem: IndexProblemBridge;
			readonly live: LiveBridge;
			readonly modelDownload: ModelDownloadBridge;
			readonly onboarding: OnboardingBridge;
			readonly osRequests: OsRequestBridge;
			readonly preview: PreviewBridge;
			readonly search: SearchBridge;
			readonly smartIndexing: SmartIndexingBridge;
			readonly settings: SettingsBridge;
			readonly services: ServicesBridge;
			/** Absolute path of a dropped File (Electron `webUtils.getPathForFile`); "" when it has none on disk. */
			readonly pathForFile: (file: File) => string;
		};
	}
}
