/**
 * First-run onboarding contract shared by the main process, the preload
 * bridge, and the renderer's onboarding flow
 * (design reference: docs/design-reference/onboarding/onboarding-prototype.html).
 *
 * The renderer owns the choices (the draft) and persists them through `save`
 * after every change, so a relaunch — macOS wants one after Full Disk Access
 * is granted — resumes at the same step with the same selections. The main
 * process owns everything that touches the OS or the shared AutoRAG config:
 * permission probes, folder pre-scans, connector detection, key verification
 * (secrets never cross back to the renderer), and the first index run.
 *
 * Deliberately not implemented (the account and billing backends do not exist
 * yet, so onboarding QA can still walk the whole flow):
 * - signing in only records the chosen method in the draft;
 * - checkout only records the chosen paid plan; card fields are never stored
 *   or sent anywhere;
 * - cloud embedding stays unavailable: corpus text never goes to a remote
 *   embedder (AGENTS.md), so the first index always embeds on this machine.
 */

export const ONBOARDING_CHANNELS = {
	load: "onboarding:load",
	save: "onboarding:save",
	permissions: "onboarding:permissions",
	openFullDiskAccess: "onboarding:openFullDiskAccess",
	dragApp: "onboarding:dragApp",
	relaunch: "onboarding:relaunch",
	requestNotifications: "onboarding:requestNotifications",
	openNotificationSettings: "onboarding:openNotificationSettings",
	checkNetwork: "onboarding:checkNetwork",
	setLaunchAtLogin: "onboarding:setLaunchAtLogin",
	folderCandidates: "onboarding:folderCandidates",
	pickFolders: "onboarding:pickFolders",
	scanFolders: "onboarding:scanFolders",
	/** main → renderer event carrying one {@link FolderScan}. */
	scanProgress: "onboarding:scanProgress",
	embedding: "onboarding:embedding",
	/**
	 * Starts a streamed probe of every connector: each usable one arrives as a
	 * {@link DetectedSource} on `sourceDetected`, then `sourcesDone` closes the run.
	 */
	detectSources: "onboarding:detectSources",
	/** main → renderer event carrying one {@link DetectedSource}, as soon as its probe finishes. */
	sourceDetected: "onboarding:sourceDetected",
	/** main → renderer event (no payload) once every probe has finished. */
	sourcesDone: "onboarding:sourcesDone",
	detectModels: "onboarding:detectModels",
	verifyModel: "onboarding:verifyModel",
	startIndexing: "onboarding:startIndexing",
	indexStatus: "onboarding:indexStatus",
	/** main → renderer event carrying one {@link IndexingStatus}. */
	indexProgress: "onboarding:indexProgress",
	complete: "onboarding:complete",
} as const;

/** Preload argument the main process adds when the window opens on onboarding. */
export const ONBOARDING_PENDING_FLAG = "--autorag-onboarding=1";

/** Files per minute the local embedder sustains on a first index; every local ETA uses it. */
export const LOCAL_FILES_PER_MINUTE = 85;

/** Files per minute a cloud embedder would sustain; shown only as the comparison figure. */
export const CLOUD_FILES_PER_MINUTE = 900;

export type OnboardingStepId =
	| "welcome"
	| "permissions"
	| "account"
	| "folders"
	| "embedding"
	| "sources"
	| "plan"
	| "model"
	| "indexing";

export type PlanId = "free" | "air" | "pro" | "byok";

export type ByokProviderId = "anthropic" | "openai" | "openrouter" | "google" | "ollama" | "openai-compatible";

/**
 * Connectors the sources step can detect as installed, signed in, and holding data.
 * Local files are indexed through the folders step, so Spotlight/Apple Mail are
 * deliberately not offered here.
 */
export type SourceId = "kakao" | "slack" | "discord" | "telegram" | "whatsapp" | "mailcrawl" | "github" | "obsidian";

export type AccountMethod = "apple" | "google" | "email";

export interface OnboardingFolderChoice {
	readonly path: string;
	readonly selected: boolean;
}

export interface OnboardingSourceChoice {
	readonly id: SourceId;
	readonly on: boolean;
}

export interface OnboardingModelChoice {
	readonly provider: ByokProviderId;
	/** Only for `openai-compatible`; "" otherwise. */
	readonly baseUrl: string;
	/** Chosen model id; "" until a verification returned the list. */
	readonly modelId: string;
	readonly verified: boolean;
}

/** Everything the user picked so far. Persisted verbatim by `save`. */
export interface OnboardingDraft {
	readonly version: 1;
	readonly stepId: OnboardingStepId;
	/** Placeholder sign-in: the chosen method only (no account backend yet). */
	readonly account: { readonly method: AccountMethod; readonly email: string | null } | null;
	readonly notifications: boolean;
	/** Windows: outbound network reachability was confirmed. */
	readonly network: boolean;
	readonly launchAtLogin: boolean;
	/** Candidate and user-added folders, in display order. */
	readonly folders: readonly OnboardingFolderChoice[];
	readonly sources: readonly OnboardingSourceChoice[];
	readonly plan: PlanId;
	/** The plan step was passed once; it then leaves the step list (back skips it). */
	readonly planConfirmed: boolean;
	/** Placeholder checkout: the paid plan recorded without a billing backend. */
	readonly paid: PlanId | null;
	readonly model: OnboardingModelChoice | null;
}

export interface OnboardingSnapshot {
	/** True while onboarding still has to run in this window. */
	readonly pending: boolean;
	/** Null on a first launch: the renderer seeds a fresh draft. */
	readonly draft: OnboardingDraft | null;
}

export interface PermissionStatus {
	/** `process.platform`. */
	readonly platform: string;
	/** macOS Full Disk Access probe (reads a TCC-protected file); null where the platform has no such gate. */
	readonly fullDiskAccess: boolean | null;
	/** The stored launch-at-login choice (applied to the OS login item in packaged builds). */
	readonly launchAtLogin: boolean;
	readonly notificationsSupported: boolean;
}

export interface NetworkCheck {
	readonly ok: boolean;
	readonly error: string | null;
}

export type FolderKind = "desktop" | "documents" | "icloud" | "downloads" | "pictures" | "cloud" | "custom";

export interface FolderCandidate {
	readonly path: string;
	/** Display name, e.g. "Documents", "Google Drive - me@example.com". */
	readonly name: string;
	/** `~`-abbreviated path for display. */
	readonly displayPath: string;
	readonly kind: FolderKind;
	/** Documents, Desktop, iCloud Drive start selected; Downloads and the rest do not. */
	readonly defaultSelected: boolean;
	/** Images in this folder are skipped because OCR is off in the shared config. */
	readonly ocrOff: boolean;
}

/** Running totals of one folder's pre-scan (supported, size-capped files outside skipped folders). */
export interface FolderScan {
	readonly path: string;
	readonly files: number;
	readonly bytes: number;
	/** Cloud placeholders (iCloud / File Provider files not downloaded yet). */
	readonly onlineOnly: number;
	readonly done: boolean;
	readonly error: string | null;
}

export interface EmbeddingInfo {
	/** Local profile the first index uses. */
	readonly profile: string;
	readonly modelBytes: number;
	/** The model file is already in the AutoRAG model cache (no download needed). */
	readonly cached: boolean;
	/** The shared config already names an embedder; onboarding leaves it as is. */
	readonly configured: boolean;
}

/** Metadata a detected connector exposes, shown as its second line. */
export interface SourceFacts {
	readonly repos?: readonly string[];
	readonly vaults?: readonly string[];
	/** himalaya accounts whose login was verified; one mailcrawl archive each. */
	readonly accounts?: readonly string[];
	readonly workspaces?: number;
	readonly channels?: number;
	readonly chats?: number;
	readonly messages?: number;
}

export interface DetectedSource {
	readonly id: SourceId;
	readonly facts: SourceFacts;
}

/** Every usable connector from one probe run; `startIndexing` re-reads it for the facts. */
export interface SourceDetection {
	readonly sources: readonly DetectedSource[];
}

/** Listener for one connector that finished probing as usable. */
export type DetectedSourceListener = (source: DetectedSource) => void;

export interface DetectedModelProvider {
	readonly provider: ByokProviderId;
	/** Where the credential/runtime was found. */
	readonly origin: "env" | "stored" | "local";
	/** API-key variable the credential lives in (null for a local runtime). */
	readonly envName: string | null;
}

export interface ModelOption {
	readonly id: string;
	readonly name: string;
}

export interface ModelVerifyRequest {
	readonly provider: ByokProviderId;
	/** Null: verify the credential already in the environment / encrypted store. */
	readonly apiKey: string | null;
	/** Required for `openai-compatible`; ignored otherwise. */
	readonly baseUrl: string | null;
}

export type ModelVerifyResult =
	| {
			readonly ok: true;
			readonly envName: string | null;
			readonly models: readonly ModelOption[];
			readonly recommended: string;
	  }
	| { readonly ok: false; readonly error: string };

export interface IndexingRequest {
	readonly folders: readonly string[];
	readonly sources: readonly { readonly id: SourceId }[];
	readonly plan: PlanId;
	/** BYOK only. */
	readonly model: { readonly provider: ByokProviderId; readonly modelId: string; readonly baseUrl: string | null } | null;
}

export type IndexingPhase = "parsed" | "minsync" | "datasources" | "finalizing";

export interface IndexingStatus {
	readonly state: "idle" | "running" | "success" | "failed";
	readonly phase: IndexingPhase | null;
	/** 0–100: measured in the read phase, estimated from elapsed time in the later ones. */
	readonly progress: number;
	/** Null when unknown (idle) or done. */
	readonly remainingMinutes: number | null;
	/** Files the pre-scan expects the read phase to handle. */
	readonly totalFiles: number;
	/** Files the read phase has handled so far. */
	readonly processedFiles: number;
	/** Most recently read file name, and the display name of the selected folder it is under. */
	readonly recentFile: string | null;
	readonly recentFolder: string | null;
	/** Display names of the data sources being indexed. */
	readonly sources: readonly string[];
	readonly startedAt: string | null;
	readonly finishedAt: string | null;
	readonly error: string | null;
}

export interface OnboardingBridge {
	/** True when this window opened on onboarding (preload argument; `load` is authoritative). */
	readonly pending: boolean;
	load(): Promise<OnboardingSnapshot>;
	save(draft: OnboardingDraft): Promise<void>;
	permissions(): Promise<PermissionStatus>;
	/** Opens System Settings › Privacy & Security › Full Disk Access. */
	openFullDiskAccess(): Promise<void>;
	/** Starts the OS drag of the app bundle (the guide's "drag this icon into the list"). */
	dragApp(): void;
	/** Quit and reopen the app (Full Disk Access applies to a running app only after a relaunch). */
	relaunch(): Promise<void>;
	/** Shows a real system notification; resolves whether the OS displayed it. */
	requestNotifications(): Promise<boolean>;
	/** Opens the OS notification settings. */
	openNotificationSettings(): Promise<void>;
	checkNetwork(): Promise<NetworkCheck>;
	/** Persists `launchAtLogin` (applied to the OS in packaged builds); returns the stored value. */
	setLaunchAtLogin(enabled: boolean): Promise<boolean>;
	folderCandidates(): Promise<readonly FolderCandidate[]>;
	/** Native multi-folder chooser; empty when cancelled. */
	pickFolders(): Promise<readonly FolderCandidate[]>;
	/** Starts (or reuses) a pre-scan for each path; totals arrive through `onScanProgress`. */
	scanFolders(paths: readonly string[]): Promise<void>;
	onScanProgress(listener: (scan: FolderScan) => void): () => void;
	embedding(): Promise<EmbeddingInfo>;
	/** Starts a probe run (restarting one in flight); results arrive through the two listeners below. */
	detectSources(): Promise<void>;
	onSourceDetected(listener: DetectedSourceListener): () => void;
	onSourcesDone(listener: () => void): () => void;
	detectModels(): Promise<readonly DetectedModelProvider[]>;
	/** Calls the provider; on success an entered key is stored encrypted, never in config. */
	verifyModel(request: ModelVerifyRequest): Promise<ModelVerifyResult>;
	/** Writes the choices into the shared AutoRAG config and starts the first index (reused while running). */
	startIndexing(request: IndexingRequest): Promise<IndexingStatus>;
	indexStatus(): Promise<IndexingStatus>;
	onIndexProgress(listener: (status: IndexingStatus) => void): () => void;
	/** Marks onboarding done and resizes the window for the Finder. */
	complete(): Promise<void>;
}
