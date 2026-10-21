import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { readRawConfigObject, writeConfigObject } from "@autorag/librarian/core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_ACCOUNT_BASE_URL } from "../shared/account-contract";
import { readDazziPlanCredential } from "./dazzi-plan-credential";
import {
	ONBOARDING_CHANNELS,
	type ByokProviderId,
	type DetectedModelProvider,
	type DetectedSource,
	type EmbedMode,
	type EmbeddingInfo,
	type FolderCandidate,
	type FolderScan,
	type IndexingPhase,
	type IndexingRequest,
	type IndexingStatus,
	type NetworkCheck,
	type OnboardingDraft,
	type OnboardingModelChoice,
	type OnboardingSnapshot,
	type OnboardingSourceChoice,
	type PermissionStatus,
	type PlanId,
	type SourceDetection,
	type SourceFacts,
	type SourceId,
	type ModelVerifyRequest,
	type ModelVerifyResult,
} from "../shared/onboarding-contract";
import type { AppSettings, ConfigRefreshResult } from "../shared/settings-contract";
import { isJsonObject } from "../shared/settings-contract";
import { t } from "../shared/i18n/core";
import { applyIndexingConfig, buildDatasourceEntries } from "./onboarding-config";
import { PROVIDER_ENV_NAME } from "./onboarding-models";
import { computeIndexingProgress } from "./onboarding-progress";
import type { ProviderCredentialService } from "./provider-credentials";
import { localEmbeddingModel } from "./embedding-daemon";
import { minSyncModelCacheRoot, modelFilesPresent, modelTotalBytes, nativeQwen3Spec } from "./model-download";

/**
 * The main-process half of onboarding: everything that touches the OS or the
 * shared AutoRAG config. The renderer owns the draft and persists it through
 * `save`; this service owns permission probes, folder pre-scans, connector
 * detection, key verification (secrets never cross back), and the first index.
 * Account sign-in and checkout are placeholders — the choice is recorded, never
 * sent anywhere.
 */

const EMBEDDER_ID = "native:Qwen/Qwen3-Embedding-0.6B";
const EMBEDDER_DIMENSION = 1024;
const DAZZI_CLOUD_EMBEDDER_ID = "openai:qwen/qwen3-embedding-0.6b";
const DAZZI_CLOUD_EMBEDDER_KEY_ENV = "OPENAI_API_KEY";
const POLL_INTERVAL_MS = 1000;
const SOURCE_LABELS: Readonly<Record<SourceId, string>> = {
	kakao: "KakaoTalk",
	slack: "Slack",
	discord: "Discord",
	telegram: "Telegram",
	whatsapp: "WhatsApp",
	mailcrawl: "Mail",
	github: "GitHub",
	obsidian: "Obsidian",
};

export interface OnboardingServiceDeps {
	readonly userDataDir: string;
	readonly env: NodeJS.ProcessEnv;
	/** Pi's agent home, where the account's plan credential lives. Defaults to Pi's own. */
	readonly agentDir?: string;
	/** The process cwd the app seeds a fresh config's `workspacePath` with. */
	readonly cwd: string;
	readonly platform: NodeJS.Platform;
	readonly home: string;
	readonly knownFolders: {
		readonly desktop: string;
		readonly documents: string;
		readonly downloads: string;
		readonly pictures: string;
	};
	readonly iCloudDrivePath: string | null;
	readonly cloudDrives: () => Promise<readonly { readonly path: string; readonly name: string }[]>;
	readonly ocrEnabled: () => Promise<boolean>;
	readonly configPath: string;
	readonly resolveWorkspacePath: () => Promise<string>;
	readonly refresh: (methods?: readonly string[]) => Promise<ConfigRefreshResult>;
	/**
	 * Makes sure the on-device embedding model is on this computer, downloading it (with progress, through the
	 * model download service) when it is not. Resolves null when it is there, else the reason it could not be.
	 */
	readonly ensureLocalModel: () => Promise<string | null>;
	/** Background datasource sync triggered once both onboarding and the local index have completed. */
	readonly syncDatasources?: (aliases: readonly string[]) => Promise<void>;
	readonly credentials: ProviderCredentialService;
	readonly settings: {
		get(): Promise<AppSettings>;
		set(patch: Partial<AppSettings>): Promise<AppSettings>;
	};
	readonly detectSources: (onFound?: (source: DetectedSource) => void) => Promise<SourceDetection>;
	readonly gitToken: () => Promise<string | null>;
	/** Points the AutoRAG agent at the signed-in account's managed models (managed plans only). */
	readonly useManagedModel: () => Promise<unknown>;
	readonly detectModels: () => Promise<readonly DetectedModelProvider[]>;
	readonly verifyModel: (request: ModelVerifyRequest) => Promise<ModelVerifyResult>;
	readonly send: (channel: string, payload: unknown) => void;
	readonly openExternal: (url: string) => Promise<void>;
	readonly relaunch: () => void;
	readonly appBundlePath: () => string;
	readonly startDrag: (path: string) => void;
	readonly pickFolders: () => Promise<readonly string[]>;
	readonly showNotification: () => Promise<boolean>;
	readonly notificationsSupported: () => boolean;
	readonly loginItemApplied: (enabled: boolean) => boolean;
	readonly startPowerSaveBlocker: () => number;
	readonly stopPowerSaveBlocker: (id: number) => void;
	readonly probeFullDiskAccess: () => Promise<boolean>;
	readonly checkNetwork: () => Promise<NetworkCheck>;
	/** Starts (or re-emits) a pre-scan per path; totals stream through `send`. */
	readonly startScans: (paths: readonly string[]) => Promise<void>;
	readonly listDatalessPaths?: (root: string) => Promise<ReadonlySet<string>>;
	/** Sum of the given folders' finished pre-scans, for the ETA denominator. */
	readonly folderTotals: (paths: readonly string[]) => number;
	readonly onComplete: () => void;
	readonly now?: () => number;
}

export interface OnboardingService {
	pending(): boolean;
	load(): Promise<OnboardingSnapshot>;
	save(draft: unknown): Promise<void>;
	permissions(): Promise<PermissionStatus>;
	openFullDiskAccess(): Promise<void>;
	dragApp(): void;
	relaunch(): Promise<void>;
	requestNotifications(): Promise<boolean>;
	openNotificationSettings(): Promise<void>;
	checkNetwork(): Promise<NetworkCheck>;
	setLaunchAtLogin(enabled: boolean): Promise<boolean>;
	folderCandidates(): Promise<readonly FolderCandidate[]>;
	pickFolders(): Promise<readonly FolderCandidate[]>;
	scanFolders(paths: readonly unknown[]): Promise<void>;
	embedding(): Promise<EmbeddingInfo>;
	/** Starts a streamed probe (restarting any in flight); finds are pushed as `sourceDetected`, then `sourcesDone`. */
	detectSources(): Promise<void>;
	detectModels(): Promise<readonly DetectedModelProvider[]>;
	verifyModel(request: unknown): Promise<ModelVerifyResult>;
	startIndexing(request: unknown): Promise<IndexingStatus>;
	indexStatus(): Promise<IndexingStatus>;
	/** Sync: is a first index running right now (quit-confirmation gate). */
	isIndexing(): boolean;
	complete(): Promise<void>;
	dispose(): void;
}

interface PersistedIndexingState {
	readonly startedAt: string;
	readonly finishedAt: string | null;
}

interface PersistedOnboardingState {
	readonly completed: boolean;
	readonly draft: OnboardingDraft | null;
	readonly indexing?: PersistedIndexingState;
}

const STEP_IDS: Readonly<Record<string, true>> = {
	welcome: true,
	permissions: true,
	account: true,
	folders: true,
	smartScan: true,
	smartScope: true,
	embedding: true,
	sources: true,
	plan: true,
	model: true,
	indexing: true,
};
const PLAN_IDS: Readonly<Record<string, true>> = { free: true, air: true, pro: true, byok: true };
const EMBED_MODES: Readonly<Record<string, true>> = { none: true, local: true, cloud: true };
const BYOK_PROVIDERS: Readonly<Record<string, true>> = {
	anthropic: true,
	openai: true,
	openrouter: true,
	google: true,
	ollama: true,
	"openai-compatible": true,
};
const SOURCE_IDS: Readonly<Record<string, true>> = {
	kakao: true,
	slack: true,
	discord: true,
	telegram: true,
	whatsapp: true,
	mailcrawl: true,
	github: true,
	obsidian: true,
};

function onboardingStatePath(userDataDir: string): string {
	return join(userDataDir, "onboarding", "state.json");
}

function readOnboardingState(userDataDir: string): PersistedOnboardingState | null {
	const path = onboardingStatePath(userDataDir);
	if (!existsSync(path)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isJsonObject(parsed) || typeof parsed.completed !== "boolean") return null;
		return parsed as unknown as PersistedOnboardingState;
	} catch {
		return null;
	}
}

/** Pending when no state file exists and the QA skip flag is unset; otherwise the stored flag. */
export function readOnboardingPending(userDataDir: string, env: NodeJS.ProcessEnv): boolean {
	const state = readOnboardingState(userDataDir);
	if (state !== null) return !state.completed;
	return env.AUTORAG_SKIP_ONBOARDING !== "1";
}

function isAbsoluteString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value));
}

function isFolderChoice(value: unknown): boolean {
	return isJsonObject(value) && isAbsoluteString(value.path) && typeof value.selected === "boolean";
}

function isSmartExclusionChoice(value: unknown): boolean {
	return (
		isJsonObject(value) &&
		isAbsoluteString(value.path) &&
		isAbsoluteString(value.root) &&
		typeof value.reason === "string" &&
		typeof value.files === "number" &&
		Number.isInteger(value.files) &&
		value.files >= 0 &&
		typeof value.bytes === "number" &&
		Number.isFinite(value.bytes) &&
		value.bytes >= 0 &&
		typeof value.excluded === "boolean"
	);
}

function isSourceChoice(value: unknown): boolean {
	return isJsonObject(value) && typeof value.id === "string" && SOURCE_IDS[value.id] === true && typeof value.on === "boolean";
}

function isModelChoice(value: unknown): value is OnboardingModelChoice {
	return (
		isJsonObject(value) &&
		typeof value.provider === "string" &&
		BYOK_PROVIDERS[value.provider] === true &&
		typeof value.baseUrl === "string" &&
		typeof value.modelId === "string" &&
		typeof value.verified === "boolean"
	);
}

function isOnboardingDraft(value: unknown): value is OnboardingDraft {
	if (!isJsonObject(value)) return false;
	if (value.version !== 1) return false;
	if (typeof value.stepId !== "string" || STEP_IDS[value.stepId] !== true) return false;
	if (typeof value.notifications !== "boolean") return false;
	if (typeof value.network !== "boolean") return false;
	if (typeof value.launchAtLogin !== "boolean") return false;
	if (!Array.isArray(value.folders) || !value.folders.every(isFolderChoice)) return false;
	if (value.embed !== undefined && (typeof value.embed !== "string" || EMBED_MODES[value.embed] !== true)) return false;
	if (value.cloudConsent !== undefined && typeof value.cloudConsent !== "boolean") return false;
	if (!Array.isArray(value.sources) || !value.sources.every(isSourceChoice)) return false;
	if (typeof value.plan !== "string" || PLAN_IDS[value.plan] !== true) return false;
	if (typeof value.planConfirmed !== "boolean") return false;
	if (value.model !== null && !isModelChoice(value.model)) return false;
	if (value.smartScope !== undefined && (!Array.isArray(value.smartScope) || !value.smartScope.every(isSmartExclusionChoice))) return false;
	if (value.smartScopeRoots !== undefined && (!Array.isArray(value.smartScopeRoots) || !value.smartScopeRoots.every(isAbsoluteString))) return false;
	return true;
}

function isIndexingRequest(value: unknown): value is IndexingRequest {
	if (!isJsonObject(value)) return false;
	if (!Array.isArray(value.folders) || !value.folders.every(isAbsoluteString)) return false;
	if (value.folders.length === 0) return false;
	if (value.embed !== undefined && (typeof value.embed !== "string" || EMBED_MODES[value.embed] !== true)) return false;
	if (value.excludePaths !== undefined && (!Array.isArray(value.excludePaths) || !value.excludePaths.every(isAbsoluteString))) return false;
	if (value.excludedFiles !== undefined && (typeof value.excludedFiles !== "number" || !Number.isInteger(value.excludedFiles) || value.excludedFiles < 0)) return false;
	if (!Array.isArray(value.sources)) return false;
	for (const source of value.sources) {
		if (!isJsonObject(source) || typeof source.id !== "string" || SOURCE_IDS[source.id] !== true) return false;
	}
	if (typeof value.plan !== "string" || PLAN_IDS[value.plan] !== true) return false;
	const model = value.model;
	if (model !== null) {
		if (!isJsonObject(model) || typeof model.provider !== "string" || BYOK_PROVIDERS[model.provider] !== true) return false;
		if (typeof model.modelId !== "string") return false;
		if (model.baseUrl !== null && typeof model.baseUrl !== "string") return false;
	}
	return true;
}

function isModelVerifyRequest(value: unknown): value is ModelVerifyRequest {
	if (!isJsonObject(value)) return false;
	if (typeof value.provider !== "string" || BYOK_PROVIDERS[value.provider] !== true) return false;
	if (value.apiKey !== null && typeof value.apiKey !== "string") return false;
	if (value.baseUrl !== null && typeof value.baseUrl !== "string") return false;
	return true;
}

function abbreviateHome(path: string, home: string): string {
	if (path === home) return "~";
	if (path.startsWith(`${home}${sep}`)) return `~${path.slice(home.length)}`;
	return path;
}

function displayNameFromPath(path: string): string {
	const name = basename(path);
	return name.length > 0 ? name : path;
}

const IDLE_STATUS: IndexingStatus = {
	state: "idle",
	phase: null,
	progress: 0,
	remainingMinutes: null,
	totalFiles: 0,
	processedFiles: 0,
	recentFile: null,
	recentFolder: null,
	sources: [],
	startedAt: null,
	finishedAt: null,
	error: null,
};

/** Map a librarian refresh phase to a local onboarding contract phase (`jikji`/search phases fold into finalizing). */
function toIndexingPhase(value: unknown): IndexingPhase | null {
	if (value === "parsed" || value === "minsync" || value === "finalizing") return value;
	if (value === "jikji" || value === "everything" || value === "fsearch") return "finalizing";
	return null;
}

interface ParsedMirrorSnapshot {
	readonly processedFiles: number;
	readonly recentFile: string | null;
	readonly recentSourcePath: string | null;
}

/** Count what the parsed mirror actually handled, and find the newest entry. */
function readParsedMirror(text: string): ParsedMirrorSnapshot {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { processedFiles: 0, recentFile: null, recentSourcePath: null };
	}
	if (!isJsonObject(parsed)) return { processedFiles: 0, recentFile: null, recentSourcePath: null };
	const entries = isJsonObject(parsed.entries) ? parsed.entries : {};
	const skipped = isJsonObject(parsed.skipped) ? parsed.skipped : {};
	let recentFile: string | null = null;
	let recentSourcePath: string | null = null;
	let newest = "";
	for (const entry of Object.values(entries)) {
		if (!isJsonObject(entry) || typeof entry.sourcePath !== "string") continue;
		const updatedAt = typeof entry.updatedAt === "string" ? entry.updatedAt : "";
		if (updatedAt >= newest) {
			newest = updatedAt;
			recentSourcePath = entry.sourcePath;
			recentFile = basename(entry.sourcePath);
		}
	}
	return { processedFiles: Object.keys(entries).length + Object.keys(skipped).length, recentFile, recentSourcePath };
}

/** Count the committed file entries in MinSync's crash-resume log (`progress.jsonl`). */
function countMinSyncProgress(text: string | null): number {
	if (text === null) return 0;
	const lines = text.split("\n").filter((line) => line.trim().length > 0);
	return Math.max(0, lines.length - 1);
}
export function createOnboardingService(deps: OnboardingServiceDeps): OnboardingService {
	const agentDir = deps.agentDir ?? getAgentDir();
	const now = deps.now ?? Date.now;
	const existing = readOnboardingState(deps.userDataDir);
	let stateFile: PersistedOnboardingState = existing ?? { completed: false, draft: null };
	// A draft written by an older/corrupt build must never reach the renderer.
	if (!isOnboardingDraft(stateFile.draft)) stateFile = { ...stateFile, draft: null };
	let pending = existing !== null ? !existing.completed : deps.env.AUTORAG_SKIP_ONBOARDING !== "1";

	let status: IndexingStatus = IDLE_STATUS;
	let refreshPromise: Promise<void> | null = null;
	/** The latest source probe run; `startIndexing` reuses it instead of probing twice. */
	let detection: Promise<SourceDetection> | null = null;
	let detectionRun = 0;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let powerBlockerId: number | null = null;
	let workspacePath: string | null = null;
	let phase: IndexingPhase | null = null;
	let phaseStartedAt = 0;
	let selectedFolders: readonly string[] = [];
	/** Files of the folders the user left out in smart indexing; the pre-scans still count them. */
	let excludedFiles = 0;
	let sourceNames: readonly string[] = [];
	let pendingDatasourceAliases: readonly string[] = [];
	let localIndexDone = false;
	let parsedSnapshot: ParsedMirrorSnapshot = { processedFiles: 0, recentFile: null, recentSourcePath: null };
	let embeddedFiles = 0;
	let progressSignature = "";
	let parsedSignature = "";
	let minsyncSignature = "";
	/** True while a keyword-only index runs: no embedding phase exists, so the bar has none. */
	let keywordOnly = false;
	const maybeStartBackgroundDatasources = (): void => {
		if (pending || refreshPromise !== null || !localIndexDone || pendingDatasourceAliases.length === 0) return;
		const aliases = pendingDatasourceAliases;
		pendingDatasourceAliases = [];
		void deps.syncDatasources?.(aliases)?.catch((error: unknown) => {
			console.warn("[onboarding] background datasource sync failed:", error);
		});
	};

	/** A background write that fails (folder removed, disk full) must not become an unhandled rejection. */
	const warnPersistFailed = (error: unknown): void => {
		console.warn("[onboarding] could not save the onboarding state:", error);
	};
	let persistChain: Promise<void> = Promise.resolve();
	const persist = (): Promise<void> => {
		const path = onboardingStatePath(deps.userDataDir);
		const run = async (): Promise<void> => {
			await mkdir(join(deps.userDataDir, "onboarding"), { recursive: true });
			await writeFile(path, `${JSON.stringify(stateFile, null, 2)}\n`, "utf8");
		};
		persistChain = persistChain.then(run, run);
		return persistChain;
	};

	const emitStatus = (): void => {
		deps.send(ONBOARDING_CHANNELS.indexProgress, status);
	};

	// The parsed mirror records realpaths (macOS `/var` → `/private/var`, symlinked
	// folders), so match against both the selected path and its realpath.
	let folderRoots: ReadonlyArray<{ readonly root: string; readonly name: string }> = [];
	const folderNameFor = (sourcePath: string): string | null =>
		folderRoots.find(({ root }) => sourcePath === root || sourcePath.startsWith(`${root}${sep}`))?.name ?? null;

	async function readIfChanged(path: string, previousSignature: string): Promise<{ text: string | null; signature: string }> {
		try {
			const info = await stat(path);
			const signature = `${info.mtimeMs}:${info.size}`;
			if (signature === previousSignature) return { text: null, signature };
			return { text: await readFile(path, "utf8"), signature };
		} catch {
			return { text: null, signature: previousSignature };
		}
	}

	async function tick(): Promise<void> {
		if (workspacePath === null) return;
		const progressPath = join(workspacePath, ".autorag", "refresh-progress.json");
		const progressRead = await readIfChanged(progressPath, progressSignature);
		if (progressRead.text !== null) {
			progressSignature = progressRead.signature;
			let parsed: unknown;
			try {
				parsed = JSON.parse(progressRead.text);
			} catch {
				parsed = null;
			}
			if (isJsonObject(parsed)) {
				const nextPhase = toIndexingPhase(parsed.phase);
				if (nextPhase !== null && nextPhase !== phase) {
					phase = nextPhase;
					phaseStartedAt = now();
				}
			}
		}
		const parsedPath = join(workspacePath, ".autorag", "parsed", "index.json");
		const parsedRead = await readIfChanged(parsedPath, parsedSignature);
		if (parsedRead.text !== null) {
			parsedSignature = parsedRead.signature;
			parsedSnapshot = readParsedMirror(parsedRead.text);
		}
		const minsyncPath = join(workspacePath, ".autorag", "minsync", ".minsync", "progress.jsonl");
		const minsyncRead = await readIfChanged(minsyncPath, minsyncSignature);
		if (minsyncRead.text !== null) {
			minsyncSignature = minsyncRead.signature;
			embeddedFiles = Math.max(embeddedFiles, countMinSyncProgress(minsyncRead.text));
		}
		const totalFiles = Math.max(0, deps.folderTotals(selectedFolders) - excludedFiles);
		const { progress, remainingMinutes } = computeIndexingProgress({
			state: "running",
			phase,
			processedFiles: parsedSnapshot.processedFiles,
			embeddedFiles,
			totalFiles,
			phaseElapsedMs: phase === null ? 0 : now() - phaseStartedAt,
			embedding: !keywordOnly,
		});
		status = {
			...status,
			state: "running",
			phase,
			progress,
			remainingMinutes,
			processedFiles: parsedSnapshot.processedFiles,
			totalFiles,
			recentFile: parsedSnapshot.recentFile,
			recentFolder: parsedSnapshot.recentSourcePath === null ? null : folderNameFor(parsedSnapshot.recentSourcePath),
			sources: sourceNames,
		};
		emitStatus();
	}

	function stopPolling(): void {
		clearInterval(pollTimer ?? undefined);
		pollTimer = null;
		if (powerBlockerId !== null) deps.stopPowerSaveBlocker(powerBlockerId);
		powerBlockerId = null;
	}

	function finish(ok: boolean, error: string | null): void {
		stopPolling();
		refreshPromise = null;
		localIndexDone = ok;
		const finishedAt = new Date(now()).toISOString();
		const indexing = stateFile.indexing;
		if (indexing !== undefined) stateFile = { ...stateFile, indexing: { ...indexing, finishedAt } };
		void persist().catch(warnPersistFailed);
		status = ok
			? { ...status, state: "success", progress: 100, remainingMinutes: null, finishedAt, error: null }
			: { ...status, state: "failed", remainingMinutes: null, finishedAt, error: error ?? t("main.onboarding.indexingFailed") };
		emitStatus();
		maybeStartBackgroundDatasources();
	}

	return {
		pending: () => pending,
		load: async () => ({ pending, draft: stateFile.draft }),
		save: async (draft) => {
			if (!isOnboardingDraft(draft)) throw new TypeError("onboarding:save expects a valid draft");
			stateFile = { ...stateFile, draft };
			await persist();
		},
		permissions: async () => {
			const settings = await deps.settings.get();
			return {
				platform: deps.platform,
				fullDiskAccess: deps.platform === "darwin" ? await deps.probeFullDiskAccess() : null,
				launchAtLogin: settings.launchAtLogin,
				notificationsSupported: deps.notificationsSupported(),
			};
		},
		openFullDiskAccess: () => deps.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"),
		dragApp: () => deps.startDrag(deps.appBundlePath()),
		relaunch: async () => deps.relaunch(),
		requestNotifications: () => deps.showNotification(),
		openNotificationSettings: () =>
			deps.openExternal(deps.platform === "win32" ? "ms-settings:notifications" : "x-apple.systempreferences:com.apple.preference.notifications"),
		checkNetwork: () => deps.checkNetwork(),
		setLaunchAtLogin: async (enabled) => {
			// The settings hook applies the OS login item; read it back instead of
			// trusting that it took, and never leave the setting claiming "on" when the
			// OS refused.
			const settings = await deps.settings.set({ launchAtLogin: enabled });
			if (deps.loginItemApplied(settings.launchAtLogin)) return settings.launchAtLogin;
			return (await deps.settings.set({ launchAtLogin: !settings.launchAtLogin })).launchAtLogin;
		},
		folderCandidates: async () => {
			const ocrOff = !(await deps.ocrEnabled());
			const candidates: FolderCandidate[] = [];
			const add = (
				path: string,
				name: string,
				kind: FolderCandidate["kind"],
				defaultSelected: boolean,
				ocr: boolean,
			): void => {
				if (!existsSync(path)) return;
				candidates.push({
					path,
					name,
					displayPath: abbreviateHome(path, deps.home),
					kind,
					defaultSelected,
					ocrOff: ocr,
				});
			};
			add(deps.knownFolders.desktop, "Desktop", "desktop", true, false);
			add(deps.knownFolders.documents, "Documents", "documents", true, false);
			if (deps.iCloudDrivePath !== null) add(deps.iCloudDrivePath, "iCloud Drive", "icloud", true, false);
			add(deps.knownFolders.downloads, "Downloads", "downloads", true, ocrOff);
			add(deps.knownFolders.pictures, "Pictures", "pictures", false, ocrOff);
			for (const drive of await deps.cloudDrives().catch(() => [])) {
				add(drive.path, drive.name, "cloud", false, false);
			}
			return candidates;
		},
		pickFolders: async () => {
			const paths = await deps.pickFolders();
			return paths
				.filter((path) => isAbsoluteString(path) && existsSync(path))
				.map((path): FolderCandidate => ({
					path,
					name: displayNameFromPath(path),
					displayPath: abbreviateHome(path, deps.home),
					kind: "custom",
					defaultSelected: true,
					ocrOff: false,
				}));
		},
		scanFolders: async (paths) => {
			const valid = paths.filter(isAbsoluteString);
			await deps.startScans(valid);
		},
		embedding: async () => {
			const raw = existsSync(deps.configPath) ? readRawConfigObject(deps.configPath) : {};
			const minSync = isJsonObject(raw.minSync) ? raw.minSync : {};
			const embedder = isJsonObject(minSync.embedder) ? minSync.embedder : {};
			const cacheRoot = minSyncModelCacheRoot({ platform: deps.platform, home: deps.home, env: deps.env });
			const spec = nativeQwen3Spec();
			return {
				profile: EMBEDDER_ID,
				modelBytes: modelTotalBytes(spec),
				cached: modelFilesPresent(cacheRoot, spec),
				configured: Object.keys(embedder).length > 0,
				localModel: localEmbeddingModel({ minSync }) !== null,
			};
		},
		detectSources: async () => {
			// A newer run supersedes an older one: its late finds must not reach the
			// renderer, which already reset its list for the new run.
			const run = ++detectionRun;
			const promise = deps.detectSources((source) => {
				if (run === detectionRun) deps.send(ONBOARDING_CHANNELS.sourceDetected, source);
			});
			detection = promise;
			const done = (): void => {
				if (run === detectionRun) deps.send(ONBOARDING_CHANNELS.sourcesDone, null);
			};
			void promise.then(done, done);
		},
		detectModels: () => deps.detectModels(),
		verifyModel: async (request) => {
			if (!isModelVerifyRequest(request)) throw new TypeError("onboarding:verifyModel expects a valid request");
			return deps.verifyModel(request);
		},
		startIndexing: async (request) => {
			if (!isIndexingRequest(request)) throw new TypeError("onboarding:startIndexing expects a valid request");
			if (refreshPromise !== null) return status;
			// The sources step already ran the probes; reuse that run (waiting for it if it
			// is still going) so the first index never pays for detection twice.
			const found = await (detection ?? deps.detectSources()).catch((): SourceDetection => ({ sources: [] }));
			const factsById = new Map<SourceId, SourceFacts>(found.sources.map((source) => [source.id, source.facts]));
			const datasources = request.sources.map((source) => ({
				id: source.id,
				facts: factsById.get(source.id) ?? {},
			}));
			const raw = existsSync(deps.configPath) ? readRawConfigObject(deps.configPath) : {};
			const minSync = isJsonObject(raw.minSync) ? raw.minSync : {};
			const existingEmbedder = isJsonObject(minSync.embedder) ? minSync.embedder : {};
			const isDazziCloudEmbedder = existingEmbedder.id === DAZZI_CLOUD_EMBEDDER_ID;
			const configured = Object.keys(existingEmbedder).length > 0 && !isDazziCloudEmbedder;
			const embedMode: EmbedMode = request.embed ?? "local";
			const configuredBaseUrl = deps.env.AUTORAG_BASE_URL?.trim();
			const accountBaseUrl = (configuredBaseUrl !== undefined && configuredBaseUrl.length > 0 ? configuredBaseUrl : DEFAULT_ACCOUNT_BASE_URL).replace(/\/+$/u, "");
			const cloudEmbedder = {
				id: DAZZI_CLOUD_EMBEDDER_ID,
				baseUrl: accountBaseUrl,
				dimension: EMBEDDER_DIMENSION,
				apiKeyEnv: DAZZI_CLOUD_EMBEDDER_KEY_ENV,
			};
			// Keyword-only writes no embedder at all; a local run keeps one the user already configured.
			const embedder = embedMode === "none" ? null : embedMode === "cloud" ? cloudEmbedder : configured ? null : { id: EMBEDDER_ID, dimension: EMBEDDER_DIMENSION };
			const modelProvider = request.model === null ? null : (request.model.provider as ByokProviderId);
			const next = applyIndexingConfig({
				raw,
				folders: request.folders,
				datasources,
				excludePaths: request.excludePaths ?? [],
				home: deps.home,
				embedder,
				semanticSearch: embedMode !== "none",
				// The app seeds `workspacePath = cwd` (the repo in dev, `/` when packaged);
				// the first index belongs in the AutoRAG home instead. A workspace the
				// user set explicitly stays.
				workspacePath:
					typeof raw.workspacePath !== "string" || raw.workspacePath === deps.cwd
						? join(deps.env.AUTORAG_HOME?.trim() || join(deps.home, ".autorag"), "workspace")
						: null,
				model:
					request.model === null
						? null
						: {
								provider: request.model.provider,
								modelId: request.model.modelId,
								// pi's catalog carries no Ollama models, so the agent reaches it as an
								// OpenAI-compatible endpoint; without a base URL it could not resolve.
								baseUrl:
									modelProvider === "ollama" && (request.model.baseUrl ?? "") === ""
										? "http://127.0.0.1:11434/v1"
										: request.model.baseUrl,
								envName: modelProvider === null ? null : PROVIDER_ENV_NAME[modelProvider],
							},
			});
			writeConfigObject(deps.configPath, next);
			if (request.plan !== "byok") {
				// The index never needs the model, so an unreachable account must not block
				// the first index; Settings → 계정 offers the same step again.
				await deps.useManagedModel().catch((error: unknown) => {
					console.warn("[onboarding] could not point the agent at the account's models:", error);
				});
			}
			if (embedMode === "cloud") {
				await maybeStoreCloudEmbedderKey();
			} else if (isDazziCloudEmbedder && deps.env[DAZZI_CLOUD_EMBEDDER_KEY_ENV] === (await readDazziPlanCredential(agentDir))) {
				await deps.credentials.remove(DAZZI_CLOUD_EMBEDDER_KEY_ENV).catch(() => undefined);
			}
			await maybeStoreGitToken(request.sources.map((source) => source.id));
			keywordOnly = embedMode === "none";
			const methods = ["parsed", "minsync"];
			workspacePath = await deps.resolveWorkspacePath();
			selectedFolders = request.folders;
			excludedFiles = request.excludedFiles ?? 0;
			folderRoots = request.folders.flatMap((folder) => {
				const name = displayNameFromPath(folder);
				let real = folder;
				try {
					real = realpathSync(folder);
				} catch {
					// A folder that vanished since the pre-scan simply never matches.
				}
				return real === folder ? [{ root: folder, name }] : [{ root: folder, name }, { root: real, name }];
			});
			sourceNames = request.sources.map((source) => SOURCE_LABELS[source.id]);
			pendingDatasourceAliases = Object.keys(buildDatasourceEntries(datasources, deps.home));
			localIndexDone = false;
			phase = null;
			progressSignature = "";
			parsedSignature = "";
			minsyncSignature = "";
			parsedSnapshot = { processedFiles: 0, recentFile: null, recentSourcePath: null };
			embeddedFiles = 0;
			const startedAt = new Date(now()).toISOString();
			stateFile = { ...stateFile, indexing: { startedAt, finishedAt: null } };
			void persist().catch(warnPersistFailed);
			status = {
				...IDLE_STATUS,
				state: "running",
				sources: sourceNames,
				startedAt,
				totalFiles: Math.max(0, deps.folderTotals(request.folders) - excludedFiles),
			};
			emitStatus();
			powerBlockerId = deps.startPowerSaveBlocker();
			pollTimer = setInterval(() => void tick().catch(() => undefined), POLL_INTERVAL_MS);
			// A keyword-only run can end before the first poll: read the mirror once more so the final status counts what it read.
			const settle = async (ok: boolean, error: string | null): Promise<void> => {
				await tick().catch(() => undefined);
				finish(ok, error);
			};
			// The first index embeds on this computer when the config now names the local model: its weights have to be
			// here first, or `minsync` would fetch them itself without telling anyone how far it got.
			const needsModel = embedMode !== "none" && localEmbeddingModel(next) !== null;
			const run = async (): Promise<ConfigRefreshResult> => {
				const missing = needsModel ? await deps.ensureLocalModel() : null;
				if (missing !== null) {
					const error = t("main.onboarding.modelDownloadFailed", { error: missing });
					return { ok: false, methods, scanned: 0, written: 0, deleted: 0, skipped: 0, diagnostics: [], error };
				}
				return deps.refresh(methods);
			};
			refreshPromise = run()
				.then((result) => settle(result.ok, result.error))
				.catch((error: unknown) => settle(false, error instanceof Error ? error.message : String(error)));
			return status;
		},
		indexStatus: async () => status,
		isIndexing: () => refreshPromise !== null,
		complete: async () => {
			if (!pending) return;
			stateFile = { ...stateFile, completed: true };
			pending = false;
			clearInterval(pollTimer ?? undefined);
			pollTimer = null;
			await persist();
			deps.onComplete();
			maybeStartBackgroundDatasources();
		},
		dispose: () => stopPolling(),
	};

	async function maybeStoreCloudEmbedderKey(): Promise<void> {
		const token = await readDazziPlanCredential(agentDir);
		if (token === null) return;
		deps.env[DAZZI_CLOUD_EMBEDDER_KEY_ENV] = token;
		try {
			await deps.credentials.set(DAZZI_CLOUD_EMBEDDER_KEY_ENV, token);
		} catch (error) {
			console.warn("[onboarding] could not store the Dazzi cloud embedder credential:", error);
		}
	}

	async function maybeStoreGitToken(sourceIds: readonly SourceId[]): Promise<void> {
		if (!sourceIds.includes("github")) return;
		if (typeof deps.env.GITHUB_TOKEN === "string" && deps.env.GITHUB_TOKEN.length > 0) return;
		const token = await deps.gitToken().catch(() => null);
		if (token === null || token.length === 0) return;
		try {
			deps.credentials.set("GITHUB_TOKEN", token);
		} catch (error) {
			console.warn("[onboarding] could not store the GitHub token:", error);
		}
	}
}
