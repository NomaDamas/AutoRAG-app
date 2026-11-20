import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** BrowserWindow stand-in that keeps its `close` listeners, so a test can close it the way Electron does. */
const electron = vi.hoisted(() => {
	const { EventEmitter: Emitter } = require("node:events") as typeof import("node:events");
	class FakeWindow extends Emitter {
		static all: FakeWindow[] = [];
		visible = false;
		destroyed = false;
		hides = 0;
		readonly webContents = Object.assign(new Emitter(), { setWindowOpenHandler: () => undefined, send: () => undefined, focus: () => undefined });
		constructor() {
			super();
			FakeWindow.all.push(this);
		}
		setAlwaysOnTop() {}
		setVisibleOnAllWorkspaces() {}
		setWindowButtonVisibility() {}
		isDestroyed() {
			return this.destroyed;
		}
		isVisible() {
			return this.visible;
		}
		hide() {
			this.hides += 1;
			this.visible = false;
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
	return {
		app: Object.assign(new Emitter(), { hide: () => undefined }),
		autoUpdater: new Emitter(),
		BrowserWindow: FakeWindow,
		ipcMain: { on: () => undefined, handle: () => undefined, removeHandler: () => undefined, removeAllListeners: () => undefined },
		nativeTheme: { shouldUseDarkColors: false },
		screen: {},
	};
});
vi.mock("electron", () => electron);

import { createQuickSearchWindow } from "../src/main/quick-search-window";

type Fake = InstanceType<typeof electron.BrowserWindow>;

function launcher(): Fake {
	electron.BrowserWindow.all.length = 0;
	createQuickSearchWindow({
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
	return window;
}

beforeEach(() => {
	electron.app.removeAllListeners();
	electron.autoUpdater.removeAllListeners();
});

describe("quick-search launcher on quit", () => {
	it("hides instead of closing while the app keeps running", () => {
		const window = launcher();
		expect(window.requestClose()).toBe(false);
		expect(window.hides).toBe(1);
	});

	it("closes on a normal quit", () => {
		const window = launcher();
		(electron.app as EventEmitter).emit("before-quit");
		expect(window.requestClose()).toBe(true);
	});

	it("closes when an update is installed, so quitAndInstall can finish closing every window", () => {
		const window = launcher();
		(electron.autoUpdater as EventEmitter).emit("before-quit-for-update");
		expect(window.requestClose()).toBe(true);
	});
});
