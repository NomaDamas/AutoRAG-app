import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({ app: new (require("node:events").EventEmitter)(), autoUpdater: new (require("node:events").EventEmitter)() }));
vi.mock("electron", () => electron);

import { whenQuitting } from "../src/main/quit-signal";

beforeEach(() => {
	electron.app.removeAllListeners();
	electron.autoUpdater.removeAllListeners();
});

describe("whenQuitting", () => {
	it("fires on a normal quit", () => {
		const listener = vi.fn();
		whenQuitting(listener);
		(electron.app as EventEmitter).emit("before-quit");
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("fires when an update is installed: quitAndInstall closes the windows first and emits only before-quit-for-update", () => {
		const listener = vi.fn();
		whenQuitting(listener);
		(electron.autoUpdater as EventEmitter).emit("before-quit-for-update");
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("fires once when both events arrive", () => {
		const listener = vi.fn();
		whenQuitting(listener);
		(electron.autoUpdater as EventEmitter).emit("before-quit-for-update");
		(electron.app as EventEmitter).emit("before-quit");
		expect(listener).toHaveBeenCalledTimes(1);
	});
});
