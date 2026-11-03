/**
 * The quick-search launcher window: a small frameless window a system-wide shortcut summons over whatever app is in
 * front (Raycast / Spotlight style). It is created hidden at startup, so a press only has to place and show it.
 *
 * macOS gets a `panel` window, which floats over full-screen apps and appears on every Space. Windows gets an
 * always-on-top window without a taskbar button. Dismissing it (Escape, a click elsewhere, a copy) gives the foreground
 * back to the app the person was in: Windows does that itself when the focused window hides; on macOS the app hides
 * itself unless one of Dazzi's own windows was in front when the launcher was summoned.
 */

import { app, BrowserWindow, ipcMain, nativeTheme, screen } from "electron";
import { LANGUAGE_FLAG } from "../shared/language-contract";
import { QUICK_SEARCH_CHANNELS, type QuickSearchHideMode, type QuickSearchStatus } from "../shared/quick-search-contract";
import type { AppSettings } from "../shared/settings-contract";

export const QUICK_SEARCH_WIDTH = 720;
export const QUICK_SEARCH_HEIGHT = 468;
/** The launcher's top edge sits this far down the work area, like Spotlight's. */
const TOP_FRACTION = 0.2;

export interface QuickSearchWindowDeps {
	readonly preload: string;
	readonly appearance: AppSettings["appearance"];
	readonly language: AppSettings["language"];
	readonly loadPage: (window: BrowserWindow) => void;
	/** Show this path selected in the Dazzi Finder (the os-request `reveal` path). */
	readonly revealInApp: (path: string) => Promise<void>;
	/** A new AI Search tab asks the question. */
	readonly ask: (query: string) => void;
	/** The paths become drafts of the nearest AI Search tab. */
	readonly attach: (paths: readonly string[]) => Promise<void>;
	/** Settings' status read and its recording pause, answered by the global shortcut. */
	readonly status: () => QuickSearchStatus;
	readonly setRecording: (recording: boolean) => void;
}

export interface QuickSearchWindow {
	/** The shortcut's action: show and focus the launcher, or hide it when it is already in front. */
	toggle(): void;
	/** Ends the window and its IPC (quit). */
	destroy(): void;
}

/** Where the launcher goes: centred on the display's work area, a fifth of the way down. */
export function launcherBounds(workArea: Electron.Rectangle): Electron.Rectangle {
	const width = Math.min(QUICK_SEARCH_WIDTH, workArea.width);
	const height = Math.min(QUICK_SEARCH_HEIGHT, workArea.height);
	return {
		x: Math.round(workArea.x + (workArea.width - width) / 2),
		y: Math.round(workArea.y + Math.min(workArea.height * TOP_FRACTION, workArea.height - height)),
		width,
		height,
	};
}

function isPathList(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0);
}

export function createQuickSearchWindow(deps: QuickSearchWindowDeps): QuickSearchWindow {
	const darwin = process.platform === "darwin";
	let window: BrowserWindow | null = null;
	let destroyed = false;
	/** A Dazzi window was in front when the launcher was summoned: dismissing it must not hide the app on macOS. */
	let appWasActive = false;

	const create = (): BrowserWindow => {
		const created = new BrowserWindow({
			show: false,
			width: QUICK_SEARCH_WIDTH,
			height: QUICK_SEARCH_HEIGHT,
			frame: false,
			resizable: false,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			skipTaskbar: true,
			alwaysOnTop: true,
			hasShadow: true,
			title: "Quick Search",
			...(darwin ? { type: "panel", transparent: true, backgroundColor: "#00000000", vibrancy: "popover" as const, visualEffectState: "active" as const } : { backgroundColor: nativeTheme.shouldUseDarkColors ? "#1E1E20" : "#FFFFFF" }),
			webPreferences: {
				preload: deps.preload,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: false,
				spellcheck: false,
				backgroundThrottling: false,
				additionalArguments: [`--autorag-appearance=${deps.appearance}`, `${LANGUAGE_FLAG}${deps.language}`],
			},
		});
		// Above full-screen apps and on every Space / virtual desktop, like the system's own search.
		created.setAlwaysOnTop(true, darwin ? "pop-up-menu" : "screen-saver");
		created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
		if (darwin) created.setWindowButtonVisibility(false);
		created.webContents.on("will-navigate", (event) => event.preventDefault());
		created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		// Clicking anywhere else dismisses it; that click already gave the other app the foreground.
		created.on("blur", () => {
			if (!created.isDestroyed() && created.isVisible()) created.hide();
		});
		// The window is reused: closing it (⌘W, Alt+F4) only hides it.
		created.on("close", (event) => {
			if (destroyed) return;
			event.preventDefault();
			hide("restore");
		});
		deps.loadPage(created);
		return created;
	};

	const hide = (mode: QuickSearchHideMode): void => {
		const current = window;
		if (current === null || current.isDestroyed() || !current.isVisible()) return;
		current.hide();
		if (mode === "restore" && darwin && !appWasActive) app.hide();
	};

	window = create();

	const fromLauncher = (sender: Electron.WebContents): boolean => window !== null && !window.isDestroyed() && sender === window.webContents;
	ipcMain.on(QUICK_SEARCH_CHANNELS.hide, (event, mode: unknown) => {
		if (fromLauncher(event.sender)) hide(mode === "handoff" ? "handoff" : "restore");
	});
	ipcMain.handle(QUICK_SEARCH_CHANNELS.revealInApp, async (event, path: unknown) => {
		if (!fromLauncher(event.sender) || typeof path !== "string" || path.length === 0) return;
		hide("handoff");
		await deps.revealInApp(path);
	});
	ipcMain.handle(QUICK_SEARCH_CHANNELS.ask, (event, query: unknown) => {
		if (!fromLauncher(event.sender) || typeof query !== "string") return;
		hide("handoff");
		deps.ask(query);
	});
	ipcMain.handle(QUICK_SEARCH_CHANNELS.attach, async (event, paths: unknown) => {
		if (!fromLauncher(event.sender) || !isPathList(paths)) return;
		hide("handoff");
		await deps.attach(paths);
	});
	ipcMain.handle(QUICK_SEARCH_CHANNELS.status, () => deps.status());
	ipcMain.handle(QUICK_SEARCH_CHANNELS.recording, (_event, recording: unknown) => deps.setRecording(recording === true));

	return {
		toggle() {
			if (window === null || window.isDestroyed()) window = create();
			const current = window;
			if (current.isVisible() && current.isFocused()) {
				hide("restore");
				return;
			}
			const focused = BrowserWindow.getFocusedWindow();
			appWasActive = focused !== null && focused !== current;
			const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
			current.setBounds(launcherBounds(display.workArea));
			current.show();
			current.focus();
			current.webContents.focus();
			current.webContents.send(QUICK_SEARCH_CHANNELS.shown);
		},
		destroy() {
			destroyed = true;
			for (const channel of [QUICK_SEARCH_CHANNELS.revealInApp, QUICK_SEARCH_CHANNELS.ask, QUICK_SEARCH_CHANNELS.attach, QUICK_SEARCH_CHANNELS.status, QUICK_SEARCH_CHANNELS.recording]) {
				ipcMain.removeHandler(channel);
			}
			ipcMain.removeAllListeners(QUICK_SEARCH_CHANNELS.hide);
			if (window !== null && !window.isDestroyed()) window.destroy();
			window = null;
		},
	};
}
