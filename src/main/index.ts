import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { app, BrowserWindow, clipboard, shell } from "electron";
import { attachQuickLook, registerPreviewProtocol, registerPreviewSchemes, registerQuickLookIpc } from "../preview/node/register";
import { writeDefaultConfig } from "@autorag/librarian";
import { resolveConfigPath } from "@autorag/librarian/core";
import { createIconProvider } from "./file-icon";
import { registerIconProtocol, registerIconSchemes } from "./icon-register";
import { FS_CHANNELS } from "../shared/fs-contract";
import { DUPEY_LAYER_ID, LIVE_CHANNELS } from "../shared/live-contract";
import { APP_NAME, APP_VERSION, formatWindowTitle, type DevLabel } from "../shared/app-info";
import { createChatStore } from "./chat-store";
import { createDataSourceStatusService } from "./datasource-status";
import { createIndexStatusService } from "./index-status";
import { readDevLabel, resolveClonePath } from "./dev-label";
import { buildFsEntry } from "./fs-entry";
import { createFsService } from "./fs-service";
import { createRecentsStore } from "./recents-store";
import { createModelStatusService } from "./model-status";
import { createDefaultAgentFactory, createSearchService } from "./search-service";
import { createSettingsService } from "./settings-service";
import {
	registerFsIpcHandlers,
	registerIndexIpcHandlers,
	registerLiveIpcHandlers,
	registerSearchIpcHandlers,
	registerSettingsIpcHandlers,
	registerVersionFamilyIpcHandlers,
} from "./ipc";
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

function createMainWindow(devLabel: DevLabel | null): BrowserWindow {
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
			additionalArguments: devLabel === null ? [] : [`--autorag-dev-label=${JSON.stringify(devLabel)}`],
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
		loadPage: (preview) => loadRendererPage(preview, "quick-look.html"),
	});
	return window;
}

let versionFamilyService: VersionFamilyService | null = null;
let mainWindow: BrowserWindow | null = null;

function sendToMainWindow(channel: string, payload: unknown): void {
	if (mainWindow === null || mainWindow.isDestroyed()) return;
	mainWindow.webContents.send(channel, payload);
}

registerPreviewSchemes();
registerIconSchemes();

app.whenReady().then(() => {
	registerPreviewProtocol();
	const iconProvider = createIconProvider();
	registerIconProtocol(iconProvider);
	registerQuickLookIpc();
	ensureAutoRAGConfig();
	const devLabel = resolveDevLabel();
	console.log(`[autorag] ${formatWindowTitle(APP_NAME, APP_VERSION, devLabel)}`);
	const qaRoot = process.env.AUTORAG_QA_ROOT?.trim() ?? "";
	const fsService = createFsService({
		shell,
		clipboard,
		icons: iconProvider,
		recents: createRecentsStore({ directory: join(app.getPath("userData"), "recents") }),
		...(qaRoot !== "" && isAbsolute(qaRoot) ? { qaRoot } : {}),
	});
	// Both delete surfaces (context menu, ⌘⌫) land on this channel, so the
	// version-family snapshot learns about the Trash here.
	registerFsIpcHandlers(fsService, {
		onTrashed: async (paths) => {
			await versionFamilyService?.removePaths(paths);
		},
	});
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
	const agentFactory = createDefaultAgentFactory();
	const settingsService = createSettingsService({
		directory: join(app.getPath("userData"), "settings"),
		dataSources: createDataSourceStatusService({ env: process.env, cwd: process.cwd() }),
		models: createModelStatusService({ env: process.env, cwd: process.cwd() }),
		createChatSession: (surface) => {
			const agent = agentFactory();
			if (agent.createChatSession === undefined) {
				throw new Error("AutoRAG chat sessions are unavailable");
			}
			return agent.createChatSession({
				systemPrompt: `You are AutoRAG Settings Assistant for the ${surface} surface. Explain and configure the existing AutoRAG application using its actual settings and data sources. Never invent unavailable state.`,
			});
		},
		onSettingsChanged: (settings) => {
			scanIntervalMinutes = settings.dupeyScanIntervalMinutes;
			versionFamilyService?.reschedule();
		},
		send: sendToMainWindow,
	});
	registerSettingsIpcHandlers(settingsService);
	void settingsService.get().then((settings) => {
		scanIntervalMinutes = settings.dupeyScanIntervalMinutes;
		versionFamilyService?.reschedule();
	});
	void versionFamilyService.start();
	const openMainWindow = (): BrowserWindow => {
		const window = createMainWindow(devLabel);
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
