/**
 * The surface every onboarding step renders against: a read-only slice of the
 * controller state plus the actions the step can fire. Kept in its own module
 * so the step files stay presentational and the controller owns all state.
 */

import type {
	AccountMethod,
	ByokProviderId,
	DetectedModelProvider,
	DetectedSource,
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
import type { Translate } from "./flow";

export type OverlayKind = "fda" | "restart" | "why" | "notifications" | "winfw" | "win" | "pay";

export interface OnboardingCtx {
	readonly draft: OnboardingDraft;
	readonly platform: string;
	readonly permissions: PermissionStatus | null;
	/** The user said they allowed Full Disk Access but the probe still fails. */
	readonly fdaPending: boolean;
	/** Any selected folder still has an unfinished scan. */
	readonly scanning: boolean;
	readonly scans: ReadonlyMap<string, FolderScan>;
	readonly candidates: readonly FolderCandidate[];
	readonly embedding: EmbeddingInfo | null;
	readonly sources: readonly DetectedSource[];
	readonly models: readonly DetectedModelProvider[];
	readonly modelKey: string;
	readonly modelBaseUrl: string;
	readonly modelOptions: readonly ModelOption[];
	/** A verification round-trip is in flight. */
	readonly verifying: boolean;
	/** The last verification error, cleared on the next attempt. */
	readonly modelError: string | null;
	readonly indexStatus: IndexingStatus | null;
	readonly authBusy: boolean;
	readonly payAgree: boolean;
	readonly tipIndex: number;
	readonly t: Translate;

	patch(patch: Partial<OnboardingDraft>): void;
	setStep(id: OnboardingStepId): void;
	next(): void;
	back(): void;
	toast(message: string): void;
	openOverlay(kind: OverlayKind): void;
	closeOverlay(): void;

	setFolderSelected(path: string, selected: boolean): void;
	toggleAllFolders(): void;
	addFolders(): void;

	setSourceOn(id: SourceId, on: boolean): void;
	setSourceDescription(id: SourceId, description: string): void;
	rewriteSource(id: SourceId): void;

	choosePlan(plan: PlanId): void;
	signIn(method: AccountMethod, email?: string): void;
	signOut(): void;
	setLaunchAtLogin(enabled: boolean): void;
	requestNotifications(): void;
	openNotificationSettings(): void;
	checkNetwork(): void;

	setModelProvider(provider: ByokProviderId): void;
	setModelKey(value: string): void;
	setModelBaseUrl(value: string): void;
	verifyModel(provider?: ByokProviderId): void;

	setPayAgree(value: boolean): void;
	confirmPayment(): void;

	startIndexing(): void;
	finish(): void;
	setTipIndex(index: number): void;

	dragApp(): void;
	relaunch(): void;
	openFullDiskAccess(): void;
}
