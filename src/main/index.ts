import { homedir } from "node:os";
import { access, open, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { applyBundledTools } from "./bundled-tools";
import { minSyncModelCacheRoot } from "./bundled-sparse-model";
import { createModelDownloadService, localModelPresent, nativeQwen3Spec } from "./model-download";
import { MODEL_DOWNLOAD_CHANNELS } from "../shared/model-download-contract";
import {
	app,
	BrowserWindow,
	clipboard,
	ClipboardItem,
	dialog,
	globalShortcut,
	ipcMain,
	nativeTheme,
	Notification,
	powerSaveBlocker,
	protocol,
	safeStorage,
	screen,
	ShareMenu,
	shell,
	systemPreferences,
	type OpenDialogOptions,
} from "electron";
import { APPEARANCE_CHANNELS } from "../shared/appearance-contract";
import { setAppLanguage, t } from "../shared/i18n/core";
import { LANGUAGE_CHANNELS } from "../shared/language-contract";
import { ONBOARDING_CHANNELS, ONBOARDING_PENDING_FLAG } from "../shared/onboarding-contract";
import { ERROR_FIX_CHANNELS } from "../shared/error-fix-contract";
import { APP_CUSTOMIZER_CHANNELS } from "../shared/app-customizer-contract";
import { MAGIC_ACTION_CHANNELS } from "../shared/magic-actions-contract";
import { ACTIONS_CHANNELS } from "../shared/actions-contract";
import type { AppAppearance, AppSettings, ConfigRefreshResult } from "../shared/settings-contract";
import { resolveEffectiveShortcuts } from "../shared/shortcuts-contract";
import { attachQuickLook, PREVIEW_PRIVILEGED_SCHEME, registerPreviewProtocol, registerQuickLookIpc, type QuickLookWindowOptions } from "../preview/node/register";
import { AutoRAGLite, createDefaultParserRegistry, DEFAULT_MAX_SOURCE_BYTES, writeDefaultConfig } from "@autorag/librarian";
import { readRawConfigObject, resolveConfigPath, writeConfigObject } from "@autorag/librarian/core";
import { DEFAULT_CODE_FOLDER_NAMES, isJsonObject, SETTINGS_CHANNELS } from "../shared/settings-contract";
import { LOCAL_REFRESH_METHODS } from "./index-refresh";
import { INDEX_ACTIVITY_CHANNELS } from "../shared/index-activity-contract";
import { AUTOMATION_CHANNELS } from "../shared/automation-contract";
import { autoragHome } from "./autorag-home";
import { createAutomationService, librarianCommand, runLibrarianCli } from "./automation-service";
import { createDemoService } from "./demo-service";
import { DEMO_CHANNELS } from "../shared/demo-contract";
import { readAppIndexing } from "./app-indexing";
import { createIndexActivityService } from "./index-activity";
import { APP_UPDATE_CHANNELS } from "../shared/update-contract";
import type { AppUpdaterService } from "./app-updater";
import { createAppUpdateHost, installCheckForUpdatesMenuItem } from "./app-update-host";
import { LOCAL_ITEM } from "./index-activity-journal";
import { busyMessage, lockDataSources } from "./locked-datasources";
import { createRefreshQueue } from "./refresh-queue";
import { createIndexProblemService } from "./index-problem-service";
import { modelDownloadFailure } from "./index-failure";
import { createIndexReadiness } from "./index-readiness";
import { INDEX_PROBLEM_CHANNELS } from "../shared/index-problem-contract";
import type { RefreshLockHolder } from "./refresh-lock";
import { schedulePaths } from "./refresh-schedule";
import { createRefreshScheduler } from "./refresh-scheduler";
import { createIconProvider } from "./file-icon";
import { registerIconProtocol, THUMB_PRIVILEGED_SCHEME } from "./icon-register";
import { createFinderTags } from "./finder-tags";
import { createPlaces } from "./places";
import type { KnownFolders } from "../shared/fs-worker-contract";
import { hasErrorCode } from "./fs-entry";
import { refreshAutoragIndex, resolveEffectiveConfig } from "./index-refresh";
import { terminateMinSyncChildren } from "./minsync-watchdog";
import { createFolderScanCoordinator, supportedExtensionsFromRegistry } from "./onboarding-scan";
import { createAccountService } from "./account-service";
import { resolveAnonymousDeviceId } from "./device-id";
import { readDazziGuestCredential } from "./dazzi-plan-credential";
import { quotaBlock } from "./quota-guard";
import { createFirstRunService, type FirstRunService } from "./first-run-service";
import { createDemoQuestionJudge } from "./demo-question-judge";
import { closeDecision } from "./onboarding-window";
import { FS_CHANNELS, type FsBatchResult } from "../shared/fs-contract";
import dockIconPath from "../../build/icon.png?asset";
import windowIconPath from "../../build/icons/512x512.png?asset";
import { APP_FULL_NAME, APP_VERSION, formatWindowTitle, type DevLabel } from "../shared/app-info";
import { createChatSessionIndex } from "./chat-sessions";
import { createChatStore } from "./chat-store";
import { createDataSourceStatusService } from "./datasource-status";
import { readDevLabel, resolveClonePath } from "./dev-label";
import { createOsClipboard } from "./os-clipboard";
import { createFsWorkerHost, registerFsWorkerIpc, type FsWorkerHost } from "./fs-worker-host";
import { createRemoteHost, type RemoteHost } from "./remote/host";
import { REMOTE_CHANNELS, type RemoteAccessStatus } from "../shared/remote-contract";
import { SEARCH_CHANNELS } from "../shared/search-contract";
import { ACCOUNT_CHANNELS, AUTORAG_PROVIDER_ID } from "../shared/account-contract";
import { ANALYTICS_CHANNELS } from "../shared/analytics-contract";
import { CONVERSION_CHANNELS } from "../shared/conversion-contract";
import { SERVICES_CHANNELS } from "../shared/services-contract";
import { createAutoRagConfigService } from "./autorag-config-service";
import { createModelStatusService } from "./model-status";
import { createProviderAuthService, type ProviderAuthService } from "./provider-auth-service";
import { createProviderCredentialService } from "./provider-credentials";
import { createLocalSpecProbe } from "./hardware-probe";
import { configureEmbeddingDaemon, ensureEmbeddingForConfig, stopEmbeddingDaemon } from "./embedding-daemon";
import { migrateLegacyEmbedding } from "./embedding-migration";
import { createEmbeddingSettingsService } from "./embedding-settings-service";
import { createMcpSettingsService } from "./mcp-settings-service";
import { resolveMcpConnectInfo } from "./mcp-connect-info";
import { createDefaultAgentFactory, createSearchService } from "./search-service";
import { createInteractionHub } from "./interaction-hub";
import { INTERACTION_CHANNELS, type ApprovalMode } from "../shared/interaction-contract";
import { openPlanRuntime, resolveConfiguredSessionModel } from "@autorag/librarian/profiles";
import { createErrorFixService } from "./error-fix-service";
import { createAppCustomizerService } from "./app-customizer-service";
import { createMagicActionService } from "./magic-action-service";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { appWindowSize } from "./window-size";
import { createSettingsService } from "./settings-service";
import { detectSystemLanguage } from "./system-language";
import {
	registerAccountIpcHandlers,
	registerActionsIpcHandlers,
	registerAnalyticsIpcHandlers,
	registerAppCustomizerIpcHandlers,
	registerMagicActionIpcHandlers,
	registerAppUpdateIpcHandlers,
	registerConversionIpcHandlers,
	registerAutomationIpcHandlers,
	registerDemoIpcHandlers,
	registerDragOutIpcHandlers,
	registerIndexActivityIpcHandlers,
	registerErrorFixIpcHandlers,
	registerInteractionIpcHandlers,
	registerIndexProblemIpcHandlers,
	registerModelDownloadIpcHandlers,
	registerOnboardingIpcHandlers,
	registerOsRequestIpcHandlers,
	registerSearchIpcHandlers,
	registerServicesIpcHandlers,
	registerSettingsIpcHandlers,
	registerVoiceIpcHandlers,
} from "./ipc";
import { createActionService } from "./action-service";
import { createVoiceService, systemMicrophoneAccess } from "./voice-service";
import { readDazziPlanCredential } from "./dazzi-plan-credential";
import { createFileeConversionService, readFileeSettings } from "./conversion-service";
import { createFileePdfReducer } from "./pdf-reducer";
import { createServicesService } from "./services-service";
import { DEFAULT_SCAN_INTERVAL_MINUTES } from "./version-family-service";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeOsLaunchRequest, OS_REQUEST_CHANNELS, parseOsRequestArgv } from "../shared/os-request-contract";
import { listenForOsRequests, osRequestEndpoint, sendOsRequest } from "./os-request-channel";
import { createOsRequestService, diskKindOf } from "./os-request-service";
import { createQuickSearchShortcut, type QuickSearchShortcut } from "./quick-search-shortcut";
import { createQuickSearchWindow, type QuickSearchWindow } from "./quick-search-window";
import { createOsMenuIntegration, menuLabels } from "./os-menu-integration";
import { installCli } from "./cli-install";
import { initErrorReporting, setErrorReportingEnabled } from "./error-reporting";
import { readErrorReportingEnabled } from "./error-report-core";
import { createAnalytics, createInstallIdStore, readUsageAnalyticsEnabled, resolveAnalyticsTarget, settingChangeEvents } from "./analytics-core";
import { hasInWindowMenuBar, mainWindowChrome, windowControlsOverlay } from "./window-chrome";
import { createPostHogSink } from "./analytics";

const execFileAsync = promisify(execFile);

// Before `ready`, so a crash during startup is reported. The Settings toggle is read from disk because the settings service loads later.
initErrorReporting({ dsn: import.meta.env.MAIN_VITE_SENTRY_DSN, enabled: readErrorReportingEnabled(app.getPath("userData")), version: APP_VERSION, packaged: app.isPackaged });

/**
 * Usage statistics: anonymous, content-free (see `analytics-core.ts`). Off until the user has continued from onboarding's
 * welcome step with the box ticked, or turned it on in Settings; read from disk because the settings service loads later. A build with no PostHog key has no sink and sends nothing.
 */
const analyticsTarget = resolveAnalyticsTarget({
	packaged: app.isPackaged,
	buildKey: import.meta.env.MAIN_VITE_POSTHOG_KEY,
	buildHost: import.meta.env.MAIN_VITE_POSTHOG_HOST,
	env: process.env,
});
const analytics = createAnalytics({
	sink: analyticsTarget === null ? null : createPostHogSink(analyticsTarget),
	installId: createInstallIdStore(join(app.getPath("userData"), "analytics", "install-id")),
	context: () => ({ app_version: APP_VERSION, platform: process.platform, arch: process.arch, packaged: app.isPackaged, language: currentLanguage }),
	enabled: readUsageAnalyticsEnabled(app.getPath("userData")),
});

/** The one AutoRAG config every surface (CLI, TUI, serve, this app) resolves. */
function autoragConfigPath(): string {
	return resolveConfigPath({ flags: {}, env: process.env, cwd: process.cwd() }).configPath;
}

/** Seed the app's indexing policy once, so the metadata is visible and editable. */
function ensureAppIndexingMetadata(configPath: string): void {
	try {
		const raw = readRawConfigObject(configPath);
		if (isJsonObject(raw.appIndexing)) return;
		writeConfigObject(configPath, {
			...raw,
			appIndexing: { excludeCodeFolders: true, codeFolderNames: [...DEFAULT_CODE_FOLDER_NAMES] },
		});
	} catch (error) {
		console.error("AutoRAG appIndexing metadata initialization failed", error);
	}
}

/** Rewrite what an earlier Dazzi left in the config for the embedding runtime it no longer has. */
function migrateEmbeddingConfig(configPath: string): void {
	try {
		const { raw, changed } = migrateLegacyEmbedding(readRawConfigObject(configPath));
		if (changed) writeConfigObject(configPath, raw);
	} catch (error) {
		console.error("AutoRAG embedding config migration failed", error);
	}
}

async function ensureAutoRAGConfig(): Promise<void> {
	const configPath = autoragConfigPath();
	if (await access(configPath).then(() => true, () => false)) {
		migrateEmbeddingConfig(configPath);
		ensureAppIndexingMetadata(configPath);
		return;
	}
	try {
		writeDefaultConfig(
			configPath,
			{ searchPaths: [process.cwd()], workspacePath: process.cwd() },
			{ atomicCreate: true, cwd: process.cwd(), env: process.env },
		);
		ensureAppIndexingMetadata(configPath);
	} catch (error) {
		console.error("AutoRAG config initialization failed", error);
	}
}

/** Manual index refresh from Settings (shared with onboarding's first run). */
function refreshConfig(methods?: readonly string[]): Promise<ConfigRefreshResult> {
	return refreshAutoragIndex({ env: process.env, cwd: process.cwd() }, methods);
}

/** Unpackaged runs (and AUTORAG_DEV_LABEL=1) carry the clone label. */
function resolveDevLabel(): DevLabel | null {
	if (app.isPackaged && process.env.AUTORAG_DEV_LABEL !== "1") return null;
	return readDevLabel(resolveClonePath(app.getAppPath()));
}

function loadRendererPage(window: BrowserWindow, page: string): void {
	const rendererUrl = process.env.ELECTRON_RENDERER_URL;
	if (rendererUrl) {
		void window.loadURL(new URL(page, `${rendererUrl}/`).toString());
	} else {
		void window.loadFile(join(import.meta.dirname, "../renderer", page));
	}
}

function createAppWindow(devLabel: DevLabel | null, appearance: AppAppearance, pending: boolean): BrowserWindow {
	const workArea = screen.getPrimaryDisplay().workAreaSize;
	const windowSize = appWindowSize(workArea, "finder");
	const window = new BrowserWindow({
		...windowSize,
		title: formatWindowTitle(APP_FULL_NAME, APP_VERSION, devLabel),
		// Windows and Linux take the window/taskbar icon here; macOS uses the bundle icon (the Dock icon below when unpackaged).
		...(process.platform === "darwin" ? {} : { icon: windowIconPath }),
		// The native title strip is gone on every OS (see `window-chrome.ts`): macOS keeps its traffic lights, Windows/Linux get the window controls only.
		...mainWindowChrome(process.platform, appearance, "finder"),
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/index.mjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
			additionalArguments: [
				...(devLabel === null ? [] : [`--autorag-dev-label=${JSON.stringify(devLabel)}`]),
				`--autorag-appearance=${appearance}`,
				// The renderer's first-run layer mounts only while the flag is present; `load` is authoritative.
				...(pending ? [ONBOARDING_PENDING_FLAG] : []),
			],
		},
	});

	// No `File Edit View Window` strip inside the window on Windows/Linux: nothing here is reachable only through it.
	if (hasInWindowMenuBar(process.platform)) window.removeMenu();

	// The renderer's static <title> would otherwise replace the window title.
	window.webContents.on("page-title-updated", (event) => {
		event.preventDefault();
		window.setTitle(formatWindowTitle(APP_FULL_NAME, APP_VERSION, devLabel));
	});

	loadRendererPage(window, "index.html");
	attachQuickLook(window, quickLookOptions(appearance));
	return window;
}

/** The Quick Look panel's options; the Finder and the quick-search launcher each own one panel. */
function quickLookOptions(appearance: AppAppearance): QuickLookWindowOptions {
	return {
		preload: join(import.meta.dirname, "../preload/quick-look.mjs"),
		appearance,
		language: currentLanguage,
		loadPage: (preview) => loadRendererPage(preview, "quick-look.html"),
		// Spawning osascript blocks the caller for the fork; the worker pays it.
		defaultApp: (path) => (fsWorker === null ? Promise.resolve(null) : fsWorker.client.call<string | null>("defaultApp", [path])),
		quickLookChord: () => currentQuickLookChord,
	};
}

let fsWorker: FsWorkerHost | null = null;
/** Remote browser access; null until its host is built (and while the setting is off). */
let remoteHost: RemoteHost | null = null;
let providerAuthService: ProviderAuthService | null = null;
let currentQuickLookChord = "Space";
/** The system-wide quick-search shortcut; null until startup built the launcher it summons. */
let quickSearchShortcut: QuickSearchShortcut | null = null;
/** The one app window: the Finder, which also hosts the first-run overlay while onboarding is unfinished. */
let mainWindow: BrowserWindow | null = null;
let currentAppearance: AppAppearance = "light";
/** The app's own windows that are still open (never a Quick Look panel). */
function appWindows(): BrowserWindow[] {
	return [mainWindow].filter((window): window is BrowserWindow => window !== null && !window.isDestroyed());
}
/** The window-controls overlay of the window is as tall as that page's top bar. */
function syncWindowControls(): void {
	if (!hasInWindowMenuBar(process.platform)) return;
	if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.setTitleBarOverlay(windowControlsOverlay(currentAppearance, "finder"));
}
let currentLanguage: AppSettings["language"] = "ko";
/** One push to the app's window (the Finder, which also hosts the first-run overlay) and any remote session. */
function sendToMainWindow(channel: string, payload: unknown): void {
	for (const window of appWindows()) window.webContents.send(channel, payload);
	remoteHost?.push(channel, payload);
}

function sendToAllWindows(channel: string, payload: unknown): void {
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) window.webContents.send(channel, payload);
	}
	remoteHost?.push(channel, payload);
}

/** macOS Full Disk Access probe: open (never read) a TCC-protected path. */
async function probeFullDiskAccess(home: string): Promise<boolean> {
	const candidates = [
		join(home, "Library", "Application Support", "com.apple.TCC", "TCC.db"),
		join(home, "Library", "Safari"),
	];
	for (const path of candidates) {
		try {
			const handle = await open(path, "r");
			await handle.close();
			return true;
		} catch (error) {
			if (hasErrorCode(error, "EACCES") || hasErrorCode(error, "EPERM")) continue;
		}
	}
	return false;
}

/** macOS cloud placeholders under a root, batched into one `find`; local roots short-circuit. */
async function listMacDatalessPaths(root: string): Promise<ReadonlySet<string>> {
	if (!/Library\/(CloudStorage|Mobile Documents)|CloudDocs/u.test(root)) return new Set();
	try {
		const stdout = await new Promise<string>((resolve, reject) => {
			execFile(
				"/usr/bin/find",
				[root, "-flags", "+dataless"],
				{ timeout: 10_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
				(error, out) => (error !== null ? reject(error) : resolve(out)),
			);
		});
		return new Set(stdout.split("\n").filter((line: string) => line.length > 0));
	} catch {
		return new Set();
	}
}

// Chromium decodes JPEG XL only behind this feature, which the Quick Look image viewer relies on for `.jxl`.
// Merged with any `--enable-features` the app was launched with, because appendSwitch replaces a value.
app.commandLine.appendSwitch("enable-features", [app.commandLine.getSwitchValue("enable-features"), "JXLImageFormat"].filter((value) => value !== "").join(","));
// Electron keeps only the last `registerSchemesAsPrivileged` call: every scheme registers here, together.
protocol.registerSchemesAsPrivileged([PREVIEW_PRIVILEGED_SCHEME, THUMB_PRIVILEGED_SCHEME]);
// A menu request that finds a running app only hands over and exits; keep it out of the Dock meanwhile.
if (parseOsRequestArgv(process.argv) !== null) app.dock?.hide();
let onOsRequestQueued: () => void = () => undefined;

app.whenReady().then(async () => {
	nativeTheme.on("updated", () => {
		sendToAllWindows(APPEARANCE_CHANNELS.changed, nativeTheme.shouldUseDarkColors ? "dark" : "light");
	});
	// A menu request goes to the app that is already running: the request process hands it over and exits.
	const launchRequest = parseOsRequestArgv(process.argv);
	const endpoint = osRequestEndpoint(app.getPath("userData"));
	if (launchRequest !== null && (await sendOsRequest(endpoint, launchRequest))) {
		app.exit(0);
		return;
	}
	const osRequests = createOsRequestService({ kindOf: diskKindOf, onQueued: () => onOsRequestQueued() });
	const listener = await listenForOsRequests(endpoint, (request) => void osRequests.push(request));
	// Explorer starts one process per selected file; the ones that lost the race for the socket hand over to the winner.
	if (listener === null && launchRequest !== null && (await sendOsRequest(endpoint, launchRequest))) {
		app.exit(0);
		return;
	}
	void app.dock?.show();
	// A packaged macOS build gets its Dock icon from the bundle (build/icon.icns); `electron .` would show Electron's.
	if (!app.isPackaged) app.dock?.setIcon(dockIconPath);
	app.setAboutPanelOptions({ applicationName: APP_FULL_NAME, applicationVersion: APP_VERSION, iconPath: windowIconPath });
	registerPreviewProtocol();
	const iconProvider = createIconProvider();
	registerIconProtocol(iconProvider);
	registerQuickLookIpc(iconProvider);
	// Packaged builds carry the dependency CLIs: they go first on PATH before anything reads the environment.
	// The on-device embedding model is not bundled; `modelDownload` below fetches it when the user picks local embedding.
	applyBundledTools({ resourcesPath: process.resourcesPath, env: process.env, augmentUserPaths: true });
	// The `dazzi` command ships in the app; every start puts (or repairs) it where a terminal finds it.
	if (app.isPackaged) {
		void installCli({
			platform: process.platform,
			homeDir: homedir(),
			bundledBinDir: join(process.resourcesPath, "bin"),
			shell: process.env.SHELL,
			run: async (command, args) => (await execFileAsync(command, [...args], { windowsHide: true })).stdout,
		}).then(
			(result) => console.log(`[cli] ${JSON.stringify(result)}`),
			(error: unknown) => console.error("[cli] installing the dazzi command failed:", error),
		);
	}
	// The local embedding model is served by MinSync's own `minsync serve`, which the app runs while it is open
	// and stops on quit. It never starts before the model is downloaded (`modelDownload`), because `minsync serve`
	// would fetch the 1.2 GB itself without any way to show progress.
	configureEmbeddingDaemon({
		env: process.env,
		home: homedir(),
		ownerFile: join(app.getPath("userData"), "embedding-daemon.json"),
		modelPresent: localModelPresent({ home: homedir(), env: process.env }),
	});
	await ensureAutoRAGConfig();
	const devLabel = resolveDevLabel();
	console.log(`[autorag] ${formatWindowTitle(APP_FULL_NAME, APP_VERSION, devLabel)}`);
	const qaRoot = process.env.AUTORAG_QA_ROOT?.trim() ?? "";
	const rawFixtureHome = !app.isPackaged ? (process.env.AUTORAG_ONBOARDING_FIXTURE_HOME?.trim() ?? "") : "";
	const fixtureHome = rawFixtureHome !== "" && isAbsolute(rawFixtureHome) ? rawFixtureHome : null;
	// Windows can redirect the known folders (OneDrive backup moves Desktop/Documents),
	// so Explorer's real paths come from Electron; on macOS they always live under $HOME.
	// A profile without a resolvable known folder (a throwaway USERPROFILE) makes
	// app.getPath throw; that must fall back to `<home>\<Folder>`, never abort startup.
	const knownFolder = (name: Parameters<typeof app.getPath>[0], fallback: string): string => {
		if (fixtureHome !== null) return fallback;
		try {
			return app.getPath(name);
		} catch (error) {
			console.warn(`places: app.getPath("${name}") failed, using ${fallback}: ${error instanceof Error ? error.message : String(error)}`);
			return fallback;
		}
	};
	const home = fixtureHome ?? app.getPath("home");
	const knownFolders: KnownFolders | undefined =
		process.platform === "win32"
			? {
					desktop: knownFolder("desktop", join(home, "Desktop")),
					documents: knownFolder("documents", join(home, "Documents")),
					downloads: knownFolder("downloads", join(home, "Downloads")),
					music: knownFolder("music", join(home, "Music")),
					videos: knownFolder("videos", join(home, "Videos")),
					pictures: knownFolder("pictures", join(home, "Pictures")),
				}
			: undefined;
	// Stored provider keys reach process.env before the fs worker or any agent
	// resolves, so the worker, LLM, embedding, and reranker all see the same credential.
	const credentials = createProviderCredentialService({
		filePath: join(app.getPath("userData"), "credentials.enc.json"),
		safeStorage,
		env: process.env,
	});
	await credentials.load();
	// Listings, watches, Finder metadata, places, dupey scans, and the index
	// badges run in the fs worker, off this event loop; a native fault there
	// ends only that process (FS roadmap #101). Main keeps the Electron-only
	// pieces it lends the worker: thumbnails, the shell, the clipboard.
	const workerHost = createFsWorkerHost({
		config: {
			userDataDir: app.getPath("userData"),
			...(qaRoot !== "" && isAbsolute(qaRoot) ? { qaRoot } : {}),
			...(fixtureHome === null ? {} : { homeDir: fixtureHome }),
			...(knownFolders === undefined ? {} : { knownFolders }),
		},
		shell,
		clipboard: createOsClipboard({ clipboard, ClipboardItem }),
		icons: iconProvider,
		// A fresh worker starts in Korean; give it the current Interface language.
		onFork: (client) => {
			if (currentLanguage !== "ko") void client.call("setLanguage", [currentLanguage]).catch((error: unknown) => console.error("[fs-worker] language:", error));
		},
	});
	fsWorker = workerHost;
	registerFsWorkerIpc(workerHost, ipcMain);
	// Row drag-out: the renderer hands the gesture to the OS as real files.
	registerDragOutIpcHandlers();
	// Inspector actions: a chooser for "Open with" and the macOS share sheet,
	// anchored to the button that opened it.
	registerActionsIpcHandlers(
		createActionService({
			pdf: createFileePdfReducer(() => readFileeSettings(autoragConfigPath())),
			trash: async (target) => {
				const result = (await workerHost.client.call("trash", [[target]])) as FsBatchResult;
				const failure = result.failed[0];
				if (failure !== undefined) throw new Error(failure.message);
			},
			onProgress: (event, window) => {
				if (window !== null && !window.isDestroyed()) window.webContents.send(ACTIONS_CHANNELS.progress, event);
				else sendToMainWindow(ACTIONS_CHANNELS.progress, event);
			},
			applications: {
				async pick(window) {
					const options: OpenDialogOptions = {
						title: t("main.dialogs.openWithTitle"),
						buttonLabel: t("main.dialogs.openButton"),
						properties: ["openFile"],
						...(process.platform === "darwin" ? { defaultPath: "/Applications" } : {}),
					};
					const result =
						window === null
							? await dialog.showOpenDialog(options)
							: await dialog.showOpenDialog(window, options);
					return result.canceled ? null : (result.filePaths[0] ?? null);
				},
			},
			async applicationIcon(applicationPath) {
				// The provider's listing tier renders the app's own icon (Quick Look
				// thumbnail) and caches it; `getFileIcon` would return the generic bundle glyph.
				const { mtimeMs } = await stat(applicationPath);
				const icons = await iconProvider.icons([{ path: applicationPath, ext: "app", mtimeMs }]);
				return icons.get(applicationPath) ?? null;
			},
			share:
				process.platform === "darwin"
					? {
							present(paths, anchor, window) {
								if (window === null) return;
								new ShareMenu({ filePaths: [...paths] }).popup({
									window,
									x: Math.round(anchor.x),
									y: Math.round(anchor.y + anchor.height + 4),
								});
							},
						}
					: null,
		}),
	);
	const applyScanInterval = (minutes: number): void => {
		void workerHost.client.call("setScanInterval", [minutes]).catch((error: unknown) => console.error("[fs-worker] scan interval:", error));
	};
	const interactionHub = createInteractionHub({
		emitRequest: (request) => sendToMainWindow(INTERACTION_CHANNELS.request, request),
		emitClosed: (event) => sendToMainWindow(INTERACTION_CHANNELS.closed, event),
	});
	// Each chat's model conversation is a pi session file; the index remembers which file is whose.
	const chatSessionsDirectory = join(app.getPath("userData"), "chat-sessions");
	const searchService = createSearchService({
		agentFactory: createDefaultAgentFactory({ sessionDir: chatSessionsDirectory }),
		chatStore: createChatStore({ directory: join(app.getPath("userData"), "chat-history") }),
		sessions: createChatSessionIndex({ directory: chatSessionsDirectory }),
		send: sendToMainWindow,
		analytics,
		interaction: interactionHub,
		// The settings service is built further down; an agent is only built long after startup.
		approvalMode: async () => (await settingsService.get()).approvalMode,
		// A run that searches the index while it is unfinished, stopped, empty or small says so; the readiness is built further down with the index services it reads.
		indexReadiness: () => indexReadiness(),
		// A run on the Dazzi plan's model with the week's credits used up is not sent: the server would refuse every request of it.
		preflight: async () => {
			const configPath = autoragConfigPath();
			const model = existsSync(configPath) ? readRawConfigObject(configPath).model : undefined;
			const provider = isJsonObject(model) && typeof model.provider === "string" ? model.provider : undefined;
			const block = await quotaBlock({
				modelProvider: async () => provider,
				account: accountService,
				now: () => new Date(),
			});
			if (block !== null) {
				return {
					message: t("main.search.quotaExhausted", { date: block.resetsAt.toLocaleString(currentLanguage, { dateStyle: "medium", timeStyle: "short" }) }),
					action: "open-plan",
				};
			}
			// The signed-out trial runs on a guest credential with its own device cap; when it is
			// used up or already claimed, hold the run and offer to sign in/upgrade, as above.
			const guestRelevant = provider === AUTORAG_PROVIDER_ID || (provider === undefined && (await readDazziGuestCredential(getAgentDir())) !== null);
			if (!guestRelevant) return null;
			const guestState = await accountService.guestQuotaStatus();
			if (guestState === "exhausted" || guestState === "claimed") {
				return { message: t(guestState === "claimed" ? "main.search.guestAlreadyClaimed" : "main.search.guestQuotaExhausted"), action: "open-plan" };
			}
			return null;
		},
	});
	registerSearchIpcHandlers(searchService);
	registerInteractionIpcHandlers({
		hub: interactionHub,
		getMode: async () => (await settingsService.get()).approvalMode,
		setMode: async (mode) => (await settingsService.set({ approvalMode: mode })).approvalMode,
	});
	let appliedApprovalMode: ApprovalMode | null = null;
	let previousSettings: AppSettings | null = null;
	const applyAppearance = (appearance: AppAppearance): void => {
		currentAppearance = appearance;
		nativeTheme.themeSource = appearance;
		sendToAllWindows(APPEARANCE_CHANNELS.changed, appearance);
		// The Windows/Linux window buttons are drawn by the window, not the page: recolor their symbols with the theme.
		syncWindowControls();
	};
	/** Main's own messages, the fs worker's, and Quick Look follow the Interface language; the Finder applies it itself. */
	const applyLanguage = (language: AppSettings["language"]): void => {
		if (language === currentLanguage) return;
		currentLanguage = language;
		void setAppLanguage(language);
		void workerHost.client.call("setLanguage", [language]).catch((error: unknown) => console.error("[fs-worker] language:", error));
		sendToAllWindows(LANGUAGE_CHANNELS.changed, language);
	};
	const osMenu = createOsMenuIntegration({
		platform: process.platform,
		// os.homedir() honors $HOME (and USERPROFILE), so QA and tests can aim the install at a throwaway home.
		homeDir: homedir(),
		execPath: process.execPath,
		// Unpackaged, Electron needs the app directory to know what to run. The profile always rides along,
		// so a custom --user-data-dir run (dev, QA) is the one its own menu entries reach.
		appArgs: [...(app.isPackaged ? [] : [app.getAppPath()]), `--user-data-dir=${app.getPath("userData")}`],
		run: async (command, args) => {
			await execFileAsync(command, [...args], { windowsHide: true });
		},
	});
	const autoRagConfig = createAutoRagConfigService({ env: process.env, cwd: process.cwd() });
	const providerAuth = createProviderAuthService({
		send: (event) => sendToMainWindow(SETTINGS_CHANNELS.providerLoginEvent, event),
		env: process.env,
		credentials,
	});
	providerAuthService = providerAuth;
	// auth.json-stored OpenRouter/Vercel keys reach process.env so the env-driven
	// Jev/rerank backends resolve the same credential.
	void providerAuth.warmEnv();
	const dataSources = createDataSourceStatusService({ env: process.env, cwd: process.cwd() });
	// Every datasource sync the app starts (Settings buttons, embedding rebuild) goes through this one wrapper:
	// it takes the shared refresh lock and is journaled, so it shows in the indexing progress.
	const schedulePath = schedulePaths(autoragConfigPath());
	const refreshQueue = createRefreshQueue(schedulePath);
	const lockedDataSources = lockDataSources(dataSources, schedulePath, refreshQueue);
	const localSpec = createLocalSpecProbe({ env: process.env, allowOverride: !app.isPackaged });
	// The on-device embedding model is downloaded on demand (onboarding, Settings), never bundled. One service for
	// the whole app, so a download started in one place shows its progress everywhere.
	const modelDownload = createModelDownloadService({
		cacheRoot: minSyncModelCacheRoot({ platform: process.platform, home: homedir(), env: process.env }),
		spec: nativeQwen3Spec(),
		onChange: (status) => {
			sendToAllWindows(MODEL_DOWNLOAD_CHANNELS.changed, status);
			// The server refused to start while the weights were missing; bring it up the moment they are here.
			if (status.state === "ready") void ensureEmbeddingForConfig(existsSync(autoragConfigPath()) ? readRawConfigObject(autoragConfigPath()) : {});
		},
	});
	registerModelDownloadIpcHandlers(modelDownload);
	/** Downloads the on-device model when it is not here yet; `null` once it is, else the reason it is not. */
	const ensureLocalModel = async (): Promise<string | null> => {
		await modelDownload.start();
		const done = await modelDownload.settled();
		return done.state === "ready" ? null : (done.error ?? t("main.modelDownload.errors.cancelled"));
	};
	const busyResult =
		(methods: readonly string[] | undefined) =>
		(holder: RefreshLockHolder): ConfigRefreshResult => ({
			ok: false,
			methods: methods ?? LOCAL_REFRESH_METHODS,
			scanned: 0,
			written: 0,
			deleted: 0,
			skipped: 0,
			diagnostics: [],
			error: busyMessage(holder),
		});
	/** Enqueues a local-index run in the shared background refresh queue, journaled so it shows in the indexing progress. */
	const runLocalIndex = <Busy extends ConfigRefreshResult | null>(
		owner: string,
		methods: readonly string[] | undefined,
		onBusy: (holder: RefreshLockHolder) => Busy,
		onResult: (result: ConfigRefreshResult) => void = () => undefined,
	): Promise<ConfigRefreshResult | Busy> =>
		refreshQueue.enqueue<ConfigRefreshResult, Busy>({
			item: LOCAL_ITEM,
			owner,
			work: async () => {
				const result = await refreshConfig(methods);
				onResult(result);
				return result;
			},
			onBusy,
		});
	// What is still wrong with the index once onboarding is over: kept across relaunches, shown by the Finder's sidebar, banner and Settings card.
	const indexProblem = createIndexProblemService({
		filePath: join(app.getPath("userData"), "index-problem.json"),
		send: (problem) => sendToMainWindow(INDEX_PROBLEM_CHANNELS.changed, problem),
		run: async () => {
			let result = await runLocalIndex("manual-refresh", undefined, () => null);
			// The on-device model is fetched here, with progress and a way to stop it, before MinSync would fetch it silently.
			if (result?.diagnostics.some((diagnostic) => diagnostic.code === "embedding-model-missing") === true) {
				const missing = await ensureLocalModel();
				if (missing !== null) return { ok: false, ...modelDownloadFailure(missing) };
				result = await runLocalIndex("manual-refresh", undefined, () => null);
			}
			return result;
		},
	});
	registerIndexProblemIpcHandlers(indexProblem);
	// A run from Settings that reached the folders tells whether the index works now.
	const recordLocalRun = (result: ConfigRefreshResult): void => {
		if (result.methods.includes("parsed") || result.methods.includes("minsync")) indexProblem.record(result);
	};
	const embeddingService = createEmbeddingSettingsService({
		env: process.env,
		cwd: process.cwd(),
		config: autoRagConfig,
		dataSources: lockedDataSources,
		localSpec,
		credentials,
		modelReady: () => modelDownload.status().state === "ready",
		// `accountService` is created further down; the service only calls this once the app is running.
		cloudEmbeddings: async () => {
			const status = await accountService.status();
			return status.state === "signedIn" && status.account !== null ? status.account.embeddings : null;
		},
	});
	// Bring the local model up in the background for the config the user has; search degrades to keywords until it answers.
	void ensureEmbeddingForConfig(existsSync(autoragConfigPath()) ? readRawConfigObject(autoragConfigPath()) : {});
	// Unpackaged, registering would add the bare Electron binary to Login Items
	// rather than AutoRAG, so only a packaged build touches the OS login item.
	const applyLoginItem = (enabled: boolean): void => {
		if (!app.isPackaged) return;
		app.setLoginItemSettings({ openAtLogin: enabled });
	};
	/**
	 * Reads the OS back: true when the login item is in the state the stored setting
	 * claims. `requires-approval` is a registered item the user still has to allow in
	 * Login Items, so it counts. An unpackaged build has no OS item to manage.
	 */
	const loginItemApplied = (enabled: boolean): boolean => {
		if (!app.isPackaged) return true;
		const { status, openAtLogin } = app.getLoginItemSettings();
		const registered = openAtLogin || status === "enabled" || status === "requires-approval";
		return registered === enabled;
	};
	let appliedLaunchAtLogin: boolean | null = null;
	// Created once settings are readable (below); settings changes before that have nothing to re-apply.
	let appUpdater: AppUpdaterService | null = null;
	const refreshScheduler = createRefreshScheduler({
		platform: process.platform,
		execPath: process.execPath,
		jobPath: join(import.meta.dirname, "refresh-job.js"),
		configPath: autoragConfigPath,
	});
	const settingsService = createSettingsService({
		directory: join(app.getPath("userData"), "settings"),
		// A first run (no stored choice) follows the OS language; onboarding shows it before the user could set one.
		systemLanguage: detectSystemLanguage({
			platform: process.platform,
			preferred: () => app.getPreferredSystemLanguages(),
			systemLocale: () => app.getSystemLocale(),
			home: homedir(),
			readTextFile: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
		}),
		dataSources: lockedDataSources,
		models: createModelStatusService({ env: process.env, cwd: process.cwd() }),
		config: autoRagConfig,
		refreshConfig: (methods) => runLocalIndex("manual-refresh", methods, busyResult(methods), recordLocalRun),
		refreshScheduler,
		credentials,
		providers: providerAuth,
		embedding: embeddingService,
		mcp: createMcpSettingsService({ agentDir: () => getAgentDir() }),
		mcpConnect: () => resolveMcpConnectInfo({ resourcesPath: process.resourcesPath, entryPath: join(import.meta.dirname, "mcp-server.js"), env: process.env, platform: process.platform }),
		applyOsMenu: async (next, previous) => {
			if (next.osMenuIntegration) {
				if (!previous.osMenuIntegration || next.language !== previous.language) await osMenu.install(menuLabels(next.language));
			} else if (previous.osMenuIntegration) {
				await osMenu.uninstall();
			}
		},
		onSettingsChanged: (settings) => {
			// First: turning the setting off must stop everything (and delete the id) before this change's own event is considered.
			analytics.setEnabled(settings.usageAnalytics);
			if (previousSettings !== null) for (const change of settingChangeEvents(previousSettings, settings)) analytics.track("settings_changed", change);
			previousSettings = settings;
			if (appliedApprovalMode !== settings.approvalMode) {
				appliedApprovalMode = settings.approvalMode;
				searchService.setApprovalMode(settings.approvalMode);
				sendToAllWindows(INTERACTION_CHANNELS.modeChanged, settings.approvalMode);
			}
			setErrorReportingEnabled(settings.errorReporting);
			currentQuickLookChord = resolveEffectiveShortcuts(settings.shortcuts).quickLook;
			quickSearchShortcut?.apply(settings.quickSearch);
			applyAppearance(settings.appearance);
			applyLanguage(settings.language);
			applyScanInterval(settings.dupeyScanIntervalMinutes);
			// A failed start (port taken) is shown in Settings through the status's `serverError`, not thrown at nobody.
			applyRemoteAccess(settings.remoteAccess).catch((error: unknown) => {
				console.error("[remote] could not start remote access:", error instanceof Error ? error.message : error);
			});
			void remoteHost?.setTunnelHostname(settings.remoteTunnelHostname);
			if (appliedLaunchAtLogin !== settings.launchAtLogin) {
				appliedLaunchAtLogin = settings.launchAtLogin;
				applyLoginItem(settings.launchAtLogin);
			}
			void appUpdater?.applySettings();
			sendToAllWindows(SETTINGS_CHANNELS.changed, settings);
		},
	});
	registerSettingsIpcHandlers(settingsService);
	registerAnalyticsIpcHandlers(analytics);
	void settingsService.get().then((settings) => {
		previousSettings ??= settings;
		currentQuickLookChord = resolveEffectiveShortcuts(settings.shortcuts).quickLook;
	});
	analytics.track("app_opened", {});
	const indexActivity = createIndexActivityService({
		configPath: autoragConfigPath,
		resolveWorkspacePath: async () => (await resolveEffectiveConfig({ env: process.env, cwd: process.cwd() })).config.workspacePath,
		journalPath: () => schedulePath.activity,
		// Keyword-only runs MinSync too, as a keyword index; the progress screens name that stage by this switch.
		semanticSearch: () => {
			const configPath = autoragConfigPath();
			return !existsSync(configPath) || readAppIndexing(readRawConfigObject(configPath)).semanticSearch;
		},
		// The fs worker runs the checkbox-toggle refresh, so its pid marks that run as this app's own.
		ownPids: () => [workerHost.status().pid],
	});
	registerIndexActivityIpcHandlers(indexActivity);
	// Read by AI Search the moment a run takes the local track: the same activity, problem and source counts Settings → Indexing shows.
	const indexReadiness = createIndexReadiness({
		activity: () => indexActivity.snapshot(),
		problem: () => indexProblem.get(),
		sources: () => dataSources.list(),
	});
	const stopIndexActivity = indexActivity.start((snapshot) => {
		sendToMainWindow(INDEX_ACTIVITY_CHANNELS.changed, snapshot);
		// The OS-scheduled job finished a clean local refresh: whatever stopped the first index is over.
		if (snapshot.state === "done" && snapshot.origin === "scheduled" && snapshot.items.some((item) => item.kind === "local" && item.state === "done")) {
			indexProblem.clearFailure();
		}
	});
	app.once("will-quit", stopIndexActivity);
	const automations = createAutomationService({
		home: () => autoragHome(process.env, homedir()),
		// The daemon's login service records whichever node ran the install, so it is never this process's own binary.
		run: (args) => {
			const librarian = librarianCommand({ resourcesPath: process.resourcesPath, env: process.env, platform: process.platform });
			return runLibrarianCli(librarian.command, [...librarian.args, ...args], process.env);
		},
	});
	registerAutomationIpcHandlers(automations);
	registerDemoIpcHandlers(
		createDemoService({
			home: homedir(),
			downloads: knownFolder("downloads", join(homedir(), "Downloads")),
			platform: process.platform,
			automations,
			settings: settingsService,
		}),
	);
	const stopAutomations = automations.start((snapshot) => {
		sendToMainWindow(AUTOMATION_CHANNELS.changed, snapshot);
	});
	app.once("will-quit", stopAutomations);
	registerOsRequestIpcHandlers(osRequests);
	// The in-app right-click → 서비스 submenu: what macOS offers for the selection, and performing one.
	registerServicesIpcHandlers(createServicesService());
	// Renaming a file to another format's extension converts it (Filee); the settings are the shared AutoRAG config's `filee` block.
	registerConversionIpcHandlers(createFileeConversionService(() => readFileeSettings(autoragConfigPath())));
	// Remote access: the same Finder UI served to a browser when the setting is
	// on, each session with its own fs-worker client and its own watches.
	const remoteTargets = {
		settings: SETTINGS_CHANNELS,
		search: SEARCH_CHANNELS,
		interaction: INTERACTION_CHANNELS,
		account: ACCOUNT_CHANNELS,
		modelDownload: MODEL_DOWNLOAD_CHANNELS,
		errorFix: ERROR_FIX_CHANNELS,
		appCustomizer: APP_CUSTOMIZER_CHANNELS,
		magicAction: MAGIC_ACTION_CHANNELS,
		automations: AUTOMATION_CHANNELS,
		demo: DEMO_CHANNELS,
		indexActivity: INDEX_ACTIVITY_CHANNELS,
		indexProblem: INDEX_PROBLEM_CHANNELS,
		appUpdate: APP_UPDATE_CHANNELS,
		onboarding: ONBOARDING_CHANNELS,
		osRequests: OS_REQUEST_CHANNELS,
		services: SERVICES_CHANNELS,
		conversion: CONVERSION_CHANNELS,
		actions: ACTIONS_CHANNELS,
		analytics: ANALYTICS_CHANNELS,
	} as const;
	const ensureRemoteHost = (): RemoteHost => {
		remoteHost ??= createRemoteHost({
			rendererRoot: join(import.meta.dirname, "../renderer"),
			stateDir: join(app.getPath("userData"), "settings"),
			host: "0.0.0.0",
			port: async () => (await settingsService.get()).remotePort,
			icons: iconProvider,
			workerHost,
			targets: remoteTargets,
			window: () => mainWindow,
			settings: () => settingsService.get(),
			onStatusChanged: (next) => sendToAllWindows(REMOTE_CHANNELS.changed, next),
		});
		return remoteHost;
	};
	async function applyRemoteAccess(enabled: boolean): Promise<void> {
		if (enabled) {
			await ensureRemoteHost().start();
			return;
		}
		await remoteHost?.stop();
	}
	const remoteStatus = (): Promise<RemoteAccessStatus> => ensureRemoteHost().status();
	ipcMain.handle(REMOTE_CHANNELS.status, () => remoteStatus());
	// The Settings switch reports the outcome as status (`serving` / `serverError`) instead of rejecting the call.
	ipcMain.handle(REMOTE_CHANNELS.start, async () => {
		await applyRemoteAccess(true).catch(() => undefined);
		return remoteStatus();
	});
	ipcMain.handle(REMOTE_CHANNELS.stop, async () => {
		await applyRemoteAccess(false);
		return remoteStatus();
	});
	ipcMain.handle(REMOTE_CHANNELS.startPairing, () => ensureRemoteHost().startPairing());
	ipcMain.handle(REMOTE_CHANNELS.devices, () => ensureRemoteHost().devices());
	ipcMain.handle(REMOTE_CHANNELS.renameDevice, (_event, id: string, label: string) => ensureRemoteHost().renameDevice(id, label));
	ipcMain.handle(REMOTE_CHANNELS.revokeDevice, (_event, id: string) => ensureRemoteHost().revokeDevice(id));
	ipcMain.handle(REMOTE_CHANNELS.revokeAllDevices, () => ensureRemoteHost().revokeAllDevices());
	ipcMain.handle(REMOTE_CHANNELS.refreshNetwork, () => ensureRemoteHost().refreshNetwork());
	ipcMain.handle(REMOTE_CHANNELS.startTunnel, () => ensureRemoteHost().startTunnel());
	ipcMain.handle(REMOTE_CHANNELS.stopTunnel, () => ensureRemoteHost().stopTunnel());
	ipcMain.handle(REMOTE_CHANNELS.loginTunnel, () => ensureRemoteHost().loginTunnel());
	app.once("will-quit", () => {
		void remoteHost?.stop();
	});
	const settings = await settingsService.get();
	appliedLaunchAtLogin = settings.launchAtLogin;
	// A stored choice applies on launch, not only when it changes. A taken port
	// (another Dazzi on the same profile) must not abort the rest of startup.
	await applyRemoteAccess(settings.remoteAccess).catch((error: unknown) => {
		console.error("[remote] could not start remote access:", error instanceof Error ? error.message : error);
	});
	applyAppearance(settings.appearance);
	applyLanguage(settings.language);
	if (settings.dupeyScanIntervalMinutes !== DEFAULT_SCAN_INTERVAL_MINUTES) applyScanInterval(settings.dupeyScanIntervalMinutes);
	let notifiedUpdate: string | null = null;
	appUpdater = await createAppUpdateHost({
		isPackaged: app.isPackaged,
		platform: process.platform,
		resourcesPath: process.resourcesPath,
		executablePath: app.getPath("exe"),
		currentVersion: APP_VERSION,
		logPath: join(app.getPath("logs"), "updater.log"),
		autoInstall: async () => (await settingsService.get()).autoInstallUpdates,
		openExternal: (url) => shell.openExternal(url),
		onChange: (snapshot) => {
			sendToMainWindow(APP_UPDATE_CHANNELS.changed, snapshot);
			// One system notification per version: when it is installed-on-quit, or (notify mode) when it can be downloaded.
			const { state } = snapshot;
			const version = state.kind === "ready" || (state.kind === "available" && snapshot.mode === "notify") ? state.version : null;
			if (version === null || version === notifiedUpdate || !Notification.isSupported()) return;
			notifiedUpdate = version;
			const body = t(state.kind === "ready" ? "main.update.readyNotification" : "main.update.availableNotification", { version });
			new Notification({ title: APP_FULL_NAME, body }).show();
		},
	});
	registerAppUpdateIpcHandlers(appUpdater);
	installCheckForUpdatesMenuItem(appUpdater);
	appUpdater.start();
	const userDataDir = app.getPath("userData");
	const supportedExtensions = supportedExtensionsFromRegistry(createDefaultParserRegistry());
	const scanOptions = { supportedExtensions, maxSourceBytes: DEFAULT_MAX_SOURCE_BYTES };
	const scanCoordinator = createFolderScanCoordinator({
		options: scanOptions,
		...(process.platform === "darwin" ? { listDatalessPaths: listMacDatalessPaths } : {}),
		// Nothing streams a scan to the renderer any more: the first run waits for the totals it feeds.
		emit: () => undefined,
	});
	// "AI로 고치기": the error-fix helper runs on the AI Search model and repairs the shared config and the index.
	registerErrorFixIpcHandlers(
		createErrorFixService({
			send: (event) => sendToMainWindow(ERROR_FIX_CHANNELS.event, event),
			resolveModel: () => resolveConfiguredSessionModel(process.env, process.cwd(), getAgentDir()),
			agentDir: getAgentDir(),
			env: process.env,
			cwd: process.cwd(),
			language: () => currentLanguage,
			config: autoRagConfig,
			diagnostics: async () => {
				const [model, sources] = await Promise.all([settingsService.modelsResolve(), dataSources.list()]);
				return {
					model: model.error !== null ? { error: model.error } : model.model === null ? null : { provider: model.model.provider, id: model.model.modelId, signedIn: model.model.auth.present },
					sources: sources.error !== null ? { error: sources.error } : sources.sources.map((source) => ({ id: source.id, type: source.type, enabled: source.enabled, install: source.install.state, index: source.index.state, indexDetail: source.index.detail })),
					localIndex: sources.local,
					indexProblem: indexProblem.get(),
				};
			},
			refreshIndex: () => runLocalIndex("manual-refresh", undefined, busyResult(undefined), recordLocalRun),
			// An open chat's agent was built on the old config; the next question rebuilds it and resumes the conversation.
			onConfigChanged: () => void searchService.resetAgents(),
		}),
	);
	const customizerPlaces = createPlaces({
		homeDir: home,
		platform: process.platform,
		...(knownFolders === undefined ? {} : { knownFolders }),
	});
	const customizerTags = createFinderTags({ homeDir: home, platform: process.platform });
	const appCustomizerService = createAppCustomizerService({
		send: (event) => sendToMainWindow(APP_CUSTOMIZER_CHANNELS.event, event),
		resolveModel: () => resolveConfiguredSessionModel(process.env, process.cwd(), getAgentDir()),
		agentDir: getAgentDir(),
		env: process.env,
		cwd: process.cwd(),
		homeDir: home,
		language: () => currentLanguage,
		settings: settingsService,
		listLocations: () => customizerPlaces.list().catch(() => []),
		listTags: () => customizerTags.catalog().then((catalog) => catalog.tags.filter((tag) => tag.sidebar), () => []),
	});
	registerAppCustomizerIpcHandlers(appCustomizerService);
	app.once("will-quit", () => appCustomizerService.dispose());
	const magicActionService = createMagicActionService({
		send: (event) => sendToMainWindow(MAGIC_ACTION_CHANNELS.event, event),
		resolveModel: () => resolveConfiguredSessionModel(process.env, process.cwd(), getAgentDir()),
		agentDir: getAgentDir(),
		env: process.env,
		homeDir: home,
		language: () => currentLanguage,
		settings: settingsService,
	});
	registerMagicActionIpcHandlers(magicActionService);
	app.once("will-quit", () => magicActionService.dispose());
	// One cached promise: a device id is stable for the process lifetime, and probes must not re-run per call.
	let deviceIdPromise: Promise<string> | null = null;
	const getDeviceId = (): Promise<string> => {
		deviceIdPromise ??= resolveAnonymousDeviceId({ platform: process.platform, home, env: process.env, packaged: app.isPackaged });
		return deviceIdPromise;
	};
	const accountService = createAccountService({
		env: process.env,
		credentials,
		cachePath: join(app.getPath("userData"), "account.json"),
		configPath: autoragConfigPath(),
		deviceId: getDeviceId,
		openExternal: (url) => shell.openExternal(url),
		send: sendToMainWindow,
		// The picker lists the plan's models from the runtime's persisted catalog.
		onSignedIn: () => providerAuth.syncAutoragCatalog(),
	});
	registerAccountIpcHandlers(accountService);
	// Dictation for AI Search: the hosted speech-to-text endpoint with the account key, and the OS microphone permission.
	registerVoiceIpcHandlers(
		createVoiceService({
			env: process.env,
			readKey: () => readDazziPlanCredential(getAgentDir()),
			microphone: systemMicrophoneAccess({
				platform: process.platform,
				preferences: systemPreferences,
				openExternal: (url) => shell.openExternal(url),
			}),
		}),
	);
	// A fresh, unauthenticated launch provisions anonymous guest access so the plan's models work before sign-in.
	void accountService
		.refresh()
		.then((status) => {
			if (status.state === "signedOut") void accountService.ensureGuestAccess().catch(() => undefined);
		})
		.catch(() => undefined);
	app.once("will-quit", () => void accountService.dispose());

	const firstRun: FirstRunService = createFirstRunService({
		userDataDir,
		env: process.env,
		cwd: process.cwd(),
		platform: process.platform,
		home,
		knownFolders: {
			desktop: knownFolder("desktop", join(home, "Desktop")),
			documents: knownFolder("documents", join(home, "Documents")),
			downloads: knownFolder("downloads", join(home, "Downloads")),
		},
		iCloudDrivePath: fixtureHome === null && process.platform === "darwin" ? join(home, "Library", "Mobile Documents", "com~apple~CloudDocs") : null,
		// A fixture home offers only its own folders, like iCloud Drive above.
		...(fixtureHome === null ? {} : { cloudFolders: () => [] }),
		configPath: autoragConfigPath(),
		resolveWorkspacePath: async () => (await resolveEffectiveConfig({ env: process.env, cwd: process.cwd() })).config.workspacePath,
		refresh: (methods) => runLocalIndex("onboarding-index", methods, busyResult(methods)),
		recordIndex: (outcome) => indexProblem.record(outcome),
		// The first run indexes its folders and, on the same run, scans them for duplicates so the tour can show a family.
		scanFolders: (paths) => scanCoordinator.start(paths),
		folderTotals: (paths) => scanCoordinator.totalFiles(paths),
		scanFailed: (path) => scanCoordinator.cached(path)?.error !== null && scanCoordinator.cached(path)?.error !== undefined,
		refreshDuplicates: async () => {
			await workerHost.client.call("refreshVersionFamilies");
		},
		resolveModel: () => resolveConfiguredSessionModel(process.env, process.cwd(), getAgentDir()),
		// Through Pi's runtime, which authenticates the plan's OAuth credential; a bare `completeSimple` has no key for it.
		complete: async (model, context, options) => (await openPlanRuntime(getAgentDir(), process.env)).completeSimple(model, context, options),
		// The tour's question is verified with model-free keyword retrieval over the config the app actually runs with.
		retrieve: async (query, options) => {
			const { config } = await resolveEffectiveConfig({ env: process.env, cwd: process.cwd() });
			const { results } = await new AutoRAGLite(config).retrieve(query, options);
			return results;
		},
		// Jev scores each question: only one a real person would recognise as theirs (0.9+) becomes the tour's.
		judgeDemoQuestions: createDemoQuestionJudge({
			env: process.env,
			agentDir: getAgentDir(),
			model: () => {
				const jev = existsSync(autoragConfigPath()) ? readRawConfigObject(autoragConfigPath()).jev : undefined;
				return typeof jev === "object" && jev !== null && "backend" in jev && jev.backend === "dazzi" && "model" in jev && typeof jev.model === "string" ? jev.model : undefined;
			},
		}),
		scanOptions,
		language: () => currentLanguage,
		send: sendToMainWindow,
		openExternal: (url) => shell.openExternal(url),
		pickFolders: async () => {
			const options: OpenDialogOptions = {
				title: t("main.dialogs.chooseFolderTitle"),
				buttonLabel: t("main.dialogs.addButton"),
				properties: ["openDirectory", "multiSelections", "createDirectory"],
			};
			const parent = mainWindow;
			const result = parent === null || parent.isDestroyed() ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
			return result.canceled ? [] : result.filePaths;
		},
		startPowerSaveBlocker: () => powerSaveBlocker.start("prevent-app-suspension"),
		stopPowerSaveBlocker: (id) => powerSaveBlocker.stop(id),
		probeFullDiskAccess: () => probeFullDiskAccess(home),
		// A fresh unauthenticated launch provisions the guest credential + plan models before indexing and the tour.
		ensureModelAccess: () => accountService.ensureGuestAccess(),
		onComplete: () => {
			analytics.track("onboarding_completed", {});
		},
	});
	registerOnboardingIpcHandlers(firstRun);
	/** Closing the last window while the first index runs would stop it, so that close asks first. */
	const confirmLastClose = (window: BrowserWindow, event: Electron.Event): void => {
		const decision = closeDecision({ pending: firstRun.pending(), indexing: firstRun.isIndexing(), windowsOpen: appWindows().length });
		if (decision === "allow") return;
		event.preventDefault();
		void dialog
			.showMessageBox(window, {
				type: "warning",
				buttons: [t("main.dialogs.quitButton"), t("main.dialogs.continueButton")],
				defaultId: 1,
				cancelId: 1,
				message: t("main.dialogs.indexingInProgress"),
				detail: t("main.dialogs.indexingQuitDetail"),
			})
			.then((result) => {
				if (result.response === 0 && !window.isDestroyed()) window.destroy();
			});
	};
	const openFinderWindow = (): BrowserWindow => {
		// The flag only reaches a window opened while the first run is still pending; `load` stays authoritative.
		const window = createAppWindow(devLabel, currentAppearance, firstRun.pending());
		const clearWatchSet = (): void => {
			void workerHost.client.call("setWatchSet", [[]]);
		};
		window.webContents.on("render-process-gone", clearWatchSet);
		window.webContents.on("destroyed", clearWatchSet);
		window.on("close", (event) => confirmLastClose(window, event));
		return window;
	};
	/** Open the Finder if it is not on screen. */
	const openWindows = (): void => {
		if (mainWindow === null || mainWindow.isDestroyed()) mainWindow = openFinderWindow();
	};
	openWindows();
	// A Dock click only brings the window back when none is left.
	app.on("activate", () => {
		if (appWindows().length === 0) openWindows();
	});
	// Menu requests: queue the cold-start request, then serve the ones the running app receives.
	onOsRequestQueued = () => {
		if (mainWindow === null || mainWindow.isDestroyed()) {
			mainWindow = openFinderWindow();
		} else {
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.show();
			mainWindow.focus();
		}
		// The request came from another app (Finder / Explorer), which owns the foreground.
		app.focus({ steal: true });
		sendToMainWindow(OS_REQUEST_CHANNELS.available, null);
	};
	if (launchRequest !== null) void osRequests.push(launchRequest);
	// The quick-search launcher: a system-wide shortcut summons it over any app (Settings → General).
	const launcher: QuickSearchWindow = createQuickSearchWindow({
		preload: join(import.meta.dirname, "../preload/quick-search.mjs"),
		appearance: currentAppearance,
		language: currentLanguage,
		loadPage: (window) => loadRendererPage(window, "quick-search.html"),
		revealInApp: (path) => osRequests.push({ action: "reveal", paths: [path] }),
		// Same checks as `dazzi --ask`: a blank, oversized, or NUL-carrying question queues nothing.
		ask: (query) => {
			const request = normalizeOsLaunchRequest({ action: "ask", paths: [], query });
			if (request !== null) void osRequests.push(request);
		},
		attach: (paths) => osRequests.push({ action: "ask", paths }),
		status: () => quickSearchShortcut?.status() ?? { registered: false, error: null },
		setRecording: (recording) => quickSearchShortcut?.setPaused(recording),
		// Above the launcher, which sits at `pop-up-menu` on macOS and `screen-saver` on Windows.
		attachPreview: (owner) => attachQuickLook(owner, { ...quickLookOptions(currentAppearance), level: "screen-saver", closeWithOwner: true }),
	});
	quickSearchShortcut = createQuickSearchShortcut({
		register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
		unregister: (accelerator) => globalShortcut.unregister(accelerator),
		onPress: () => launcher.toggle(),
	});
	quickSearchShortcut.apply(settings.quickSearch);
	// Windows and Linux quit when the last app window closes; the hidden launcher must not keep the app alive.
	app.on("browser-window-created", (_event, created) => {
		created.once("closed", () => {
			if (process.platform !== "darwin" && appWindows().length === 0) launcher.destroy();
		});
	});
	app.once("will-quit", () => {
		quickSearchShortcut?.dispose();
		launcher.destroy();
	});
	if (settings.osMenuIntegration) {
		// Refresh on every start: the executable path or interface language may have changed.
		osMenu.install(menuLabels(settings.language)).catch((error: unknown) => console.error("[os-menu] refresh failed:", error));
	}
	app.once("will-quit", () => void providerAuthService?.dispose());
	// Re-time or remove an OS refresh job the user already enabled. Installing one is only ever the result of the user choosing a cadence.
	void refreshScheduler
		.status()
		.then((status) => (status.installed ? refreshScheduler.reconcile() : status))
		.then((status) => {
			if (status.error !== null) console.error("AutoRAG background refresh scheduling failed", status.error);
		});
	app.once("will-quit", () => void listener?.close());
	// The worker's native watcher must finish unsubscribing before its Node
	// environment is torn down (an unsubscribe completing inside
	// `FreeEnvironment` aborts that process). Hold the quit until the worker
	// has released its watches, bounded so a stuck worker never blocks
	// quitting. Every other `will-quit` listener has already run and the
	// windows are closed by now, so the quit finishes with `app.exit` —
	// re-entering `app.quit()` from inside its own quit can stall the teardown.
	app.once("will-quit", (event) => {
		event.preventDefault();
		// minsync outlives the app and keeps its lock; stop it so the next launch can resume instead of failing on the lock.
		void Promise.all([stopEmbeddingDaemon().then(() => terminateMinSyncChildren()), workerHost.dispose(), analytics.shutdown(), searchService.dispose()])
			.catch((error: unknown) => console.error("[fs-worker] dispose on quit failed:", error))
			.finally(() => app.exit(0));
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

