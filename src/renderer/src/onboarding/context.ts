/**
 * The surface every onboarding step renders against: a read-only slice of the
 * controller state plus the actions the step can fire. Kept in its own module
 * so the step files stay presentational and the controller owns all state.
 */

import type { AccountStatus } from "../../../shared/account-contract";
import type {
	ByokProviderId,
	DetectedModelProvider,
	DetectedSource,
	EmbedMode,
	EmbeddingInfo,
	FolderCandidate,
	FolderScan,
	IndexingStatus,
	ModelOption,
	OnboardingDraft,
	OnboardingStepId,
	PermissionStatus,
	PlanId,
	SourceId,
} from "../../../shared/onboarding-contract";
import type { ModelDownloadControls } from "../state/model-download";
import type { Translate } from "./flow";
import type { SmartRun } from "./smart-scope";

export type OverlayKind = "fda" | "restart" | "notifications" | "winfw" | "win" | "pay";

export interface OnboardingCtx {
	readonly draft: OnboardingDraft;
	readonly platform: string;
	readonly permissions: PermissionStatus | null;
	/** The user said they allowed Full Disk Access but the probe still fails. */
	readonly fdaPending: boolean;
	/** Any selected folder still has an unfinished scan. */
	readonly scanning: boolean;
	readonly scans: ReadonlyMap<string, FolderScan>;
	/** Where the smart-indexing analysis of the selected folders stands; its proposals are `draft.smartScope`. */
	readonly smartRun: SmartRun;
	readonly candidates: readonly FolderCandidate[];
	readonly embedding: EmbeddingInfo | null;
	/** The on-device model's download: its status and the actions on it. Shared with Settings. */
	readonly modelDownload: ModelDownloadControls;
	readonly sources: readonly DetectedSource[];
	/** Source probes are still running; more rows may arrive. */
	readonly sourcesChecking: boolean;
	readonly models: readonly DetectedModelProvider[];
	readonly modelKey: string;
	readonly modelBaseUrl: string;
	readonly modelOptions: readonly ModelOption[];
	/** A verification round-trip is in flight. */
	readonly verifying: boolean;
	/** The last verification error, cleared on the next attempt. */
	readonly modelError: string | null;
	readonly indexStatus: IndexingStatus | null;
	/** Null until the main process answered the first status call. */
	readonly account: AccountStatus | null;
	readonly paying: boolean;
	readonly tipIndex: number;
	/** The welcome step's "send anonymous usage statistics" checkbox; saved to Settings when the user continues from that step. */
	readonly shareUsage: boolean;
	/** The welcome step's "send error reports" checkbox; saved to Settings when the user continues from that step. */
	readonly shareErrors: boolean;
	readonly t: Translate;

	patch(patch: Partial<OnboardingDraft>): void;
	setStep(id: OnboardingStepId): void;
	next(): void;
	back(): void;
	toast(message: string): void;
	openOverlay(kind: OverlayKind): void;
	closeOverlay(): void;

	setFolderSelected(path: string, selected: boolean): void;
	addFolders(): void;
	/** Selects every folder, or clears the selection when all are selected. */
	toggleAllFolders(): void;
	/** Starts the AI analysis of the selected folders (the scan screen starts it on entry). */
	startSmartScan(): void;
	cancelSmartScan(): void;
	/** Drops the proposals and goes back to the scan screen to analyse the selected folders again. */
	rescanSmart(): void;
	/** Sets whether one proposed folder is left out of the index. */
	setSmartExcluded(path: string, excluded: boolean): void;
	/** Picks folders inside the selected ones to leave out too; each is measured once it is added. */
	addExclusion(): void;

	setEmbedMode(mode: EmbedMode): void;
	setCloudConsent(consent: boolean): void;

	setSourceOn(id: SourceId, on: boolean): void;

	choosePlan(plan: PlanId): void;
	signIn(): void;
	cancelSignIn(): void;
	signOut(): void;
	/** The no-account path: pick BYOK and move on. */
	skipAccount(): void;
	/** Re-reads the account and opens the hosted checkout for the chosen paid plan. */
	openCheckout(): void;
	/** Re-reads the account from the server (the pay overlay's "check payment"). */
	refreshAccount(): void;
	setLaunchAtLogin(enabled: boolean): void;
	setShareUsage(value: boolean): void;
	setShareErrors(value: boolean): void;
	requestNotifications(): void;
	openNotificationSettings(): void;
	checkNetwork(): void;

	setModelProvider(provider: ByokProviderId): void;
	setModelKey(value: string): void;
	setModelBaseUrl(value: string): void;
	verifyModel(provider?: ByokProviderId): void;

	startIndexing(): void;
	finish(): void;
	finishInBackground(): void;
	setTipIndex(index: number): void;

	dragApp(): void;
	relaunch(): void;
	openFullDiskAccess(): void;
}
