import type ParcelWatcher from "@parcel/watcher";
import { describe, expect, it } from "vitest";
import { createParcelWatchBackend, type ParcelWatcherLike } from "../src/main/watch-backend";

function recordingWatcher(): { readonly watcher: ParcelWatcherLike; readonly calls: ParcelWatcher.Options[] } {
	const calls: ParcelWatcher.Options[] = [];
	const watcher: ParcelWatcherLike = {
		async subscribe(_dir, _callback, options) {
			calls.push(options ?? {});
			return { unsubscribe: async () => {} };
		},
	};
	return { watcher, calls };
}

describe("the directory watcher backend", () => {
	/**
	 * With no backend named, @parcel/watcher probes for Watchman on every
	 * subscribe by `popen("watchman ...")`. On Windows that starts `cmd.exe`
	 * outside Node, so no `windowsHide` reaches it and a console window flashes
	 * each time a folder is opened. Naming the native backend skips the probe.
	 */
	it("names the native Windows backend so the Watchman probe never runs", async () => {
		const { watcher, calls } = recordingWatcher();
		await createParcelWatchBackend({ watcher, platform: "win32" }).subscribe("C:\\docs", () => {}, () => {});
		expect(calls[0]?.backend).toBe("windows");
	});

	it("leaves the choice to the library elsewhere", async () => {
		const { watcher, calls } = recordingWatcher();
		await createParcelWatchBackend({ watcher, platform: "darwin" }).subscribe("/docs", () => {}, () => {});
		expect(calls[0]?.backend).toBeUndefined();
	});

	it("still ignores nested paths so only the folder and its direct children report", async () => {
		const { watcher, calls } = recordingWatcher();
		await createParcelWatchBackend({ watcher, platform: "win32" }).subscribe("C:\\docs", () => {}, () => {});
		const ignore = calls[0]?.ignore ?? [];
		expect(ignore.some((entry) => entry instanceof RegExp && entry.test("sub\\file.txt"))).toBe(true);
		expect(ignore.some((entry) => entry instanceof RegExp && entry.test("file.txt"))).toBe(false);
	});
});
