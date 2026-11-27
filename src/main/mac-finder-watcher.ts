import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OSASCRIPT_BIN = "/usr/bin/osascript";

/**
 * macOS Finder window watcher that intercepts newly opened Finder windows
 * (e.g. double-clicking a folder on the Desktop, clicking Finder in the Dock,
 * or pressing Cmd+N in Finder) and hands their folder path over to Dazzi.
 *
 * Why a watcher is needed on macOS:
 * - macOS Desktop icons are rendered directly by `Finder.app`, so double-clicking
 *   a folder on the Desktop bypasses LaunchServices (`public.folder`) and
 *   `NSFileViewer`.
 * - Querying `Application("Finder").finderWindows()` only lists standard file
 *   browser windows — Get Info panels, Preferences, Copy/Move progress dialogs,
 *   and the Desktop window itself are NOT `finderWindows()` and are never touched.
 *
 * How it works:
 * - On `start()`, it snapshots existing Finder window IDs so Finder windows that
 *   were already open are NEVER closed or intercepted.
 * - On each poll tick, any brand-new Finder window ID whose `target().url()` is a
 *   real filesystem `file://` URL (and not Trash, `.Trashes`, or Finder's internal
 *   `.cannedSearch` smart folders like Recents/AirDrop) is closed and handed to
 *   `onIntercept({ action: "open", path })`.
 * - `suppressFor(ms)` lets Dazzi's own intentional "Reveal in Finder" action open
 *   a Finder window without the watcher intercepting it back.
 */

export interface MacFinderInterceptEvent {
	readonly action: "open" | "reveal";
	readonly path: string;
}

export interface MacFinderWindowSnapshot {
	readonly id: number;
	readonly path: string | null;
	readonly selectedPath: string | null;
}

export interface MacFinderWatcher {
	isRunning(): boolean;
	start(): void;
	stop(): void;
	/** Suppress interception briefly when Dazzi intentionally opens Finder itself. */
	suppressFor(ms: number): void;
}

/**
 * Converts a Finder `file://` URL (e.g. `file:///Users/a/My%20Folder/`) into a
 * normalized POSIX path (`/Users/a/My Folder`), or null for non-file URLs.
 */
export function fileUrlToMacPath(rawUrl: string): string | null {
	const trimmed = rawUrl.trim();
	if (trimmed === "" || !trimmed.startsWith("file://")) return null;
	try {
		const path = fileURLToPath(trimmed);
		if (path.length > 1 && path.endsWith("/")) {
			return path.slice(0, -1);
		}
		return path;
	} catch {
		return null;
	}
}

/**
 * Pure check for whether a macOS POSIX path opened in a Finder window is a real
 * user folder Dazzi should intercept, versus Trash or internal Finder virtual views
 * (Recents `.cannedSearch`, `.Trash`, `.Trashes`).
 */
export function isInterceptableMacFinderPath(path: string): boolean {
	if (!path.startsWith("/")) return false;
	// Never intercept Trash or per-volume .Trashes folders.
	if (/(?:^|\/)\.Trash(?:es)?(?:\/|$)/u.test(path)) return false;
	// Never intercept Finder's built-in smart folders / Recents (`myDocuments.cannedSearch`, etc.).
	if (path.endsWith(".cannedSearch") || path.includes("/Finder.app/Contents/")) return false;
	return true;
}

/**
 * Builds the JXA snippet that returns `[{ id, url, selectedUrl }]` for all open
 * Finder browser windows (`finderWindows()`), skipping Finder if it is not running
 * so we never force-launch Finder.
 */
export function buildMacFinderPollJxa(): string {
	return `
const Finder = Application("Finder");
function run() {
	if (!Finder.running()) return "[]";
	const wins = Finder.finderWindows();
	const out = [];
	for (let i = 0; i < wins.length; i++) {
		const w = wins[i];
		try {
			const id = w.id();
			let url = "";
			try {
				const t = w.target();
				if (t) url = String(t.url() || "");
			} catch (e) {}
			out.push({ id: id, url: url });
		} catch (e) {}
	}
	return JSON.stringify(out);
}
`.trim();
}

const MAC_CLOSE_WINDOW_JXA = `
const Finder = Application("Finder");
function run(argv) {
	if (!Finder.running()) return "not-running";
	const targetId = Number(argv[0]);
	if (!Number.isFinite(targetId)) return "invalid";
	const wins = Finder.finderWindows();
	for (let i = 0; i < wins.length; i++) {
		const w = wins[i];
		try {
			if (w.id() === targetId) {
				w.close();
				return "closed";
			}
		} catch (e) {}
	}
	return "not-found";
}
`.trim();

export function parseMacFinderPollOutput(raw: string): {
	readonly ok: boolean;
	readonly windows: readonly MacFinderWindowSnapshot[];
} {
	const trimmed = raw.trim();
	if (trimmed === "") return { ok: true, windows: [] };
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (!Array.isArray(parsed)) return { ok: false, windows: [] };
		const windows: MacFinderWindowSnapshot[] = [];
		for (const item of parsed) {
			if (typeof item !== "object" || item === null) continue;
			const { id, url, selectedUrl } = item as { id?: unknown; url?: unknown; selectedUrl?: unknown };
			if (typeof id !== "number" || !Number.isFinite(id)) continue;
			const path = typeof url === "string" ? fileUrlToMacPath(url) : null;
			const selectedPath = typeof selectedUrl === "string" ? fileUrlToMacPath(selectedUrl) : null;
			windows.push({ id, path, selectedPath });
		}
		return { ok: true, windows };
	} catch {
		return { ok: false, windows: [] };
	}
}

function isAutomationPermissionError(message: string): boolean {
	return message.includes("-1743") || /not authorized to send apple events/iu.test(message);
}

export interface MacFinderWatcherDeps {
	readonly platform?: NodeJS.Platform;
	readonly pollIntervalMs?: number;
	readonly onIntercept: (event: MacFinderInterceptEvent) => void;
	readonly onError?: (error: string) => void;
	/** Injectable JXA runner for unit tests; defaults to `/usr/bin/osascript -l JavaScript`. */
	readonly runJxa?: (script: string, args: readonly string[]) => Promise<string>;
}

const DEFAULT_POLL_MS = 220;
const PERMISSION_BACKOFF_MS = 10_000;
const TRANSIENT_ERROR_BACKOFF_MS = 1_500;

export function createMacFinderWatcher(deps: MacFinderWatcherDeps): MacFinderWatcher {
	const platform = deps.platform ?? process.platform;
	const pollIntervalMs = Math.max(80, Math.floor(deps.pollIntervalMs ?? DEFAULT_POLL_MS));
	const pollScript = buildMacFinderPollJxa();
	const runJxa =
		deps.runJxa ??
		(async (script: string, args: readonly string[]) => {
			const { stdout } = await execFileAsync(OSASCRIPT_BIN, ["-l", "JavaScript", "-e", script, ...args], {
				timeout: 3_000,
			});
			return stdout;
		});

	let running = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let inFlight = false;
	let initialized = false;
	let suppressedUntil = 0;
	let lastErrorReported = "";
	const seenIds = new Set<number>();

	const clearTimer = (): void => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	};

	const scheduleNext = (delayMs: number): void => {
		if (!running) return;
		clearTimer();
		timer = setTimeout(() => {
			timer = null;
			void tick();
		}, delayMs);
	};

	const tick = async (): Promise<void> => {
		if (!running || inFlight) return;
		inFlight = true;
		let nextDelay = pollIntervalMs;
		try {
			const stdout = await runJxa(pollScript, []);
			if (!running) return;
			lastErrorReported = "";
			const parsed = parseMacFinderPollOutput(stdout);
			if (!parsed.ok) {
				nextDelay = TRANSIENT_ERROR_BACKOFF_MS;
				return;
			}

			const currentIds = new Set<number>();
			for (const win of parsed.windows) currentIds.add(win.id);

			if (!initialized) {
				for (const id of currentIds) seenIds.add(id);
				initialized = true;
				return;
			}

			const now = Date.now();
			for (const win of parsed.windows) {
				if (seenIds.has(win.id)) continue;
				seenIds.add(win.id);

				if (now < suppressedUntil) continue;
				if (win.path === null || !isInterceptableMacFinderPath(win.path)) continue;

				// Close the intercepted Finder window first so the user lands straight in Dazzi.
				try {
					await runJxa(MAC_CLOSE_WINDOW_JXA, [String(win.id)]);
				} catch {
					// Window may already have been closed by the user.
				}
				if (!running) return;
				if (win.selectedPath !== null && isInterceptableMacFinderPath(win.selectedPath)) {
					deps.onIntercept({ action: "reveal", path: win.selectedPath });
				} else {
					deps.onIntercept({ action: "open", path: win.path });
				}
			}

			// Prune closed window IDs so IDs reused by Finder later are tracked cleanly.
			for (const id of [...seenIds]) {
				if (!currentIds.has(id)) seenIds.delete(id);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message !== lastErrorReported) {
				lastErrorReported = message;
				deps.onError?.(message);
			}
			nextDelay = isAutomationPermissionError(message) ? PERMISSION_BACKOFF_MS : TRANSIENT_ERROR_BACKOFF_MS;
		} finally {
			inFlight = false;
			if (running) scheduleNext(nextDelay);
		}
	};

	const start = (): void => {
		if (platform !== "darwin") return;
		if (running) return;
		running = true;
		initialized = false;
		seenIds.clear();
		lastErrorReported = "";
		// Snapshot existing Finder windows immediately so pre-existing windows are never touched.
		scheduleNext(0);
	};

	const stop = (): void => {
		running = false;
		clearTimer();
		initialized = false;
		seenIds.clear();
	};

	return {
		isRunning: () => running,
		start,
		stop,
		suppressFor: (ms) => {
			suppressedUntil = Math.max(suppressedUntil, Date.now() + ms);
		},
	};
}
