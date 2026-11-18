import type ParcelWatcher from "@parcel/watcher";
import { describe, expect, it } from "vitest";
import type { FsChange } from "../src/shared/live-contract";
import { createParcelWatchBackend, type ParcelWatcherLike } from "../src/main/watch-backend";

interface RecordedSubscribe {
	readonly dir: string;
	readonly options: ParcelWatcher.Options;
	readonly callback: ParcelWatcher.SubscribeCallback;
}

function recordingWatcher(): { readonly watcher: ParcelWatcherLike; readonly calls: RecordedSubscribe[] } {
	const calls: RecordedSubscribe[] = [];
	const watcher: ParcelWatcherLike = {
		async subscribe(dir, callback, options) {
			calls.push({ dir, options: options ?? {}, callback });
			return { unsubscribe: async () => {} };
		},
	};
	return { watcher, calls };
}

/** The shape from #419: a base directory plus 24 nested levels, well past MAX_PATH. */
const LONG_WINDOWS_DIR = `C:\\Users\\vkehfdl1\\dazzi-qa\\sandbox\\docs\\long-path\\${Array.from(
	{ length: 24 },
	(_, index) => `nested-${String(index).padStart(2, "0")}-1234567890`,
).join("\\")}`;

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
		expect(calls[0]?.options.backend).toBe("windows");
	});

	it("leaves the choice to the library elsewhere", async () => {
		const { watcher, calls } = recordingWatcher();
		await createParcelWatchBackend({ watcher, platform: "darwin" }).subscribe("/docs", () => {}, () => {});
		expect(calls[0]?.options.backend).toBeUndefined();
	});

	it("still ignores nested paths so only the folder and its direct children report", async () => {
		const { watcher, calls } = recordingWatcher();
		await createParcelWatchBackend({ watcher, platform: "win32" }).subscribe("C:\\docs", () => {}, () => {});
		const ignore = calls[0]?.options.ignore ?? [];
		expect(ignore.some((entry) => entry instanceof RegExp && entry.test("sub\\file.txt"))).toBe(true);
		expect(ignore.some((entry) => entry instanceof RegExp && entry.test("file.txt"))).toBe(false);
	});

	/**
	 * #419: the Windows backend opens the watched directory with `CreateFileW`
	 * on the plain path, which answers `Invalid handle` past MAX_PATH even
	 * though Node's `fs` (which prefixes internally) lists the same directory.
	 * The extended-length prefix goes to the native watcher only — events must
	 * come back under the caller's own root so the fs-watch-service can keep
	 * translating them to the visible directory.
	 */
	it("subscribes to over-long Windows directories through the extended-length namespace", async () => {
		const { watcher, calls } = recordingWatcher();
		const emitted: (readonly FsChange[])[] = [];
		expect(LONG_WINDOWS_DIR.length).toBeGreaterThanOrEqual(248);
		await createParcelWatchBackend({ watcher, platform: "win32" }).subscribe(LONG_WINDOWS_DIR, (events) => emitted.push(events), () => {});
		expect(calls[0]?.dir).toBe(`\\\\?\\${LONG_WINDOWS_DIR}`);
		calls[0]?.callback(null, [
			{ path: `\\\\?\\${LONG_WINDOWS_DIR}`, type: "update" },
			{ path: `\\\\?\\${LONG_WINDOWS_DIR}\\child.txt`, type: "create" },
		]);
		expect(emitted).toEqual([
			[
				{ path: LONG_WINDOWS_DIR, type: "update" },
				{ path: `${LONG_WINDOWS_DIR}\\child.txt`, type: "create" },
			],
		]);
	});

	it("uses the UNC namespace for over-long network shares", async () => {
		const { watcher, calls } = recordingWatcher();
		const dir = `\\\\server\\share\\${"nested-1234567890\\".repeat(16)}deep`;
		expect(dir.length).toBeGreaterThanOrEqual(248);
		await createParcelWatchBackend({ watcher, platform: "win32" }).subscribe(dir, () => {}, () => {});
		expect(calls[0]?.dir).toBe(`\\\\?\\UNC\\${dir.slice(2)}`);
	});

	it("leaves short paths, other platforms, and already-extended paths untouched", async () => {
		const short = recordingWatcher();
		await createParcelWatchBackend({ watcher: short.watcher, platform: "win32" }).subscribe("C:\\docs", () => {}, () => {});
		expect(short.calls[0]?.dir).toBe("C:\\docs");

		const posix = recordingWatcher();
		const longPosix = `/tmp/${"nested/".repeat(70)}deep`;
		expect(longPosix.length).toBeGreaterThanOrEqual(248);
		await createParcelWatchBackend({ watcher: posix.watcher, platform: "darwin" }).subscribe(longPosix, () => {}, () => {});
		expect(posix.calls[0]?.dir).toBe(longPosix);

		const extended = recordingWatcher();
		await createParcelWatchBackend({ watcher: extended.watcher, platform: "win32" }).subscribe(`\\\\?\\${LONG_WINDOWS_DIR}`, () => {}, () => {});
		expect(extended.calls[0]?.dir).toBe(`\\\\?\\${LONG_WINDOWS_DIR}`);
	});
});
