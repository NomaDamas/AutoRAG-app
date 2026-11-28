import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** BrowserWindow stand-in that tracks visibility, focus, IPC hide calls, and close listeners. */
const electron = vi.hoisted(() => {
	const { EventEmitter: Emitter } = require("node:events") as typeof import("node:events");
	const ipcListeners = new Map<string, Array<(...args: unknown[]) => void>>();
	class FakeWindow extends Emitter {
		static all: FakeWindow[] = [];
		static focused: FakeWindow | null = null;
		static getFocusedWindow() {
			return FakeWindow.focused;
		}
		visible = false;
		minimized = false;
		destroyed = false;
		hides = 0;
		minimizes = 0;
		readonly webContents = Object.assign(new Emitter(), { setWindowOpenHandler: () => undefined, send: () => undefined, focus: () => undefined });
		constructor() {
			super();
			FakeWindow.all.push(this);
		}
		setAlwaysOnTop() {}
		getNativeWindowHandle() {
			return Buffer.alloc(8);
		}
		setVibrancy() {}
		setVisibleOnAllWorkspaces() {}
		setWindowButtonVisibility() {}
		setBounds() {}
		isDestroyed() {
			return this.destroyed;
		}
		isVisible() {
			return this.visible;
		}
		isFocused() {
			return FakeWindow.focused === this;
		}
		isMinimized() {
			return this.minimized;
		}
		restore() {
			this.minimized = false;
		}
		minimize() {
			this.minimizes += 1;
			this.minimized = true;
		}
		show() {
			this.visible = true;
		}
		focus() {
			FakeWindow.focused = this;
		}
		hide() {
			this.hides += 1;
			this.visible = false;
			if (FakeWindow.focused === this) FakeWindow.focused = null;
		}
		destroy() {
			this.destroyed = true;
		}
		/** Electron's close: listeners may veto with `preventDefault`; returns whether the window really closed. */
		requestClose(): boolean {
			let prevented = false;
			this.emit("close", { preventDefault: () => (prevented = true) });
			if (!prevented) this.destroyed = true;
			return !prevented;
		}
	}
	const app = Object.assign(new Emitter(), {
		hides: 0,
		hide() {
			this.hides += 1;
		},
	});
	return {
		app,
		autoUpdater: new Emitter(),
		BrowserWindow: FakeWindow,
		ipcMain: {
			on: (channel: string, listener: (...args: unknown[]) => void) => {
				const list = ipcListeners.get(channel) ?? [];
				list.push(listener);
				ipcListeners.set(channel, list);
			},
			emit: (channel: string, ...args: unknown[]) => {
				for (const listener of ipcListeners.get(channel) ?? []) listener(...args);
			},
			handle: () => undefined,
			removeHandler: () => undefined,
			removeAllListeners: (channel?: string) => {
				if (channel === undefined) ipcListeners.clear();
				else ipcListeners.delete(channel);
			},
		},
		nativeTheme: { shouldUseDarkColors: false },
		screen: {
			getCursorScreenPoint: () => ({ x: 0, y: 0 }),
			getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
		},
	};
});
vi.mock("electron", () => electron);

import { createQuickSearchWindow } from "../src/main/quick-search-window";
import { QUICK_SEARCH_CHANNELS } from "../src/shared/quick-search-contract";
function launcher() {
	electron.BrowserWindow.all.length = 0;
	const controller = createQuickSearchWindow({
		preload: "preload.js",
		appearance: "light",
		language: "en",
		loadPage: () => undefined,
		revealInApp: async () => undefined,
		ask: () => undefined,
		attach: async () => undefined,
		status: () => ({}) as never,
		setRecording: () => undefined,
		attachPreview: () => new electron.BrowserWindow() as never,
	});
	const window = electron.BrowserWindow.all[0];
	if (window === undefined) throw new Error("the launcher window was not created");
	window.visible = true;
	return { window, controller };
}

beforeEach(() => {
	electron.app.removeAllListeners();
	electron.app.hides = 0;
	electron.autoUpdater.removeAllListeners();
	electron.ipcMain.removeAllListeners();
	electron.BrowserWindow.focused = null;
});
describe("quick-search launcher on quit", () => {
	it("hides instead of closing while the app keeps running", () => {
		const { window } = launcher();
		expect(window.requestClose()).toBe(false);
		expect(window.hides).toBe(1);
	});

	it("closes on a normal quit", () => {
		const { window } = launcher();
		(electron.app as EventEmitter).emit("before-quit");
		expect(window.requestClose()).toBe(true);
	});

	it("closes when an update is installed, so quitAndInstall can finish closing every window", () => {
		const { window } = launcher();
		(electron.autoUpdater as EventEmitter).emit("before-quit-for-update");
		expect(window.requestClose()).toBe(true);
	});

	it("ignores toggle once the app is quitting so a late shortcut cannot recreate a window during shutdown", () => {
		const { window, controller } = launcher();
		(electron.autoUpdater as EventEmitter).emit("before-quit-for-update");
		expect(window.requestClose()).toBe(true);
		const countAfterClose = electron.BrowserWindow.all.length;
		controller.toggle();
		expect(electron.BrowserWindow.all.length).toBe(countAfterClose);
	});
});

describe("quick-search launcher dismiss", () => {
	it("hides only the launcher window on Escape when summoned over another app, without calling app.hide()", () => {
		const { window, controller } = launcher();
		window.visible = false;
		// Another app is in front, so no Dazzi BrowserWindow is focused when ⌥Space fires.
		electron.BrowserWindow.focused = null;
		controller.toggle();
		expect(window.isVisible()).toBe(true);
		expect(window.isFocused()).toBe(true);

		// Renderer sends Escape -> hide("restore").
		electron.ipcMain.emit(QUICK_SEARCH_CHANNELS.hide, { sender: window.webContents }, "restore");
		expect(window.isVisible()).toBe(false);
		expect(window.hides).toBe(1);
		// Calling app.hide() on macOS would hide every other open Dazzi window on screen.
		expect(electron.app.hides).toBe(0);
	});

	it("hides only the launcher window on second toggle or close, without calling app.hide()", () => {
		const { window, controller } = launcher();
		window.visible = false;
		electron.BrowserWindow.focused = null;
		controller.toggle();
		expect(window.isVisible()).toBe(true);

		controller.toggle();
		expect(window.isVisible()).toBe(false);
		expect(electron.app.hides).toBe(0);

		controller.toggle();
		expect(window.requestClose()).toBe(false);
		expect(window.isVisible()).toBe(false);
		expect(electron.app.hides).toBe(0);
	});

	it("defers creating the BrowserWindow until first toggle when lazy: true", () => {
		electron.BrowserWindow.all.length = 0;
		const controller = createQuickSearchWindow({
			preload: "preload.js",
			appearance: "light",
			language: "en",
			loadPage: () => undefined,
			revealInApp: async () => undefined,
			ask: () => undefined,
			attach: async () => undefined,
			status: () => ({}) as never,
			setRecording: () => undefined,
			attachPreview: () => null,
			lazy: true,
		});
		expect(electron.BrowserWindow.all).toHaveLength(0);
		controller.toggle();
		expect(electron.BrowserWindow.all).toHaveLength(1);
		expect(electron.BrowserWindow.all[0]?.isVisible()).toBe(true);
		controller.toggle();
		expect(electron.BrowserWindow.all[0]?.isVisible()).toBe(false);
		controller.destroy();
	});
});
