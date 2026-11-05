/**
 * First-run contract shared by the main process, the preload bridge, and the
 * Finder window's first-run layer (`src/renderer/src/first-run/`).
 *
 * The first run asks nothing it can decide itself. The Finder window opens with
 * the pending flag; the layer calls `start` at once and shows one progress bar
 * while the main process does the rest on its own (macOS asks for per-folder
 * access as each default folder is read; refused folders are left out):
 *
 *  1. `scanning`  — pre-scans the default folders (Desktop, Documents, Downloads,
 *     iCloud Drive), which gives the index its file total;
 *  2. `planning`  — when a model can be called, smart indexing proposes generated
 *     sub-folders to leave out and every proposal is taken; without a model the
 *     app's code-folder exclusions are all there is;
 *  3. `indexing`  — writes the folders into the shared AutoRAG config in
 *     keyword-only mode (parsed mirror + MinSync's bundled SPLADE encoder; dense
 *     embedding stays opt-in in Settings) and runs the first index;
 *  4. `preparing` — starts a duplicate (dupey) scan, and picks one question from
 *     the user's own documents that keyword retrieval provably answers from that
 *     document, for the guided tour;
 *  5. `ready`.
 *
 * Account and plan come at the end of the tour, never before the first index.
 */

export const ONBOARDING_CHANNELS = {
	load: "onboarding:load",
	permissions: "onboarding:permissions",
	openFullDiskAccess: "onboarding:openFullDiskAccess",
	// Full Disk Access is deferred to the features that really need it (Finder tag colours, KakaoTalk/WhatsApp/Mail).
	/** Starts the setup run, or returns the one in flight / finished. */
	start: "onboarding:start",
	status: "onboarding:status",
	/** main → renderer event carrying one {@link SetupStatus}. */
	progress: "onboarding:progress",
	complete: "onboarding:complete",
} as const;

/** Preload argument the main process adds while the first run is still pending. */
export const ONBOARDING_PENDING_FLAG = "--autorag-onboarding=1";

/**
 * Files per minute the keyword-only path sustains (documents are read and listed, never embedded).
 * With a floor of {@link NONE_MIN_MINUTES}: the folder walk and parse have a fixed cost.
 */
export const NONE_FILES_PER_MINUTE = 450;
export const NONE_MIN_MINUTES = 8;

export interface OnboardingSnapshot {
	/** True while the first run still has to happen. */
	readonly pending: boolean;
	/** False when `AUTORAG_SKIP_ONBOARDING=1` (QA lanes): the contextual tutorials stay off too. */
	readonly tutorials: boolean;
}

export interface PermissionStatus {
	/** `process.platform`. */
	readonly platform: string;
	/** macOS Full Disk Access probe (opens a TCC-protected file); null where the platform has no such gate. */
	readonly fullDiskAccess: boolean | null;
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

export type SetupStage = "idle" | "scanning" | "planning" | "indexing" | "preparing" | "ready" | "failed";

/** The question the tour asks: generated from one indexed document and found by keyword retrieval. */
export interface FirstRunDemo {
	readonly question: string;
	/** The document the question came from. */
	readonly sourcePath: string;
	/** How long the verifying retrieval took. */
	readonly latencyMs: number;
}

export interface SetupStatus {
	readonly stage: SetupStage;
	/** 0–100 across every stage; reaches 100 only at `ready`. */
	readonly progress: number;
	/** Null when unknown, or once indexing is over. */
	readonly remainingMinutes: number | null;
	/** Files the first index expects to read (pre-scan totals minus left-out folders). */
	readonly totalFiles: number;
	/** Files the first index has read so far. */
	readonly processedFiles: number;
	/** Most recently read file name, while indexing. */
	readonly recentFile: string | null;
	/** Sub-folders smart indexing left out. */
	readonly excludedFolders: number;
	/** The tour's question; null until `ready`, and at `ready` when no model could be called or no question survived the check. */
	readonly demo: FirstRunDemo | null;
	/** Why the run stopped; null unless `stage` is `failed`. */
	readonly error: string | null;
	readonly startedAt: string | null;
	readonly finishedAt: string | null;
}

export interface OnboardingBridge {
	/** True when this window opened on the first run (preload argument; `load` is authoritative). */
	readonly pending: boolean;
	load(): Promise<OnboardingSnapshot>;
	permissions(): Promise<PermissionStatus>;
	/** Opens System Settings › Privacy & Security › Full Disk Access. */
	openFullDiskAccess(): Promise<void>;
	// System Settings offers Quit & Reopen itself once Full Disk Access is toggled for a running app.
	/** Starts the setup run (a failed one starts again); resolves with its status right away. */
	start(): Promise<SetupStatus>;
	status(): Promise<SetupStatus>;
	onProgress(listener: (status: SetupStatus) => void): () => void;
	/** Marks the first run done: the next launch opens the Finder straight away. */
	complete(): Promise<void>;
}
