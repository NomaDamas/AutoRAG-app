import { describe, expect, it, vi } from "vitest";
import {
	buildMacFinderPollJxa,
	createMacFinderWatcher,
	fileUrlToMacPath,
	isInterceptableMacFinderPath,
	parseMacFinderPollOutput,
} from "../src/main/mac-finder-watcher";

describe("mac-finder-watcher helpers", () => {
	it("converts Finder file:// URLs into decoded POSIX paths and rejects non-file URLs", () => {
		expect(fileUrlToMacPath("file:///Users/jeffrey/Desktop/My%20Folder/")).toBe("/Users/jeffrey/Desktop/My Folder");
		expect(fileUrlToMacPath("file:///Users/jeffrey/Desktop/%ED%85%8C%EC%8A%A4%ED%8A%B8/")).toBe("/Users/jeffrey/Desktop/테스트");
		expect(fileUrlToMacPath("file:///")).toBe("/");
		expect(fileUrlToMacPath("")).toBeNull();
		expect(fileUrlToMacPath("x-apple-finder://airdrop")).toBeNull();
		expect(fileUrlToMacPath("not a url")).toBeNull();
	});

	it("accepts real filesystem paths and rejects Finder virtual/trash paths", () => {
		expect(isInterceptableMacFinderPath("/Users/jeffrey/Desktop/Projects")).toBe(true);
		expect(isInterceptableMacFinderPath("/Users/jeffrey/Documents")).toBe(true);
		expect(isInterceptableMacFinderPath("/Volumes/SSD1/work")).toBe(true);
		expect(isInterceptableMacFinderPath("/Applications")).toBe(true);
		expect(isInterceptableMacFinderPath("")).toBe(false);
		expect(isInterceptableMacFinderPath("relative/path")).toBe(false);
		expect(isInterceptableMacFinderPath("/Users/jeffrey/.Trash")).toBe(false);
		expect(isInterceptableMacFinderPath("/Users/jeffrey/.Trash/deleted-folder")).toBe(false);
		expect(isInterceptableMacFinderPath("/Volumes/SSD1/.Trashes/501")).toBe(false);
		expect(isInterceptableMacFinderPath("/Users/jeffrey/Library/Mobile Documents/.Trash")).toBe(false);
		expect(isInterceptableMacFinderPath("/System/Library/CoreServices/Finder.app/Contents/Resources/MyLibraries/myDocuments.cannedSearch")).toBe(false);
	});

	it("parses JXA poll output into snapshot windows and handles errors cleanly", () => {
		expect(parseMacFinderPollOutput("")).toEqual({ ok: true, windows: [] });
		expect(parseMacFinderPollOutput("[]")).toEqual({ ok: true, windows: [] });
		expect(
			parseMacFinderPollOutput(
				JSON.stringify([
					{ id: 101, url: "file:///Users/jeffrey/Desktop/Work/" },
					{ id: 102, url: "" },
					{ id: "bad", url: "file:///tmp" },
					{ id: 103, url: "file:///Users/jeffrey/Documents/", selectedUrl: "file:///Users/jeffrey/Documents/spec.pdf" },
				]),
			),
		).toEqual({
			ok: true,
			windows: [
				{ id: 101, path: "/Users/jeffrey/Desktop/Work", selectedPath: null },
				{ id: 102, path: null, selectedPath: null },
				{ id: 103, path: "/Users/jeffrey/Documents", selectedPath: "/Users/jeffrey/Documents/spec.pdf" },
			],
		});
		expect(parseMacFinderPollOutput("not-json")).toEqual({ ok: false, windows: [] });
	});

	it("builds a JXA poll script that only queries Finder.finderWindows() (ignoring Get Info / Preferences / Desktop)", () => {
		const script = buildMacFinderPollJxa();
		expect(script).toContain('Application("Finder")');
		expect(script).toContain("finderWindows()");
		expect(script).toContain("target()");
		expect(script).toContain("JSON.stringify");
	});
});

describe("createMacFinderWatcher", () => {
	it("snapshots pre-existing Finder windows on startup and only intercepts newly opened real-folder Finder windows", async () => {
		vi.useFakeTimers();
		try {
			const intercepted: { action: "open" | "reveal"; path: string }[] = [];
			const closedIds: number[] = [];
			let pollCount = 0;

			const watcher = createMacFinderWatcher({
				platform: "darwin",
				pollIntervalMs: 100,
				onIntercept: (event) => intercepted.push(event),
				runJxa: async (script, args) => {
					if (script.includes("close()")) {
						closedIds.push(Number(args[0]));
						return "closed";
					}
					pollCount += 1;
					if (pollCount === 1) {
						// Initial snapshot: window 10 already existed — must NEVER be closed or intercepted.
						return JSON.stringify([{ id: 10, url: "file:///Users/jeffrey/Documents/" }]);
					}
					if (pollCount === 2) {
						// New window 20 opened on a Desktop folder + new window 21 on Trash (ignored) + 22 on virtual/AirDrop (empty url, ignored)
						return JSON.stringify([
							{ id: 10, url: "file:///Users/jeffrey/Documents/" },
							{ id: 20, url: "file:///Users/jeffrey/Desktop/Demo%20Folder/" },
							{ id: 21, url: "file:///Users/jeffrey/.Trash/" },
							{ id: 22, url: "" },
						]);
					}
					// Next poll: window 20 was closed, 10/21/22 still open — no duplicate intercept.
					return JSON.stringify([
						{ id: 10, url: "file:///Users/jeffrey/Documents/" },
						{ id: 21, url: "file:///Users/jeffrey/.Trash/" },
						{ id: 22, url: "" },
					]);
				},
			});

			expect(watcher.isRunning()).toBe(false);
			watcher.start();
			expect(watcher.isRunning()).toBe(true);

			// Initial snapshot runs immediately on start.
			await vi.advanceTimersByTimeAsync(10);
			expect(intercepted).toEqual([]);
			expect(closedIds).toEqual([]);

			// Second tick detects window 20, closes it, and emits open.
			await vi.advanceTimersByTimeAsync(110);
			expect(closedIds).toEqual([20]);
			expect(intercepted).toEqual([{ action: "open", path: "/Users/jeffrey/Desktop/Demo Folder" }]);

			// Third tick does not re-emit anything.
			await vi.advanceTimersByTimeAsync(110);
			expect(closedIds).toEqual([20]);
			expect(intercepted).toHaveLength(1);

			watcher.stop();
			expect(watcher.isRunning()).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("respects suppressFor(ms) so intentional 'Reveal in Finder' from Dazzi is not intercepted back", async () => {
		vi.useFakeTimers();
		try {
			const intercepted: { action: "open" | "reveal"; path: string }[] = [];
			const closedIds: number[] = [];
			let pollCount = 0;

			let showAfterSuppress = false;

			const watcher = createMacFinderWatcher({
				platform: "darwin",
				pollIntervalMs: 100,
				onIntercept: (event) => intercepted.push(event),
				runJxa: async (script, args) => {
					if (script.includes("close()")) {
						closedIds.push(Number(args[0]));
						return "closed";
					}
					pollCount += 1;
					if (pollCount === 1) return "[]";
					if (!showAfterSuppress) {
						return JSON.stringify([{ id: 55, url: "file:///Users/jeffrey/Downloads/" }]);
					}
					return JSON.stringify([
						{ id: 55, url: "file:///Users/jeffrey/Downloads/" },
						{ id: 56, url: "file:///Users/jeffrey/Desktop/AfterSuppress/" },
					]);
				},
			});

			watcher.start();
			await vi.advanceTimersByTimeAsync(10);

			// Dazzi intentionally opened Finder; suppress interception for 1000ms.
			watcher.suppressFor(1000);
			await vi.advanceTimersByTimeAsync(110);
			// Window 55 appeared during suppression: marked as seen, NOT closed, NOT intercepted.
			expect(closedIds).toEqual([]);
			expect(intercepted).toEqual([]);

			// After suppression expires, a genuinely new window 56 opens and IS intercepted (while 55 remains untouched).
			await vi.advanceTimersByTimeAsync(950);
			showAfterSuppress = true;
			await vi.advanceTimersByTimeAsync(150);
			expect(closedIds).toEqual([56]);
			expect(intercepted).toEqual([{ action: "open", path: "/Users/jeffrey/Desktop/AfterSuppress" }]);

			watcher.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("backs off and reports permission error without crashing when macOS Automation permission is denied (-1743)", async () => {
		vi.useFakeTimers();
		try {
			const errors: string[] = [];
			let calls = 0;

			const watcher = createMacFinderWatcher({
				platform: "darwin",
				pollIntervalMs: 100,
				onIntercept: () => undefined,
				onError: (msg) => errors.push(msg),
				runJxa: async () => {
					calls += 1;
					throw new Error("execution error: Error: Error: Not authorized to send Apple events to Finder. (-1743)");
				},
			});

			watcher.start();
			await vi.advanceTimersByTimeAsync(10);
			expect(calls).toBe(1);
			expect(errors.length).toBe(1);
			expect(errors[0]).toContain("-1743");

			// Should back off rather than hammering osascript every 100ms while permission is denied.
			await vi.advanceTimersByTimeAsync(500);
			expect(calls).toBe(1);

			watcher.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("is a safe no-op on non-darwin platforms", () => {
		const watcher = createMacFinderWatcher({
			platform: "win32",
			onIntercept: () => undefined,
		});
		watcher.start();
		expect(watcher.isRunning()).toBe(false);
		watcher.stop();
	});
});
