import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({ app: new (require("node:events").EventEmitter)(), autoUpdater: new (require("node:events").EventEmitter)() }));
vi.mock("electron", () => electron);

import { runQuitCleanup, whenQuitting } from "../src/main/quit-signal";

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

describe("runQuitCleanup", () => {
	it("waits for all tasks with allSettled semantics (one failure does not abort the rest) and exits", async () => {
		let secondFinished = false;
		const second = Promise.withResolvers<void>();
		const exit = vi.fn();
		const logError = vi.fn();
		const running = runQuitCleanup({
			tasks: [
				Promise.reject(new Error("boom")),
				second.promise.then(() => {
					secondFinished = true;
				}),
			],
			timeoutMs: 500,
			onExit: exit,
			onError: logError,
		});
		await Promise.resolve();
		expect(exit).not.toHaveBeenCalled();
		second.resolve();
		await running;
		expect(secondFinished).toBe(true);
		expect(logError).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledTimes(1);
	});

	it("exits once the hard deadline expires even if a cleanup task hangs forever, so ShipIt never stalls waiting for exit", async () => {
		vi.useFakeTimers();
		try {
			const exit = vi.fn();
			const logError = vi.fn();
			const never = Promise.withResolvers<void>().promise;
			const running = runQuitCleanup({
				tasks: [never],
				timeoutMs: 5_000,
				onExit: exit,
				onError: logError,
			});
			await vi.advanceTimersByTimeAsync(4_999);
			expect(exit).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			await running;
			expect(exit).toHaveBeenCalledTimes(1);
			expect(logError).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
