import { EventEmitter } from "node:events";
import type { AppUpdateMode, AppUpdateSnapshot, AppUpdateState } from "../shared/update-contract";

/**
 * The app's self-update loop on top of electron-updater (see
 * `docs/release.md` → "Auto-update"). This module owns the policy; the
 * electron-updater instance, the clock, and the browser hand-off are injected,
 * so the policy is testable without a packaged app.
 *
 * Policy:
 * - One check shortly after launch, then every {@link CHECK_INTERVAL_MS}.
 * - Install mode with "업데이트 자동 설치" on: download in the background and
 *   apply when the app quits. Off: report the version and wait for the user.
 * - Notify mode never downloads: it links the installer from the feed.
 * - A failed background check keeps the previous state (the feed being briefly
 *   unreachable is not news); a failed user-initiated check is shown.
 */

export const FIRST_CHECK_DELAY_MS = 30_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The slice of electron-updater's `AppUpdater` this module drives. */
export interface UpdaterLike extends EventEmitter {
	autoDownload: boolean;
	autoInstallOnAppQuit: boolean;
	checkForUpdates(): Promise<unknown>;
	downloadUpdate(): Promise<unknown>;
	quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

interface UpdateInfoLike {
	readonly version: string;
	readonly files?: readonly { readonly url: string }[];
}

export interface AppUpdaterDeps {
	readonly currentVersion: string;
	readonly mode: AppUpdateMode;
	readonly updater: UpdaterLike;
	/** The feed directory URL (`app-update.yml` → `url`); notify mode resolves installer links against it. */
	readonly feedUrl: string;
	readonly autoInstall: () => Promise<boolean>;
	readonly openExternal: (url: string) => Promise<void>;
	readonly onChange: (snapshot: AppUpdateSnapshot) => void;
	readonly log: (line: string) => void;
	/**
	 * macOS: Squirrel.Mac stages the downloaded zip some seconds after electron-updater reports it
	 * downloaded, and installs on quit only once staged. When given, `ready` waits for this signal.
	 */
	readonly onInstallerStaged?: (listener: () => void) => void;
	readonly setInterval?: (callback: () => void, ms: number) => { unref?: () => void };
	readonly setTimeout?: (callback: () => void, ms: number) => { unref?: () => void };
	readonly now?: () => Date;
}

export interface AppUpdaterService {
	snapshot(): AppUpdateSnapshot;
	/** User-initiated check: errors become the visible state. */
	check(): Promise<AppUpdateSnapshot>;
	download(): Promise<void>;
	install(): void;
	/** Re-read "업데이트 자동 설치" (call after settings change). */
	applySettings(): Promise<void>;
	/** Arm the first check and the interval. */
	start(): void;
}

/** The installer a notify-mode user downloads by hand: the feed's `.dmg`, else its first file. */
export function manualDownloadUrl(info: UpdateInfoLike, feedUrl: string): string | null {
	const files = info.files ?? [];
	const file = files.find((entry) => entry.url.endsWith(".dmg")) ?? files.find((entry) => entry.url.endsWith(".exe")) ?? files[0];
	if (file === undefined) return null;
	const base = feedUrl.endsWith("/") ? feedUrl : `${feedUrl}/`;
	return new URL(file.url, base).href;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message.split("\n")[0] ?? error.message;
	return String(error);
}

export function createAppUpdater(deps: AppUpdaterDeps): AppUpdaterService {
	const { updater, mode } = deps;
	const now = deps.now ?? (() => new Date());
	let state: AppUpdateState = { kind: "idle", checkedAt: null };
	let lastCheckedAt: string | null = null;
	let available: UpdateInfoLike | null = null;
	/** True while a user-initiated check runs: only then does a failure replace the state. */
	let userCheck = false;
	let started = false;
	/** The version electron-updater downloaded, and whether the platform installer has staged it. */
	let downloaded: string | null = null;
	let staged = deps.onInstallerStaged === undefined;

	const snapshot = (): AppUpdateSnapshot => ({ currentVersion: deps.currentVersion, mode, state });
	const set = (next: AppUpdateState): void => {
		state = next;
		deps.onChange(snapshot());
	};

	updater.on("checking-for-update", () => {
		if (state.kind !== "downloading" && state.kind !== "ready") set({ kind: "checking" });
	});
	updater.on("update-not-available", () => {
		lastCheckedAt = now().toISOString();
		available = null;
		set({ kind: "idle", checkedAt: lastCheckedAt });
	});
	updater.on("update-available", (info: UpdateInfoLike) => {
		lastCheckedAt = now().toISOString();
		available = info;
		const downloadUrl = mode === "notify" ? manualDownloadUrl(info, deps.feedUrl) : null;
		// With autoDownload on, electron-updater starts downloading right after this event.
		set(updater.autoDownload ? { kind: "downloading", version: info.version, percent: 0 } : { kind: "available", version: info.version, downloadUrl });
	});
	updater.on("download-progress", (progress: { percent: number }) => {
		const version = available?.version ?? (state.kind === "downloading" ? state.version : "");
		set({ kind: "downloading", version, percent: Math.max(0, Math.min(100, Math.round(progress.percent))) });
	});
	const markReady = (): void => {
		if (downloaded !== null && staged) set({ kind: "ready", version: downloaded });
	};
	updater.on("update-downloaded", (info: UpdateInfoLike) => {
		downloaded = info.version;
		// Not yet installable on macOS: hold at 100% until Squirrel.Mac has staged it.
		if (!staged) set({ kind: "downloading", version: info.version, percent: 100 });
		markReady();
	});
	deps.onInstallerStaged?.(() => {
		staged = true;
		markReady();
	});
	updater.on("error", (error: unknown) => {
		deps.log(`error: ${errorMessage(error)}`);
		if (state.kind === "downloading") {
			set({ kind: "error", message: errorMessage(error) });
			return;
		}
		if (userCheck) {
			set({ kind: "error", message: errorMessage(error) });
			return;
		}
		// Background failure: fall back to what was true before the check started.
		if (state.kind === "checking") set(available === null ? { kind: "idle", checkedAt: lastCheckedAt } : { kind: "available", version: available.version, downloadUrl: mode === "notify" ? manualDownloadUrl(available, deps.feedUrl) : null });
	});

	const applySettings = async (): Promise<void> => {
		const auto = await deps.autoInstall();
		updater.autoDownload = mode === "install" && auto;
		updater.autoInstallOnAppQuit = mode === "install" && auto;
	};

	const runCheck = async (fromUser: boolean): Promise<void> => {
		if (state.kind === "checking" || state.kind === "downloading" || state.kind === "ready") return;
		userCheck = fromUser;
		try {
			await updater.checkForUpdates();
		} catch {
			// Reported through the "error" event.
		} finally {
			userCheck = false;
		}
	};

	return {
		snapshot,
		check: async () => {
			await applySettings();
			await runCheck(true);
			return snapshot();
		},
		download: async () => {
			if (state.kind !== "available" && state.kind !== "error") return;
			if (mode === "notify") {
				const url = state.kind === "available" ? state.downloadUrl : null;
				if (url !== null) await deps.openExternal(url);
				return;
			}
			if (available === null) return;
			set({ kind: "downloading", version: available.version, percent: 0 });
			try {
				await updater.downloadUpdate();
			} catch {
				// Reported through the "error" event.
			}
		},
		install: () => {
			if (state.kind !== "ready") return;
			deps.log(`install ${state.version} on user request`);
			// Silent installer, relaunch afterwards (NSIS); Squirrel.Mac relaunches by itself.
			updater.quitAndInstall(true, true);
		},
		applySettings,
		start: () => {
			if (started) return;
			started = true;
			const later = deps.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
			const every = deps.setInterval ?? ((callback: () => void, ms: number) => setInterval(callback, ms));
			const backgroundCheck = (): void => void applySettings().then(() => runCheck(false));
			later(backgroundCheck, FIRST_CHECK_DELAY_MS).unref?.();
			every(backgroundCheck, CHECK_INTERVAL_MS).unref?.();
		},
	};
}
