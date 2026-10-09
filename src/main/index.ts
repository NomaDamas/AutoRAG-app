import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, nativeTheme, protocol, safeStorage, ShareMenu, shell, type OpenDialogOptions } from "electron";
import { APPEARANCE_CHANNELS } from "../shared/appearance-contract";
import type { AppAppearance } from "../shared/settings-contract";
import { attachQuickLook, PREVIEW_PRIVILEGED_SCHEME, registerPreviewProtocol, registerQuickLookIpc } from "../preview/node/register";
import { writeDefaultConfig } from "@autorag/librarian";
import { readRawConfigObject, resolveConfigPath, writeConfigObject } from "@autorag/librarian/core";
import { LOCAL_REFRESH_METHODS, refreshAutoragIndex } from "./refresh-runner";
import type { RefreshLockHolder } from "./refresh-lock";
import { schedulePaths, withRefreshLock } from "./refresh-schedule";
import { createRefreshScheduler } from "./refresh-scheduler";
import { DEFAULT_CODE_FOLDER_NAMES, isJsonObject } from "../shared/settings-contract";
import { createIconProvider } from "./file-icon";
import { registerIconProtocol, THUMB_PRIVILEGED_SCHEME } from "./icon-register";
import { FS_CHANNELS } from "../shared/fs-contract";
import { SETTINGS_CHANNELS } from "../shared/settings-contract";
import { DUPEY_LAYER_ID, LIVE_CHANNELS } from "../shared/live-contract";
import { APP_NAME, APP_VERSION, formatWindowTitle, type DevLabel } from "../shared/app-info";
import { createChatStore } from "./chat-store";
import { createDataSourceStatusService } from "./datasource-status";
import { createEmbeddingSettingsService, type EmbeddingSettingsRuntime } from "./embedding-settings-service";
import { createIndexStatusService } from "./index-status";
import { readDevLabel, resolveClonePath } from "./dev-label";
import { buildFsEntry } from "./fs-entry";
import { createFileNameSearch } from "./file-name-search";
import { createFsService } from "./fs-service";
import { createPlaces } from "./places";
import { createRecentsStore } from "./recents-store";
import { createAutoRagConfigService } from "./autorag-config-service";
import { createModelStatusService } from "./model-status";
import { createProviderAuthService, type ProviderAuthService } from "./provider-auth-service";
import { createProviderCredentialService } from "./provider-credentials";
import { createDefaultAgentFactory, createSearchService } from "./search-service";
import { createSettingsService } from "./settings-service";
import {
	registerActionsIpcHandlers,
	registerDragOutIpcHandlers,
	registerFsIpcHandlers,
	registerIndexIpcHandlers,
	registerLiveIpcHandlers,
	registerSearchIpcHandlers,
	registerSettingsIpcHandlers,
	registerVersionFamilyIpcHandlers,
} from "./ipc";
import { createActionService } from "./action-service";
import { createChangeHub } from "./change-hub";
import { createDupeyLayer } from "./dupey-layer";
import { createFsWatchService } from "./fs-watch-service";
import { createParcelWatchBackend } from "./watch-backend";
import { createVersionFamilyService, DEFAULT_SCAN_INTERVAL_MINUTES, type VersionFamilyService } from "./version-family-service";
import { createFileVersionFamilyStore } from "./version-family-store";

/** Longest a quit waits for the folder watches to release before exiting anyway. */
const QUIT_WATCH_RELEASE_MS = 2000;

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
			appIndexing: { excludeCodeFolders: true, excludeDotFolders: true, codeFolderNames: [...DEFAULT_CODE_FOLDER_NAMES] },
		});
	} catch (error) {
		console.error("AutoRAG appIndexing metadata initialization failed", error);
	}
}

function ensureAutoRAGConfig(): void {
	const configPath = autoragConfigPath();
	if (existsSync(configPath)) {
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

function createMainWindow(devLabel: DevLabel | null, appearance: AppAppearance): BrowserWindow {
	const window = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 1360,
		minHeight: 820,
		title: formatWindowTitle(APP_NAME, APP_VERSION, devLabel),
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
			],
		},
	});

	// The renderer's static <title> would otherwise replace the window title.
	window.webContents.on("page-title-updated", (event) => {
		event.preventDefault();
		window.setTitle(formatWindowTitle(APP_NAME, APP_VERSION, devLabel));
	});

	loadRendererPage(window, "index.html");
	attachQuickLook(window, {
		preload: join(import.meta.dirname, "../preload/quick-look.mjs"),
		appearance,
		loadPage: (preview) => loadRendererPage(preview, "quick-look.html"),
	});
	return window;
}

let versionFamilyService: VersionFamilyService | null = null;
let providerAuthService: ProviderAuthService | null = null;
let mainWindow: BrowserWindow | null = null;
let currentAppearance: AppAppearance = "light";
function sendToMainWindow(channel: string, payload: unknown): void {
	if (mainWindow === null || mainWindow.isDestroyed()) return;
	mainWindow.webContents.send(channel, payload);
}

function sendAppearance(appearance: AppAppearance): void {
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) window.webContents.send(APPEARANCE_CHANNELS.changed, appearance);
	}
}

/** Last value handed to the OS, so a settings read that did not change it never re-registers. */
let launchAtLoginApplied: boolean | null = null;
/** Mirror the general setting onto the OS login item (macOS/Windows own this; Linux ignores it). */
function applyLaunchAtLogin(launchAtLogin: boolean): void {
	if (process.platform !== "darwin" && process.platform !== "win32") return;
	if (launchAtLoginApplied === launchAtLogin) return;
	launchAtLoginApplied = launchAtLogin;
	app.setLoginItemSettings({ openAtLogin: launchAtLogin });
}

// Electron keeps only the last `registerSchemesAsPrivileged` call: every scheme registers here, together.
protocol.registerSchemesAsPrivileged([PREVIEW_PRIVILEGED_SCHEME, THUMB_PRIVILEGED_SCHEME]);

app.whenReady().then(async () => {
	nativeTheme.on("updated", () => {
		sendAppearance(nativeTheme.shouldUseDarkColors ? "dark" : "light");
	});
	registerPreviewProtocol();
	const iconProvider = createIconProvider();
	registerIconProtocol(iconProvider);
	registerQuickLookIpc();
	ensureAutoRAGConfig();
	const devLabel = resolveDevLabel();
	console.log(`[autorag] ${formatWindowTitle(APP_NAME, APP_VERSION, devLabel)}`);
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
	const places = createPlaces(
		process.platform === "win32"
			? {
					knownFolders: {
						desktop: knownFolder("desktop", join(home, "Desktop")),
						documents: knownFolder("documents", join(home, "Documents")),
						downloads: knownFolder("downloads", join(home, "Downloads")),
						music: knownFolder("music", join(home, "Music")),
						videos: knownFolder("videos", join(home, "Videos")),
						pictures: knownFolder("pictures", join(home, "Pictures")),
					},
				}
			: {},
	);
	// Filename search rides the platform index (fsearch / Everything); the
	// disk walk stays as the fallback when no index answers.
	const fileNameSearch = createFileNameSearch({
		userDataDir: app.getPath("userData"),
		locations: () => fsService.locations(),
	});
	const fsService = createFsService({
		shell,
		clipboard,
		icons: iconProvider,
		places,
		fileNameSearch,
		recents: createRecentsStore({ directory: join(app.getPath("userData"), "recents") }),
		...(qaRoot !== "" && isAbsolute(qaRoot) ? { qaRoot } : {}),
	});
	// A volume mounting or a cloud account connecting re-renders the sidebar.
	const stopPlacesWatch = places.watch(() => sendToMainWindow(FS_CHANNELS.locationsChanged, null));
	app.once("will-quit", stopPlacesWatch);
	// Both delete surfaces (context menu, ⌘⌫) land on this channel, so the
	// version-family snapshot learns about the Trash here.
	registerFsIpcHandlers(fsService, {
		onTrashed: async (paths) => {
			await versionFamilyService?.removePaths(paths);
		},
	});
	// Row drag-out: the renderer hands the gesture to the OS as real files.
	registerDragOutIpcHandlers();
	// Inspector actions: a chooser for "Open with" and the macOS share sheet,
	// anchored to the button that opened it.
	registerActionsIpcHandlers(
		createActionService({
			applications: {
				async pick(window) {
					const options: OpenDialogOptions = {
						title: "다른 앱으로 열기",
						buttonLabel: "열기",
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
			share:
				process.platform === "darwin"
					? {
							present(path, anchor, window) {
								if (window === null) return;
								new ShareMenu({ filePaths: [path] }).popup({
									window,
									x: Math.round(anchor.x),
									y: Math.round(anchor.y + anchor.height + 4),
								});
							},
						}
					: null,
		}),
	);
	let scanIntervalMinutes = DEFAULT_SCAN_INTERVAL_MINUTES;
	const hub = createChangeHub({
		send: (message) => sendToMainWindow(LIVE_CHANNELS.message, message),
	});
	versionFamilyService = createVersionFamilyService({
		locations: () => fsService.locations(),
		store: createFileVersionFamilyStore(join(app.getPath("userData"), "dupey-cache")),
		buildEntry: buildFsEntry,
		intervalMinutes: () => scanIntervalMinutes,
		onChanged: () => hub.publish(DUPEY_LAYER_ID),
	});
	hub.register(createDupeyLayer(versionFamilyService));
	const watch = createFsWatchService({
		backend: createParcelWatchBackend(),
		onBatch: (batch) => hub.ingest(batch),
	});
	registerLiveIpcHandlers(watch, hub);
	registerVersionFamilyIpcHandlers(versionFamilyService);
	registerIndexIpcHandlers(
		createIndexStatusService({
			env: process.env,
			cwd: process.cwd(),
			onRefreshed: (error) => sendToMainWindow(FS_CHANNELS.indexRefreshed, error),
		}),
	);
	const searchService = createSearchService({
		agentFactory: createDefaultAgentFactory(),
		chatStore: createChatStore({ directory: join(app.getPath("userData"), "chat-history") }),
		send: sendToMainWindow,
	});
	registerSearchIpcHandlers(searchService);
	const applyAppearance = (appearance: AppAppearance): void => {
		currentAppearance = appearance;
		nativeTheme.themeSource = appearance;
		sendAppearance(appearance);
	};
	// Stored provider keys reach process.env before any agent resolves, so the
	// LLM/embedding/reranker all see the same credential.
	const credentials = createProviderCredentialService({
		filePath: join(app.getPath("userData"), "credentials.enc.json"),
		safeStorage,
		env: process.env,
	});
	credentials.load();
	const providerAuth = createProviderAuthService({
		send: (event) => sendToMainWindow(SETTINGS_CHANNELS.providerLoginEvent, event),
		env: process.env,
		credentials,
	});
	providerAuthService = providerAuth;
	// auth.json-stored OpenRouter/Vercel keys reach process.env so the env-driven
	// Jev/rerank backends resolve the same credential.
	void providerAuth.warmEnv();
	const configService = createAutoRagConfigService({ env: process.env, cwd: process.cwd() });
	// The datasource service hands its discrawl skill the embedding service's
	// current loopback runtime; the embedding service needs the datasource service
	// for adoption planning, so the holder is filled right after.
	let embeddingSettings: EmbeddingSettingsRuntime | null = null;
	const dataSources = createDataSourceStatusService({
		env: process.env,
		cwd: process.cwd(),
		discrawlEmbeddingRuntime: () => embeddingSettings?.discrawlRuntime(),
	});
	const embeddingService = createEmbeddingSettingsService({
		env: process.env,
		cwd: process.cwd(),
		config: configService,
		dataSources,
	});
	embeddingSettings = embeddingService;
	// A persisted local-server embedder points mailcrawl at the app's ephemeral
	// adapter port; refresh re-probes and rewrites it before any agent runs.
	await embeddingService.refresh();
	embeddingService.applyProcessEnv();
	app.once("will-quit", () => {
		void embeddingService.dispose();
	});
	const schedulePath = schedulePaths(autoragConfigPath());
	const refreshScheduler = createRefreshScheduler({
		platform: process.platform,
		execPath: process.execPath,
		jobPath: join(import.meta.dirname, "refresh-job.js"),
		configPath: autoragConfigPath,
	});
	// A manual refresh or sync takes the same lock as the scheduled job, so the two never run at once.
	const busyMessage = (holder: RefreshLockHolder): string =>
		holder.owner === "scheduled-job" ? "백그라운드 새로 고침이 실행 중입니다. 끝난 뒤 다시 시도하세요." : "다른 새로 고침이 실행 중입니다. 끝난 뒤 다시 시도하세요.";
	const lockedDataSources: typeof dataSources = {
		...dataSources,
		sync: (id) =>
			withRefreshLock(
				schedulePath.lock,
				"manual-sync",
				() => dataSources.sync(id),
				(holder) => ({ id, ok: false, state: "failed", chunkCount: null, indexedAt: null, durationMs: 0, diagnostics: [], error: busyMessage(holder) }),
			),
	};
	const settingsService = createSettingsService({
		directory: join(app.getPath("userData"), "settings"),
		dataSources: lockedDataSources,
		models: createModelStatusService({ env: process.env, cwd: process.cwd() }),
		config: configService,
		refreshConfig: (methods) =>
			withRefreshLock(
				schedulePath.lock,
				"manual-refresh",
				() => refreshAutoragIndex(methods),
				(holder) => ({ ok: false, methods: methods ?? LOCAL_REFRESH_METHODS, scanned: 0, written: 0, deleted: 0, skipped: 0, diagnostics: [], error: busyMessage(holder) }),
			),
		refreshScheduler,
		credentials,
		providers: providerAuth,
		embedding: embeddingService,
		onSettingsChanged: (settings) => {
			applyAppearance(settings.appearance);
			scanIntervalMinutes = settings.dupeyScanIntervalMinutes;
			versionFamilyService?.reschedule();
			applyLaunchAtLogin(settings.launchAtLogin);
		},
	});
	registerSettingsIpcHandlers(settingsService);
	const settings = await settingsService.get();
	applyAppearance(settings.appearance);
	scanIntervalMinutes = settings.dupeyScanIntervalMinutes;
	versionFamilyService?.reschedule();
	applyLaunchAtLogin(settings.launchAtLogin);
	void versionFamilyService.start();
	// Re-time or remove an OS refresh job the user already enabled. Installing one is only ever the result of the user choosing a cadence.
	void refreshScheduler
		.status()
		.then((status) => (status.installed ? refreshScheduler.reconcile() : status))
		.then((status) => {
			if (status.error !== null) console.error("AutoRAG background refresh scheduling failed", status.error);
		});
	// Warm the file-name index daemon (fsearch watch / Everything) so the first
	// search never pays the database cold-load. It is deliberately left running
	// across quits: restarting a watch over a whole-machine index re-scans every
	// monitored folder, which is exactly the cost this keep-alive avoids.
	void fileNameSearch.ensureDaemon();
	const openMainWindow = (): BrowserWindow => {
		const window = createMainWindow(devLabel, currentAppearance);
		const clearWatchSet = (): void => {
			void watch.setWatchSet([]);
		};
		window.webContents.on("render-process-gone", clearWatchSet);
		window.webContents.on("destroyed", clearWatchSet);
		return window;
	};
	mainWindow = openMainWindow();
	app.on("activate", () => {
		if (mainWindow === null || mainWindow.isDestroyed()) {
			mainWindow = openMainWindow();
		}
	});
	// The native watcher must finish unsubscribing before Node tears its
	// environment down: an unsubscribe still completing inside
	// `FreeEnvironment` throws into a dying env and aborts the process
	// (`napi_fatal_error`, "Electron quit unexpectedly"). Hold the quit until
	// the watches are gone, bounded so a stuck watcher never blocks quitting.
	// Every other `will-quit` listener has already run and the windows are
	// closed by now, so the quit finishes with `app.exit` — re-entering
	// `app.quit()` from inside its own quit can stall the teardown.
	app.once("will-quit", (event) => {
		event.preventDefault();
		const bound = new Promise<void>((resolve) => setTimeout(resolve, QUIT_WATCH_RELEASE_MS).unref());
		void Promise.race([watch.dispose(), bound])
			.catch((error: unknown) => console.error("[fs-watch] dispose on quit failed:", error))
			.finally(() => app.exit(0));
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

app.on("will-quit", () => {
	versionFamilyService?.stop();
	void providerAuthService?.dispose();
});
