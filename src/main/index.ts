import { homedir } from "node:os";
import { access, open, readdir, readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { applyBundledTools } from "./bundled-tools";
import { createModelDownloadService, localModelPresent, minSyncModelCacheRoot, nativeQwen3Spec } from "./model-download";
import { MODEL_DOWNLOAD_CHANNELS } from "../shared/model-download-contract";
import {
	app,
	BrowserWindow,
	clipboard,
	dialog,
	ipcMain,
	nativeImage,
	nativeTheme,
	Notification,
	powerSaveBlocker,
	protocol,
	safeStorage,
	ShareMenu,
	screen,
	shell,
	type OpenDialogOptions,
} from "electron";
import { APPEARANCE_CHANNELS } from "../shared/appearance-contract";
import { setAppLanguage, t } from "../shared/i18n/core";
import { LANGUAGE_CHANNELS } from "../shared/language-contract";
import { ONBOARDING_CHANNELS, ONBOARDING_PENDING_FLAG, type NetworkCheck } from "../shared/onboarding-contract";
import { SMART_INDEXING_CHANNELS } from "../shared/smart-indexing-contract";
import type { AppAppearance, AppSettings, ConfigRefreshResult } from "../shared/settings-contract";
import { attachQuickLook, PREVIEW_PRIVILEGED_SCHEME, registerPreviewProtocol, registerQuickLookIpc } from "../preview/node/register";
import { createDefaultParserRegistry, DEFAULT_MAX_SOURCE_BYTES, writeDefaultConfig } from "@autorag/librarian";
import { readRawConfigObject, resolveConfigPath, writeConfigObject } from "@autorag/librarian/core";
import { DEFAULT_CODE_FOLDER_NAMES, isJsonObject, SETTINGS_CHANNELS } from "../shared/settings-contract";
import { LOCAL_REFRESH_METHODS } from "./index-refresh";
import { INDEX_ACTIVITY_CHANNELS } from "../shared/index-activity-contract";
import { createIndexActivityService } from "./index-activity";
import { APP_UPDATE_CHANNELS } from "../shared/update-contract";
import type { AppUpdaterService } from "./app-updater";
import { createAppUpdateHost, installCheckForUpdatesMenuItem } from "./app-update-host";
import { createActivityJournal, journalSingleRun, LOCAL_ITEM, sourceItem } from "./index-activity-journal";
import { busyMessage, lockDataSources } from "./locked-datasources";
import { schedulePaths, withRefreshLock } from "./refresh-schedule";
import { createRefreshScheduler } from "./refresh-scheduler";
import { createIconProvider } from "./file-icon";
import { registerIconProtocol, THUMB_PRIVILEGED_SCHEME } from "./icon-register";
import type { KnownFolders } from "../shared/fs-worker-contract";
import { hasErrorCode, pathExists } from "./fs-entry";
import { refreshAutoragIndex, resolveEffectiveConfig } from "./index-refresh";
import { terminateMinSyncChildren } from "./minsync-watchdog";
import { createFolderScanCoordinator, supportedExtensionsFromRegistry } from "./onboarding-scan";
import { createAccountService } from "./account-service";
import { createOnboardingService, type OnboardingService } from "./onboarding-service";
import { detectSources } from "./onboarding-sources";
import { detectModelProviders, verifyModel as verifyModelRequest } from "./onboarding-models";
import { FS_CHANNELS } from "../shared/fs-contract";
import dockIconPath from "../../build/icon.png?asset";
import windowIconPath from "../../build/icons/512x512.png?asset";
import { APP_FULL_NAME, APP_VERSION, formatWindowTitle, type DevLabel } from "../shared/app-info";
import { createChatStore } from "./chat-store";
import { createDataSourceStatusService } from "./datasource-status";
import { readDevLabel, resolveClonePath } from "./dev-label";
import { createFsWorkerHost, registerFsWorkerIpc, type FsWorkerHost } from "./fs-worker-host";
import { createAutoRagConfigService } from "./autorag-config-service";
import { createModelStatusService } from "./model-status";
import { createProviderAuthService, type ProviderAuthService } from "./provider-auth-service";
import { createProviderCredentialService } from "./provider-credentials";
import { createLocalSpecProbe } from "./hardware-probe";
import { configureEmbeddingDaemon, ensureEmbeddingForConfig, stopEmbeddingDaemon } from "./embedding-daemon";
import { migrateLegacyEmbedding } from "./embedding-migration";
import { createEmbeddingSettingsService } from "./embedding-settings-service";
import { createMcpSettingsService } from "./mcp-settings-service";
import { createDefaultAgentFactory, createSearchService } from "./search-service";
import { resolveConfiguredSessionModel } from "@autorag/librarian/profiles";
import { createSmartIndexingService } from "./smart-indexing-service";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createSettingsService } from "./settings-service";
import { detectSystemLanguage } from "./system-language";
import {
	registerAccountIpcHandlers,
	registerActionsIpcHandlers,
	registerAnalyticsIpcHandlers,
	registerAppUpdateIpcHandlers,
	registerDragOutIpcHandlers,
	registerIndexActivityIpcHandlers,
	registerModelDownloadIpcHandlers,
	registerOnboardingIpcHandlers,
	registerOsRequestIpcHandlers,
	registerSearchIpcHandlers,
	registerServicesIpcHandlers,
	registerSmartIndexingIpcHandlers,
	registerSettingsIpcHandlers,
} from "./ipc";
import { createActionService } from "./action-service";
import { createServicesService } from "./services-service";
import { DEFAULT_SCAN_INTERVAL_MINUTES } from "./version-family-service";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { OS_REQUEST_CHANNELS, parseOsRequestArgv } from "../shared/os-request-contract";
import { listenForOsRequests, osRequestEndpoint, sendOsRequest } from "./os-request-channel";
import { createOsRequestService, diskKindOf } from "./os-request-service";
import { createOsMenuIntegration, menuLabels } from "./os-menu-integration";
import { installCli } from "./cli-install";
import { initErrorReporting, setErrorReportingEnabled } from "./error-reporting";
import { readErrorReportingEnabled } from "./error-report-core";
import { createAnalytics, createInstallIdStore, readUsageAnalyticsEnabled, resolveAnalyticsTarget, settingChangeEvents } from "./analytics-core";
import { createPostHogSink } from "./analytics";

const execFileAsync = promisify(execFile);

// Before `ready`, so a crash during startup is reported. The Settings toggle is read from disk because the settings service loads later.
initErrorReporting({ dsn: import.meta.env.MAIN_VITE_SENTRY_DSN, enabled: readErrorReportingEnabled(app.getPath("userData")), version: APP_VERSION, packaged: app.isPackaged });

/**
 * Usage statistics: opt-in, anonymous, content-free (see `analytics-core.ts`). Off until the user turns it on in
 * Settings, read from disk because the settings service loads later. A build with no PostHog key has no sink and sends nothing.
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

function createMainWindow(devLabel: DevLabel | null, appearance: AppAppearance, pending: boolean): BrowserWindow {
	const window = new BrowserWindow({
		// Onboarding uses the prototype's 1120×720 canvas; the Finder keeps its own size.
		...(pending
			? { width: 1120, height: 720, minWidth: 960, minHeight: 680, center: true }
			: { width: 1440, height: 900, minWidth: 1360, minHeight: 820 }),
		title: formatWindowTitle(APP_FULL_NAME, APP_VERSION, devLabel),
		// Windows and Linux take the window/taskbar icon here; macOS uses the bundle icon (the Dock icon below when unpackaged).
		...(process.platform === "darwin" ? {} : { icon: windowIconPath }),
		// v7: traffic lights overlay the sidebar header / toolbar (macOS-native chrome).
		titleBarStyle: "hiddenInset",
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/index.mjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
			additionalArguments: [
				...(devLabel === null ? [] : [`--autorag-dev-label=${JSON.stringify(devLabel)}`]),
				`--autorag-appearance=${appearance}`,
				...(pending ? [ONBOARDING_PENDING_FLAG] : []),
			],
		},
	});

	// The renderer's static <title> would otherwise replace the window title.
	window.webContents.on("page-title-updated", (event) => {
		event.preventDefault();
		window.setTitle(formatWindowTitle(APP_FULL_NAME, APP_VERSION, devLabel));
	});

	loadRendererPage(window, "index.html");
	attachQuickLook(window, {
		preload: join(import.meta.dirname, "../preload/quick-look.mjs"),
		appearance,
		language: currentLanguage,
		loadPage: (preview) => loadRendererPage(preview, "quick-look.html"),
		// Spawning osascript blocks the caller for the fork; the worker pays it.
		defaultApp: (path) => (fsWorker === null ? Promise.resolve(null) : fsWorker.client.call<string | null>("defaultApp", [path])),
	});
	return window;
}

let fsWorker: FsWorkerHost | null = null;
let providerAuthService: ProviderAuthService | null = null;
let mainWindow: BrowserWindow | null = null;
let currentAppearance: AppAppearance = "light";
let currentLanguage: AppSettings["language"] = "ko";
function sendToMainWindow(channel: string, payload: unknown): void {
	if (mainWindow === null || mainWindow.isDestroyed()) return;
	mainWindow.webContents.send(channel, payload);
}

function sendToAllWindows(channel: string, payload: unknown): void {
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) window.webContents.send(channel, payload);
	}
}

/** The `.app` bundle to drag into Full Disk Access: the packaged app, else the Electron bundle. */
function resolveAppBundlePath(): string {
	const marker = `${sep}Contents${sep}MacOS${sep}`;
	const executable = app.isPackaged ? app.getPath("exe") : process.execPath;
	const at = executable.indexOf(marker);
	return at >= 0 ? executable.slice(0, at) : executable;
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

/** Windows firewall/network gate: a plain request to a public 204 endpoint. */
async function checkNetworkReachability(): Promise<NetworkCheck> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 5000).unref();
	try {
		const response = await fetch("https://www.gstatic.com/generate_204", { signal: controller.signal });
		return { ok: response.ok || response.status === 204, error: response.ok || response.status === 204 ? null : `HTTP ${response.status}` };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Source probes log in to IMAP (himalaya) and walk app containers (telecrawl); run
 * together they were measured at 1-6s, so the default 5s deadline silently dropped
 * signed-in accounts. A hung probe still costs at most this long.
 */
const SOURCE_PROBE_TIMEOUT_MS = 15_000;

/** Runs one OS command with a deadline (5s by default); rejects with stderr (or the spawn error). */
function runCommand(command: string, args: readonly string[], timeoutMs = 5000): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	execFile(command, [...args], { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
		if (error !== null) {
			const detail = stderr.trim();
			reject(new Error(detail.length > 0 ? detail : error.message));
			return;
		}
		resolve(stdout);
	});
	return promise;
}

/**
 * Real system notification. `failed` is what macOS reports when this app has no
 * notification permission (UNErrorDomain 1 / "not allowed"), which is always the
 * case for the unsigned dev Electron binary and for a build the user denied, so it
 * is the signal to send the user to System Settings.
 */
function showSystemNotification(): Promise<boolean> {
	if (!Notification.isSupported()) return Promise.resolve(false);
	return new Promise<boolean>((resolve) => {
		const notification = new Notification({ title: APP_FULL_NAME, body: t("main.dialogs.notificationBody") });
		let settled = false;
		const done = (value: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => done(false), 5000);
		notification.on("show", () => done(true));
		notification.on("failed", () => done(false));
		try {
			notification.show();
		} catch {
			done(false);
		}
	});
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
	// Windows can redirect the known folders (OneDrive backup moves Desktop/Documents),
	// so Explorer's real paths come from Electron; on macOS they always live under $HOME.
	// A profile without a resolvable known folder (a throwaway USERPROFILE) makes
	// app.getPath throw; that must fall back to `<home>\<Folder>`, never abort startup.
	const knownFolder = (name: Parameters<typeof app.getPath>[0], fallback: string): string => {
		try {
			return app.getPath(name);
		} catch (error) {
			console.warn(`places: app.getPath("${name}") failed, using ${fallback}: ${error instanceof Error ? error.message : String(error)}`);
			return fallback;
		}
	};
	const home = app.getPath("home");
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
			...(knownFolders === undefined ? {} : { knownFolders }),
		},
		shell,
		clipboard,
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
	const searchService = createSearchService({
		agentFactory: createDefaultAgentFactory(),
		chatStore: createChatStore({ directory: join(app.getPath("userData"), "chat-history") }),
		send: sendToMainWindow,
		analytics,
	});
	registerSearchIpcHandlers(searchService);
	let previousSettings: AppSettings | null = null;
	const applyAppearance = (appearance: AppAppearance): void => {
		currentAppearance = appearance;
		nativeTheme.themeSource = appearance;
		sendToAllWindows(APPEARANCE_CHANNELS.changed, appearance);
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
			await execFileAsync(command, [...args]);
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
	const lockedDataSources = lockDataSources(dataSources, schedulePath);
	// One verdict for the whole process; a packaged app never honors the QA hardware override.
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
	const embeddingService = createEmbeddingSettingsService({
		env: process.env,
		cwd: process.cwd(),
		config: autoRagConfig,
		dataSources: lockedDataSources,
		localSpec,
		credentials,
		modelReady: () => modelDownload.status().state === "ready",
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
		refreshConfig: (methods) =>
			withRefreshLock(
				schedulePath.lock,
				"manual-refresh",
				() => journalSingleRun(createActivityJournal(schedulePath.activity, { owner: "manual-refresh" }), LOCAL_ITEM, () => refreshConfig(methods)),
				(holder) => ({ ok: false, methods: methods ?? LOCAL_REFRESH_METHODS, scanned: 0, written: 0, deleted: 0, skipped: 0, diagnostics: [], error: busyMessage(holder) }),
			),
		refreshScheduler,
		credentials,
		providers: providerAuth,
		embedding: embeddingService,
		mcp: createMcpSettingsService({ agentDir: () => getAgentDir() }),
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
			setErrorReportingEnabled(settings.errorReporting);
			applyAppearance(settings.appearance);
			applyLanguage(settings.language);
			applyScanInterval(settings.dupeyScanIntervalMinutes);
			if (appliedLaunchAtLogin !== settings.launchAtLogin) {
				appliedLaunchAtLogin = settings.launchAtLogin;
				applyLoginItem(settings.launchAtLogin);
			}
			void appUpdater?.applySettings();
		},
	});
	registerSettingsIpcHandlers(settingsService);
	registerAnalyticsIpcHandlers(analytics);
	void settingsService.get().then((settings) => {
		previousSettings ??= settings;
	});
	analytics.track("app_opened", {});
	const indexActivity = createIndexActivityService({
		configPath: autoragConfigPath,
		resolveWorkspacePath: async () => (await resolveEffectiveConfig({ env: process.env, cwd: process.cwd() })).config.workspacePath,
		journalPath: () => schedulePath.activity,
		// The fs worker runs the checkbox-toggle refresh, so its pid marks that run as this app's own.
		ownPids: () => [workerHost.status().pid],
	});
	registerIndexActivityIpcHandlers(indexActivity);
	const stopIndexActivity = indexActivity.start((snapshot) => {
		sendToMainWindow(INDEX_ACTIVITY_CHANNELS.changed, snapshot);
	});
	app.once("will-quit", stopIndexActivity);
	registerOsRequestIpcHandlers(osRequests);
	// The in-app right-click → 서비스 submenu: what macOS offers for the selection, and performing one.
	registerServicesIpcHandlers(createServicesService());
	const settings = await settingsService.get();
	appliedLaunchAtLogin = settings.launchAtLogin;
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
	const scanCoordinator = createFolderScanCoordinator({
		options: { supportedExtensions, maxSourceBytes: DEFAULT_MAX_SOURCE_BYTES },
		...(process.platform === "darwin" ? { listDatalessPaths: listMacDatalessPaths } : {}),
		emit: (scan) => sendToMainWindow(ONBOARDING_CHANNELS.scanProgress, scan),
	});
	registerSmartIndexingIpcHandlers(
		createSmartIndexingService({
			send: (event) => sendToMainWindow(SMART_INDEXING_CHANNELS.event, event),
			resolveModel: () => resolveConfiguredSessionModel(process.env, process.cwd(), getAgentDir()),
			agentDir: getAgentDir(),
			env: process.env,
			language: () => currentLanguage,
			scanOptions: { supportedExtensions, maxSourceBytes: DEFAULT_MAX_SOURCE_BYTES },
		}),
	);
	const accountService = createAccountService({
		env: process.env,
		credentials,
		cachePath: join(app.getPath("userData"), "account.json"),
		configPath: autoragConfigPath(),
		openExternal: (url) => shell.openExternal(url),
		send: sendToMainWindow,
		// The picker lists the plan's models from the runtime's persisted catalog.
		onSignedIn: () => providerAuth.syncAutoragCatalog(),
	});
	registerAccountIpcHandlers(accountService);
	void accountService.refresh().catch(() => undefined);
	app.once("will-quit", () => void accountService.dispose());

	const onboardingService: OnboardingService = createOnboardingService({
		userDataDir,
		env: process.env,
		cwd: process.cwd(),
		platform: process.platform,
		home,
		knownFolders: {
			desktop: knownFolder("desktop", join(home, "Desktop")),
			documents: knownFolder("documents", join(home, "Documents")),
			downloads: knownFolder("downloads", join(home, "Downloads")),
			pictures: knownFolder("pictures", join(home, "Pictures")),
		},
		iCloudDrivePath:
			process.platform === "darwin" ? join(home, "Library", "Mobile Documents", "com~apple~CloudDocs") : null,
		cloudDrives: async () => {
			if (process.platform === "darwin") {
				const root = join(home, "Library", "CloudStorage");
				const names = await readdir(root).catch(() => [] as string[]);
				// File Provider folders are `<Provider>-<account>`; accounts may contain `-`.
				return names
					.filter((name) => !name.startsWith("."))
					.map((name) => {
						const dash = name.indexOf("-");
						return { path: join(root, name), name: dash < 0 ? name : `${name.slice(0, dash)} · ${name.slice(dash + 1)}` };
					});
			}
			if (process.platform === "win32") {
				const locations = await workerHost.client.call<readonly { readonly section: string; readonly available: boolean; readonly path: string; readonly name: string }[]>("locations");
				return locations
					.filter((location) => location.section === "cloud" && location.available)
					.map((location) => ({ path: location.path, name: location.name }));
			}
			return [];
		},
		localSpec,
		ocrEnabled: async () => {
			try {
				const raw = readRawConfigObject(autoragConfigPath());
				const parserOptions = isJsonObject(raw.parserOptions) ? raw.parserOptions : {};
				const ocr = isJsonObject(parserOptions.ocr) ? parserOptions.ocr : {};
				return ocr.enabled === true;
			} catch {
				return false;
			}
		},
		configPath: autoragConfigPath(),
		resolveWorkspacePath: async () => (await resolveEffectiveConfig({ env: process.env, cwd: process.cwd() })).config.workspacePath,
		ensureLocalModel: async () => {
			await modelDownload.start();
			const done = await modelDownload.settled();
			return done.state === "ready" ? null : (done.error ?? t("main.modelDownload.errors.cancelled"));
		},
		refresh: (methods) =>
			withRefreshLock(
				schedulePath.lock,
				"onboarding-index",
				() => journalSingleRun(createActivityJournal(schedulePath.activity, { owner: "onboarding-index" }), LOCAL_ITEM, () => refreshConfig(methods)),
				(holder) => ({ ok: false, methods: methods ?? LOCAL_REFRESH_METHODS, scanned: 0, written: 0, deleted: 0, skipped: 0, diagnostics: [], error: busyMessage(holder) }),
			),
		syncDatasources: async (aliases) => {
			if (aliases.length === 0) return;
			for (;;) {
				const ran = await withRefreshLock(
					schedulePath.lock,
					"onboarding-datasources",
					async () => {
						const journal = createActivityJournal(schedulePath.activity, { owner: "onboarding-datasources" });
						journal.begin(aliases.map(sourceItem));
						try {
							for (const alias of aliases) {
								journal.start(sourceItem(alias).key);
								try {
									const result = await dataSources.sync(alias);
									journal.finish(sourceItem(alias).key, result.ok, result.error);
								} catch (error) {
									journal.finish(sourceItem(alias).key, false, error instanceof Error ? error.message : String(error));
								}
							}
						} finally {
							journal.end();
						}
						return true;
					},
					() => false,
				);
				if (ran) return;
				const wait = Promise.withResolvers<void>();
				setTimeout(wait.resolve, 1_000);
				await wait.promise;
			}
		},
		credentials,
		settings: settingsService,
		detectSources: (onFound) =>
			detectSources(
				{
					platform: process.platform,
					home,
					env: process.env,
					run: (command, args) => runCommand(command, args, SOURCE_PROBE_TIMEOUT_MS),
					pathExists,
					readDirNames: (path) => readdir(path).catch(() => [] as string[]),
					readFileText: (path) => readFile(path, "utf8"),
				},
				onFound,
			),
		useManagedModel: () => accountService.useManagedModel(),
		gitToken: async () => {
			try {
				const token = (await runCommand("gh", ["auth", "token"])).trim();
				return token.length > 0 ? token : null;
			} catch {
				return null;
			}
		},
		detectModels: () =>
			detectModelProviders({ env: process.env, credentials, fetchFn: fetch, modelsCatalog: () => autoRagConfig.modelsCatalog() }),
		verifyModel: (request) =>
			verifyModelRequest(
				{ env: process.env, credentials, fetchFn: fetch, modelsCatalog: () => autoRagConfig.modelsCatalog() },
				request,
			),
		send: sendToMainWindow,
		openExternal: (url) => shell.openExternal(url),
		relaunch: () => {
			app.relaunch();
			app.exit(0);
		},
		appBundlePath: resolveAppBundlePath,
		startDrag: (path) => {
			const target = mainWindow;
			if (target === null || target.isDestroyed()) return;
			void app.getFileIcon(path).then(
				(icon) => {
					if (target.isDestroyed()) return;
					const image = icon.isEmpty() ? nativeImage.createFromBitmap(Buffer.alloc(4), { width: 1, height: 1 }) : icon;
					target.webContents.startDrag({ file: path, icon: image });
				},
				() => undefined,
			);
		},
		pickFolders: async () => {
			const options: OpenDialogOptions = {
				title: t("main.dialogs.chooseFolderTitle"),
				buttonLabel: t("main.dialogs.addButton"),
				properties: ["openDirectory", "multiSelections", "createDirectory"],
			};
			const result = mainWindow === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(mainWindow, options);
			return result.canceled ? [] : result.filePaths;
		},
		showNotification: showSystemNotification,
		notificationsSupported: () => Notification.isSupported(),
		loginItemApplied,
		startPowerSaveBlocker: () => powerSaveBlocker.start("prevent-app-suspension"),
		stopPowerSaveBlocker: (id) => powerSaveBlocker.stop(id),
		probeFullDiskAccess: () => probeFullDiskAccess(home),
		checkNetwork: checkNetworkReachability,
		startScans: (paths) => scanCoordinator.start(paths),
		folderTotals: (paths) => scanCoordinator.totalFiles(paths),
		onComplete: () => {
			analytics.track("onboarding_completed", {});
			const window = mainWindow;
			if (window === null || window.isDestroyed()) return;
			// Centering can move a border-spanning window onto another display.
			// Apply the target size both before and after centering so the Finder
			// hand-off uses the display where the window actually ended up.
			const resizeToWorkArea = (): void => {
				const work = screen.getDisplayMatching(window.getBounds()).workAreaSize;
				window.setMinimumSize(Math.min(1360, work.width), Math.min(820, work.height));
				window.setSize(Math.min(1440, work.width), Math.min(900, work.height));
			};
			resizeToWorkArea();
			window.center();
			resizeToWorkArea();
			window.center();
		},
	});
	registerOnboardingIpcHandlers(onboardingService);
	const openMainWindow = (): BrowserWindow => {
		const window = createMainWindow(devLabel, currentAppearance, onboardingService.pending());
		const clearWatchSet = (): void => {
			void workerHost.client.call("setWatchSet", [[]]);
		};
		window.webContents.on("render-process-gone", clearWatchSet);
		window.webContents.on("destroyed", clearWatchSet);
		window.on("close", (event) => {
			if (!onboardingService.pending() || !onboardingService.isIndexing()) return;
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
		});
		return window;
	};
	mainWindow = openMainWindow();
	app.on("activate", () => {
		if (mainWindow === null || mainWindow.isDestroyed()) {
			mainWindow = openMainWindow();
		}
	});
	// Menu requests: queue the cold-start request, then serve the ones the running app receives.
	onOsRequestQueued = () => {
		if (mainWindow === null || mainWindow.isDestroyed()) {
			mainWindow = openMainWindow();
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
		void Promise.all([stopEmbeddingDaemon().then(() => terminateMinSyncChildren()), workerHost.dispose(), analytics.shutdown()])
			.catch((error: unknown) => console.error("[fs-worker] dispose on quit failed:", error))
			.finally(() => app.exit(0));
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

