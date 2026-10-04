import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, nativeTheme, protocol, ShareMenu, shell, type OpenDialogOptions } from "electron";
import { APPEARANCE_CHANNELS } from "../shared/appearance-contract";
import type { AppAppearance } from "../shared/settings-contract";
import { attachQuickLook, PREVIEW_PRIVILEGED_SCHEME, registerPreviewProtocol, registerQuickLookIpc } from "../preview/node/register";
import { writeDefaultConfig } from "@autorag/librarian";
import { resolveConfigPath } from "@autorag/librarian/core";
import { createIconProvider } from "./file-icon";
import { registerIconProtocol, THUMB_PRIVILEGED_SCHEME } from "./icon-register";
import { FS_CHANNELS } from "../shared/fs-contract";
import { DUPEY_LAYER_ID, LIVE_CHANNELS } from "../shared/live-contract";
import { APP_NAME, APP_VERSION, formatWindowTitle, type DevLabel } from "../shared/app-info";
import { createChatStore } from "./chat-store";
import { createDataSourceStatusService } from "./datasource-status";
import { createIndexStatusService } from "./index-status";
import { readDevLabel, resolveClonePath } from "./dev-label";
import { buildFsEntry } from "./fs-entry";
import { createFsService } from "./fs-service";
import { createPlaces } from "./places";
import { createRecentsStore } from "./recents-store";
import { createModelStatusService } from "./model-status";
import { createDefaultAgentFactory, createSearchService } from "./search-service";
import { createSettingsService } from "./settings-service";
import {
	registerActionsIpcHandlers,
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

/** The one AutoRAG config every surface (CLI, TUI, serve, this app) resolves. */
function autoragConfigPath(): string {
	return resolveConfigPath({ flags: {}, env: process.env, cwd: process.cwd() }).configPath;
}

function ensureAutoRAGConfig(): void {
	const configPath = autoragConfigPath();
	if (existsSync(configPath)) return;
	try {
		writeDefaultConfig(
			configPath,
			{ searchPaths: [process.cwd()], workspacePath: process.cwd() },
			{ atomicCreate: true, cwd: process.cwd(), env: process.env },
		);
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
	const places = createPlaces(
		process.platform === "win32"
			? {
					knownFolders: {
						desktop: app.getPath("desktop"),
						documents: app.getPath("documents"),
						downloads: app.getPath("downloads"),
						music: app.getPath("music"),
						videos: app.getPath("videos"),
						pictures: app.getPath("pictures"),
					},
				}
			: {},
	);
	const fsService = createFsService({
		shell,
		clipboard,
		icons: iconProvider,
		places,
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
	const settingsService = createSettingsService({
		directory: join(app.getPath("userData"), "settings"),
		dataSources: createDataSourceStatusService({ env: process.env, cwd: process.cwd() }),
		models: createModelStatusService({ env: process.env, cwd: process.cwd() }),
		onSettingsChanged: (settings) => {
			applyAppearance(settings.appearance);
			scanIntervalMinutes = settings.dupeyScanIntervalMinutes;
			versionFamilyService?.reschedule();
		},
	});
	registerSettingsIpcHandlers(settingsService);
	const settings = await settingsService.get();
	applyAppearance(settings.appearance);
	scanIntervalMinutes = settings.dupeyScanIntervalMinutes;
	versionFamilyService?.reschedule();
	void versionFamilyService.start();
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
	app.once("will-quit", () => {
		void watch.dispose();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

app.on("will-quit", () => {
	versionFamilyService?.stop();
});
