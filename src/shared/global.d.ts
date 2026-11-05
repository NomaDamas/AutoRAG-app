import type { PreviewBridge } from "../preview/shared/contract";
import type { AccountBridge } from "./account-contract";
import type { AnalyticsBridge } from "./analytics-contract";
import type { ActionsBridge } from "./actions-contract";
import type { AppCustomizerBridge } from "./app-customizer-contract";
import type { AutoRagBridge } from "./bridge";
import type { ConversionBridge } from "./conversion-contract";
import type { ErrorFixBridge } from "./error-fix-contract";
import type { MagicActionBridge } from "./magic-actions-contract";
import type { FsBridge } from "./fs-contract";
import type { IndexActivityBridge } from "./index-activity-contract";
import type { InteractionBridge } from "./interaction-contract";
import type { IndexProblemBridge } from "./index-problem-contract";
import type { LiveBridge } from "./live-contract";
import type { ModelDownloadBridge } from "./model-download-contract";
import type { OnboardingBridge } from "./onboarding-contract";
import type { OsRequestBridge } from "./os-request-contract";
import type { SearchBridge } from "./search-contract";
import type { SettingsBridge } from "./settings-contract";
import type { ServicesBridge } from "./services-contract";
import type { RemoteAccessBridge } from "./remote-contract";
import type { VoiceBridge } from "./voice-contract";
import type { QuickSearchSettingsBridge } from "./quick-search-contract";
import type { AppUpdateBridge } from "./update-contract";
import type { AutomationBridge } from "./automation-contract";
import type { DemoBridge } from "./demo-contract";

declare global {
	interface Window {
		readonly autorag: AutoRagBridge & {
			readonly fs: FsBridge;
			readonly actions: ActionsBridge;
			readonly analytics: AnalyticsBridge;
			readonly appCustomizer: AppCustomizerBridge;
			readonly appUpdate: AppUpdateBridge;
			readonly account: AccountBridge;
			readonly automations: AutomationBridge;
			readonly demo: DemoBridge;
			readonly conversion: ConversionBridge;
			readonly errorFix: ErrorFixBridge;
			readonly magicAction: MagicActionBridge;
			readonly indexActivity: IndexActivityBridge;
			readonly interaction: InteractionBridge;
			readonly indexProblem: IndexProblemBridge;
			readonly live: LiveBridge;
			readonly modelDownload: ModelDownloadBridge;
			readonly onboarding: OnboardingBridge;
			readonly voice: VoiceBridge;
			readonly osRequests: OsRequestBridge;
			readonly preview: PreviewBridge;
			readonly search: SearchBridge;
			readonly settings: SettingsBridge;
			readonly services: ServicesBridge;
			readonly remote: RemoteAccessBridge;
			/** The launcher's global shortcut, for Settings; absent in a remote browser session. */
			readonly quickSearch?: QuickSearchSettingsBridge;
			/** Absolute path of a dropped File (Electron `webUtils.getPathForFile`); "" when it has none on disk. */
			readonly pathForFile: (file: File) => string;
		};
		readonly autoragIsRemote?: boolean;
	}
}
