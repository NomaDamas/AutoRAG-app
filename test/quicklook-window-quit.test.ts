import type { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** BrowserWindow stand-in that keeps its `close` listeners, so a test can close it the way Electron does. */
const mock = vi.hoisted(() => {
	const { EventEmitter: Emitter } = require("node:events") as typeof import("node:events");
	class FakeWindow extends Emitter {
		static all: FakeWindow[] = [];
		destroyed = false;
		readonly webContents = Object.assign(new Emitter(), { setWindowOpenHandler: () => undefined, getZoomFactor: () => 1, isDestroyed: () => false, send: () => undefined });
		constructor() {
			super();
			FakeWindow.all.push(this);
		}
		setWindowButtonVisibility() {}
		setVisibleOnAllWorkspaces() {}
		setAlwaysOnTop() {}
		setBackgroundColor() {}
		isDestroyed() {
			return this.destroyed;
		}
		isVisible() {
			return false;
		}
		hide() {}
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
		FakeWindow,
		app: Object.assign(new Emitter(), { getPath: () => "/tmp" }),
		autoUpdater: new Emitter(),
		nativeTheme: Object.assign(new Emitter(), { shouldUseDarkColors: false }),
	};
});
vi.mock("electron", () => ({
	app: mock.app,
	autoUpdater: mock.autoUpdater,
	nativeTheme: mock.nativeTheme,
	BrowserWindow: mock.FakeWindow,
	clipboard: {},
	ipcMain: {},
	screen: {},
	ShareMenu: class {},
	shell: {},
}));

/** `quitting` is module state in the preview window code: each test gets a fresh module. */
async function loadPreview() {
	vi.resetModules();
	return import("../src/preview/node/window");
}

const app: EventEmitter = mock.app;
const autoUpdater: EventEmitter = mock.autoUpdater;
const ipc = { handle: () => undefined, on: () => undefined } as never;

async function panel() {
	const preview = await loadPreview();
	preview.registerQuickLookIpc(null, ipc);
	const owner = new mock.FakeWindow();
	mock.FakeWindow.all.length = 0;
	preview.attachQuickLook(owner as never, { preload: "preload.js", appearance: "light", language: "en", loadPage: () => undefined } as never);
	const window = mock.FakeWindow.all[0];
	if (window === undefined) throw new Error("the Quick Look panel was not created");
	return window;
}

beforeEach(() => {
	app.removeAllListeners();
	autoUpdater.removeAllListeners();
});

describe("Quick Look panel on quit", () => {
	it("hides instead of closing while the app keeps running", async () => {
		expect((await panel()).requestClose()).toBe(false);
	});

	it("closes on a normal quit", async () => {
		const window = await panel();
		app.emit("before-quit");
		expect(window.requestClose()).toBe(true);
	});

	it("closes when an update is installed, so quitAndInstall can finish closing every window", async () => {
		const window = await panel();
		autoUpdater.emit("before-quit-for-update");
		expect(window.requestClose()).toBe(true);
	});
});
