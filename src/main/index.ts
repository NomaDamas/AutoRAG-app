import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, protocol, safeStorage, ShareMenu, shell, type OpenDialogOptions } from "electron";
import { APPEARANCE_CHANNELS } from "../shared/appearance-contract";
import type { AppAppearance, ConfigRefreshDiagnostic, ConfigRefreshResult } from "../shared/settings-contract";
import { attachQuickLook, PREVIEW_PRIVILEGED_SCHEME, registerPreviewProtocol, registerQuickLookIpc } from "../preview/node/register";
import { AutoRAGLite, writeDefaultConfig, type RefreshMethod } from "@autorag/librarian";
import { readRawConfigObject, resolveConfigPath, resolveConfigReadOnly, writeConfigObject } from "@autorag/librarian/core";
import { APP_INDEXING_CAPABILITIES, applyAppIndexing, DEFAULT_CODE_FOLDER_NAMES, readAppIndexing } from "./app-indexing";
import { isJsonObject } from "../shared/settings-contract";
import { createIconProvider } from "./file-icon";
import { registerIconProtocol, THUMB_PRIVILEGED_SCHEME } from "./icon-register";
import type { KnownFolders } from "../shared/fs-worker-contract";
import { APP_NAME, APP_VERSION, formatWindowTitle, type DevLabel } from "../shared/app-info";
import { createChatStore } from "./chat-store";
import { createDataSourceStatusService } from "./datasource-status";
import { readDevLabel, resolveClonePath } from "./dev-label";
import { createFsWorkerHost, registerFsWorkerIpc, type FsWorkerHost } from "./fs-worker-host";
import { createAutoRagConfigService } from "./autorag-config-service";
import { createModelStatusService } from "./model-status";
import { createProviderCredentialService } from "./provider-credentials";
import { createDefaultAgentFactory, createSearchService } from "./search-service";
import { createSettingsService } from "./settings-service";
import {
	registerActionsIpcHandlers,
	registerDragOutIpcHandlers,
	registerSearchIpcHandlers,
	registerSettingsIpcHandlers,
} from "./ipc";
import { createActionService } from "./action-service";
import { DEFAULT_SCAN_INTERVAL_MINUTES } from "./version-family-service";

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

async function ensureAutoRAGConfig(): Promise<void> {
	const configPath = autoragConfigPath();
	if (await access(configPath).then(() => true, () => false)) {
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

const REFRESH_METHODS: Record<RefreshMethod, true> = {
	parsed: true,
	minsync: true,
	datasources: true,
	jikji: true,
	everything: true,
	fsearch: true,
};

/** Manual index refresh from Settings; returns diagnostics instead of throwing for known failures. */
async function refreshAutoragIndex(methods?: readonly string[]): Promise<ConfigRefreshResult> {
	const requested = methods ?? ["parsed", "minsync"];
	const invalid = requested.filter((method) => REFRESH_METHODS[method as RefreshMethod] !== true);
	if (invalid.length > 0) throw new Error(`Unknown refresh method(s): ${invalid.join(", ")}`);
	const selected = requested as readonly RefreshMethod[];
	if (selected.length === 0) throw new Error("At least one refresh method is required");
	const input = { flags: {}, env: process.env, cwd: process.cwd() };
	const configPath = resolveConfigPath(input).configPath;
	const raw = (await access(configPath).then(() => true, () => false)) ? readRawConfigObject(configPath) : {};
	const effective = await applyAppIndexing(resolveConfigReadOnly(input), raw);
	const diagnostics: ConfigRefreshDiagnostic[] = [];
	try {
		const lite = new AutoRAGLite(effective);
		const result = await lite.refresh(false, { methods: selected });
		diagnostics.push(
			...result.diagnostics.map((diagnostic) => ({
				code: String(diagnostic.code),
				severity: diagnostic.severity,
				message: diagnostic.message,
			})),
		);
		const failures: string[] = [];
		if (result.minsync !== undefined && result.minsync.ok === false) failures.push(`minsync: ${result.minsync.reason ?? "failed"}`);
		if (result.everything !== undefined && result.everything.ok === false) failures.push(`everything: ${result.everything.reason ?? "failed"}`);
		if (result.fsearch !== undefined && result.fsearch.ok === false) {
			failures.push(`fsearch: ${result.fsearch.message ?? result.fsearch.reason ?? "failed"}`);
		}
		for (const datasource of result.datasources ?? []) {
			if (datasource.ok === false) failures.push(`datasources ${datasource.skill}: ${datasource.message ?? datasource.error ?? "failed"}`);
		}
		for (const diagnostic of diagnostics) {
			if (diagnostic.severity === "error") failures.push(diagnostic.message);
		}
		const settings = readAppIndexing(raw);
		if (settings.excludeCodeFolders) {
			const unsupported = selected
				.filter((method): method is "everything" | "fsearch" => method === "everything" || method === "fsearch")
				.filter((method) => APP_INDEXING_CAPABILITIES[method] !== true);
			if (unsupported.length > 0) {
				diagnostics.push({
					code: "code-folder-exclusions-unsupported",
					severity: "warning",
					message: `Automatic code-folder exclusions are not forwarded to ${unsupported.join(", ")} (its native client has no exclusion option).`,
				});
			}
		}
		const error = failures.length > 0 ? failures.join("; ") : null;
		return {
			ok: error === null,
			methods: selected,
			scanned: result.scanned,
			written: result.written,
			deleted: result.deleted,
			skipped: result.skipped,
			diagnostics,
			error,
		};
	} catch (error) {
		return {
			ok: false,
			methods: selected,
			scanned: 0,
			written: 0,
			deleted: 0,
			skipped: 0,
			diagnostics,
			error: error instanceof Error ? error.message : String(error),
		};
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
		// Spawning osascript blocks the caller for the fork; the worker pays it.
		defaultApp: (path) => (fsWorker === null ? Promise.resolve(null) : fsWorker.client.call<string | null>("defaultApp", [path])),
	});
	return window;
}

let fsWorker: FsWorkerHost | null = null;
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
	await ensureAutoRAGConfig();
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
	const applyScanInterval = (minutes: number): void => {
		void workerHost.client.call("setScanInterval", [minutes]).catch((error: unknown) => console.error("[fs-worker] scan interval:", error));
	};
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
	await credentials.load();
	const settingsService = createSettingsService({
		directory: join(app.getPath("userData"), "settings"),
		dataSources: createDataSourceStatusService({ env: process.env, cwd: process.cwd() }),
		models: createModelStatusService({ env: process.env, cwd: process.cwd() }),
		config: createAutoRagConfigService({ env: process.env, cwd: process.cwd() }),
		refreshConfig: refreshAutoragIndex,
		credentials,
		onSettingsChanged: (settings) => {
			applyAppearance(settings.appearance);
			applyScanInterval(settings.dupeyScanIntervalMinutes);
		},
	});
	registerSettingsIpcHandlers(settingsService);
	const settings = await settingsService.get();
	applyAppearance(settings.appearance);
	if (settings.dupeyScanIntervalMinutes !== DEFAULT_SCAN_INTERVAL_MINUTES) applyScanInterval(settings.dupeyScanIntervalMinutes);
	mainWindow = createMainWindow(devLabel, currentAppearance);
	app.on("activate", () => {
		if (mainWindow === null || mainWindow.isDestroyed()) {
			mainWindow = createMainWindow(devLabel, currentAppearance);
		}
	});
	// The worker's native watcher must finish unsubscribing before its Node
	// environment is torn down (an unsubscribe completing inside
	// `FreeEnvironment` aborts that process). Hold the quit until the worker
	// has released its watches, bounded so a stuck worker never blocks
	// quitting. Every other `will-quit` listener has already run and the
	// windows are closed by now, so the quit finishes with `app.exit` —
	// re-entering `app.quit()` from inside its own quit can stall the teardown.
	app.once("will-quit", (event) => {
		event.preventDefault();
		void workerHost
			.dispose()
			.catch((error: unknown) => console.error("[fs-worker] dispose on quit failed:", error))
			.finally(() => app.exit(0));
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

