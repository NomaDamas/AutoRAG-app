import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createAppUpdater, manualDownloadUrl, STAGING_TIMEOUT_MS, type UpdateCheckResultLike, type UpdaterLike } from "../src/main/app-updater";
import { cleanupStaleShipItCache, feedUrlFromAppUpdateYml, isDeveloperIdSigned } from "../src/main/app-update-host";
import type { AppUpdateMode, AppUpdateSnapshot } from "../src/shared/update-contract";

/** electron-updater stand-in: `checkForUpdates` plays back the events the real one emits. */
class FakeUpdater extends EventEmitter implements UpdaterLike {
	autoDownload = true;
	autoInstallOnAppQuit = true;
	next: "none" | { version: string } | Error = "none";
	/** With `autoDownload`, the background download fails with this instead of finishing. */
	downloadFailure: Error | null = null;
	downloads = 0;
	/** `autoInstallOnAppQuit` as electron-updater sees it when `downloadUpdate` runs (MacUpdater hands the zip to Squirrel only if it is on). */
	autoInstallDuringDownload: boolean[] = [];
	installs: [boolean | undefined, boolean | undefined][] = [];
	async checkForUpdates(): Promise<UpdateCheckResultLike | null> {
		this.emit("checking-for-update");
		const next = this.next;
		if (next instanceof Error) {
			this.emit("error", next);
			throw next;
		}
		if (next === "none") {
			this.emit("update-not-available", { version: "1.0.0" });
			return null;
		}
		const info = { version: next.version, files: [{ url: `../v${next.version}/Dazzi-${next.version}-arm64.zip` }, { url: `../v${next.version}/Dazzi-${next.version}-arm64.dmg` }] };
		this.emit("update-available", info);
		if (!this.autoDownload) return { updateInfo: info, downloadPromise: null };
		// Like electron-updater: the check resolves now and the download runs on as `downloadPromise`; a failure
		// is emitted as "error" and also rejects that promise.
		const failure = this.downloadFailure;
		const downloadPromise = Promise.resolve().then(() => {
			if (failure !== null) {
				this.emit("error", failure);
				throw failure;
			}
			this.emit("update-downloaded", info);
			return [];
		});
		return { updateInfo: info, downloadPromise };
	}
	/** Optional async gate so a test can interleave events mid-download (e.g. the 30s background check timer). */
	downloadGate: Promise<void> | null = null;
	async downloadUpdate(): Promise<unknown> {
		this.downloads += 1;
		this.autoInstallDuringDownload.push(this.autoInstallOnAppQuit);
		this.emit("download-progress", { percent: 42.4 });
		if (this.downloadGate !== null) await this.downloadGate;
		// MacUpdater checks `autoInstallOnAppQuit` at the END of the download, when deciding whether to hand the zip to Squirrel.Mac.
		this.autoInstallDuringDownload.push(this.autoInstallOnAppQuit);
		if (this.next === "none" || this.next instanceof Error) throw new Error("downloadUpdate without an available update");
		this.emit("update-downloaded", { version: this.next.version });
		return [];
	}
	quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
		this.installs.push([isSilent, isForceRunAfter]);
	}
}

function setup(mode: AppUpdateMode, autoInstall = true, { staged }: { staged?: EventEmitter } = {}) {
	const updater = new FakeUpdater();
	const seen: AppUpdateSnapshot[] = [];
	const opened: string[] = [];
	let auto = autoInstall;
	/** Timers scheduled via setTimeout, keyed in registration order. */
	const timers: { readonly callback: () => void; readonly ms: number; cleared: boolean }[] = [];
	const service = createAppUpdater({
		currentVersion: "1.0.0",
		mode,
		updater,
		feedUrl: "https://dl.example.org/latest/",
		autoInstall: async () => auto,
		openExternal: async (url) => {
			opened.push(url);
		},
		onChange: (snapshot) => seen.push(snapshot),
		log: () => undefined,
		now: () => new Date("2026-10-13T00:00:00.000Z"),
		setTimeout: (callback, ms) => {
			const entry = { callback, ms, cleared: false };
			timers.push(entry);
			return entry as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimeout: (handle) => {
			const entry = handle as unknown as { cleared?: boolean } | undefined;
			if (entry) entry.cleared = true;
		},
		setInterval: () => ({}),
		...(staged === undefined ? {} : { onInstallerStaged: (listener: () => void) => void staged.on("staged", listener) }),
	});
	const fireFirstCheck = (): void => {
		const timer = timers.find((entry) => !entry.cleared && entry.ms === 30_000);
		timer?.callback();
	};
	const fireStagingTimeout = (): void => {
		const timer = timers.find((entry) => !entry.cleared && entry.ms === STAGING_TIMEOUT_MS);
		timer?.callback();
	};
	return { updater, service, seen, opened, setAuto: (value: boolean) => (auto = value), fireFirstCheck, fireStagingTimeout };
}

describe("app updater policy", () => {
	it("install mode with auto-install downloads in the background and installs on quit", async () => {
		const { updater, service } = setup("install");
		updater.next = { version: "1.1.0" };
		const snapshot = await service.check();
		expect(updater.autoDownload).toBe(true);
		expect(updater.autoInstallOnAppQuit).toBe(true);
		expect(snapshot.state).toEqual({ kind: "ready", version: "1.1.0" });
	});

	it("install mode with auto-install off waits for the user, then downloads on request", async () => {
		const { updater, service } = setup("install", false);
		updater.next = { version: "1.1.0" };
		expect((await service.check()).state).toEqual({ kind: "available", version: "1.1.0", downloadUrl: null });
		expect(updater.autoInstallOnAppQuit).toBe(false);
		await service.download();
		expect(updater.downloads).toBe(1);
		expect(service.snapshot().state).toEqual({ kind: "ready", version: "1.1.0" });
	});

	it("a download the user asked for is handed to the platform installer even with auto-install off", async () => {
		const { updater, service } = setup("install", false);
		updater.next = { version: "1.1.0" };
		await service.check();
		expect(updater.autoInstallOnAppQuit).toBe(false);
		await service.download();
		// On macOS electron-updater stages the zip with Squirrel.Mac only when this is on; without it the update never becomes ready.
		expect(updater.autoInstallDuringDownload).toEqual([true, true]);
	});

	it("a background check firing mid-download does not clear autoInstallOnAppQuit before MacUpdater hands the zip to Squirrel", async () => {
		const { updater, service, fireFirstCheck } = setup("install", false);
		updater.next = { version: "1.1.0" };
		service.start();
		await service.check();
		const gate = Promise.withResolvers<void>();
		updater.downloadGate = gate.promise;
		const downloading = service.download();
		// The 30s startup check fires while the manual download is in flight.
		fireFirstCheck();
		await setImmediate();
		// Even an explicit settings re-apply while the user's download is in flight must not turn off staging.
		await service.applySettings();
		gate.resolve();
		await downloading;
		expect(updater.autoInstallDuringDownload).toEqual([true, true]);
		expect(updater.autoInstallOnAppQuit).toBe(true);
	});

	it("a ready update keeps autoInstallOnAppQuit on even if settings are re-applied with auto-install off", async () => {
		const { updater, service } = setup("install", false);
		updater.next = { version: "1.1.0" };
		await service.check();
		await service.download();
		expect(service.snapshot().state).toEqual({ kind: "ready", version: "1.1.0" });
		await service.applySettings();
		expect(updater.autoInstallOnAppQuit).toBe(true);
	});
	it("turning auto-install off takes effect on the next check, not only at launch", async () => {
		const { updater, service, setAuto } = setup("install");
		await service.applySettings();
		expect(updater.autoDownload).toBe(true);
		setAuto(false);
		await service.applySettings();
		expect(updater.autoDownload).toBe(false);
		expect(updater.autoInstallOnAppQuit).toBe(false);
	});

	it("notify mode never downloads and links the dmg resolved against the feed", async () => {
		const { updater, service, opened } = setup("notify");
		updater.next = { version: "1.1.0" };
		const snapshot = await service.check();
		expect(updater.autoDownload).toBe(false);
		expect(snapshot.state).toEqual({ kind: "available", version: "1.1.0", downloadUrl: "https://dl.example.org/v1.1.0/Dazzi-1.1.0-arm64.dmg" });
		await service.download();
		expect(updater.downloads).toBe(0);
		expect(opened).toEqual(["https://dl.example.org/v1.1.0/Dazzi-1.1.0-arm64.dmg"]);
	});

	it("a failed user check is shown as the error", async () => {
		const { updater, service } = setup("install", false);
		updater.next = { version: "1.1.0" };
		await service.check();
		updater.next = new Error("getaddrinfo ENOTFOUND dl.example.org\n    at stack");
		expect((await service.check()).state).toEqual({ kind: "error", message: "getaddrinfo ENOTFOUND dl.example.org" });
	});

	it("a failed background check keeps what was known", async () => {
		const { updater, service, fireFirstCheck } = setup("install", false);
		updater.next = { version: "1.1.0" };
		await service.check();
		updater.next = new Error("offline");
		service.start();
		const failed = once(updater, "error");
		fireFirstCheck();
		await failed;
		expect(service.snapshot().state).toEqual({ kind: "available", version: "1.1.0", downloadUrl: null });
	});

	it("a failed background download is shown as the error and leaves no unhandled rejection", async () => {
		const { updater, service, fireFirstCheck } = setup("install");
		updater.next = { version: "1.1.0" };
		updater.downloadFailure = new Error("ENOSPC: no space left on device, write");
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			service.start();
			const failed = once(updater, "error");
			fireFirstCheck();
			await failed;
			// Node reports unhandled rejections once the microtask queue drains, before the next check phase.
			await setImmediate();
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
		expect(unhandled).toEqual([]);
		expect(service.snapshot().state).toEqual({ kind: "error", message: "ENOSPC: no space left on device, write" });
	});

	it("restart-now installs silently and relaunches, ignores duplicate clicks, and only runs when ready", async () => {
		const { updater, service } = setup("install");
		service.install();
		expect(updater.installs).toEqual([]);
		updater.next = { version: "1.1.0" };
		await service.check();
		service.install();
		service.install();
		expect(updater.installs).toEqual([[true, true]]);
	});

	it("an error emitted after restart-now is surfaced so the user is not stuck on a dead restart button", async () => {
		const squirrel = new EventEmitter();
		const { updater, service } = setup("install", true, { staged: squirrel });
		updater.next = { version: "1.1.0" };
		await service.check();
		squirrel.emit("staged");
		expect(service.snapshot().state).toEqual({ kind: "ready", version: "1.1.0" });
		service.install();
		updater.emit("error", new Error("Could not read update request"));
		expect(service.snapshot().state).toEqual({ kind: "error", message: "Could not read update request" });
		// After a failed install, a fresh download must wait for Squirrel to stage again instead of reusing the stale staged flag.
		await service.download();
		expect(service.snapshot().state).toEqual({ kind: "downloading", version: "1.1.0", percent: 100 });
		squirrel.emit("staged");
		expect(service.snapshot().state).toEqual({ kind: "ready", version: "1.1.0" });
		service.install();
		expect(updater.installs).toEqual([
			[true, true],
			[true, true],
		]);
	});

	it("a downloaded update is not re-checked into another state", async () => {
		const { updater, service } = setup("install");
		updater.next = { version: "1.1.0" };
		await service.check();
		updater.next = "none";
		expect((await service.check()).state).toEqual({ kind: "ready", version: "1.1.0" });
	});

	it("macOS: ready (install on quit / restart now) waits until Squirrel.Mac has staged the download", async () => {
		const squirrel = new EventEmitter();
		const { updater, service } = setup("install", true, { staged: squirrel });
		updater.next = { version: "1.1.0" };
		expect((await service.check()).state).toEqual({ kind: "downloading", version: "1.1.0", percent: 100 });
		service.install();
		expect(updater.installs).toEqual([]);
		squirrel.emit("staged");
		expect(service.snapshot().state).toEqual({ kind: "ready", version: "1.1.0" });
	});

	it("macOS: if Squirrel.Mac never finishes staging within STAGING_TIMEOUT_MS, transitions to error so user is not stuck at 100%", async () => {
		const squirrel = new EventEmitter();
		const { updater, service, fireStagingTimeout } = setup("install", true, { staged: squirrel });
		updater.next = { version: "1.1.0" };
		expect((await service.check()).state).toEqual({ kind: "downloading", version: "1.1.0", percent: 100 });
		fireStagingTimeout();
		expect(service.snapshot().state.kind).toBe("error");
		// After timing out, the user can retry download or check again.
		await service.download();
		expect(service.snapshot().state).toEqual({ kind: "downloading", version: "1.1.0", percent: 100 });
		squirrel.emit("staged");
		expect(service.snapshot().state).toEqual({ kind: "ready", version: "1.1.0" });
	});

	it("a newer version published after an earlier version became ready supersedes the stale ready state on check", async () => {
		const squirrel = new EventEmitter();
		const { updater, service } = setup("install", false, { staged: squirrel });
		updater.next = { version: "1.1.0" };
		await service.check();
		await service.download();
		squirrel.emit("staged");
		expect(service.snapshot().state).toEqual({ kind: "ready", version: "1.1.0" });

		// If the feed still reports 1.1.0 (or no update), stay ready for 1.1.0.
		expect((await service.check()).state).toEqual({ kind: "ready", version: "1.1.0" });

		// Once 1.2.0 is published, check() discovers it instead of staying stuck on 1.1.0 forever.
		updater.next = { version: "1.2.0" };
		expect((await service.check()).state).toEqual({ kind: "available", version: "1.2.0", downloadUrl: null });
	});
});

describe("stale ShipIt cache recovery", () => {
	it("removes a macOS ShipIt cache directory when ShipIt_stderr.log records a failed installation and no ShipIt is active", async () => {
		const cachesDir = await mkdtemp(join(tmpdir(), "dazzi-shipit-test-"));
		try {
			const shipItDir = join(cachesDir, "com.autorag.app.ShipIt");
			await mkdir(join(shipItDir, "update.AbCdEf"), { recursive: true });
			await writeFile(
				join(shipItDir, "ShipIt_stderr.log"),
				"2026-11-24 17:56:25.271 ShipIt[20982:1] Installation error: Error Domain=SQRLInstallerErrorDomain Code=-1\n2026-11-24 17:56:25.311 ShipIt[20982:1] ShipIt quitting\n",
			);
			const logs: string[] = [];
			const cleaned = await cleanupStaleShipItCache({
				cachesDir,
				bundleId: "com.autorag.app",
				isShipItRunning: async () => false,
				log: (line) => logs.push(line),
			});
			expect(cleaned).toBe(true);
			expect(logs.some((line) => line.includes("ShipIt"))).toBe(true);
		} finally {
			await rm(cachesDir, { recursive: true, force: true });
		}
	});

	it("keeps a ShipIt cache when ShipIt is currently running or when the log shows a clean install", async () => {
		const cachesDir = await mkdtemp(join(tmpdir(), "dazzi-shipit-clean-"));
		try {
			const shipItDir = join(cachesDir, "com.autorag.app.ShipIt");
			await mkdir(shipItDir, { recursive: true });
			await writeFile(join(shipItDir, "ShipIt_stderr.log"), "2026-11-23 19:10:15 ShipIt[1:1] Installation completed successfully\n");
			const cleanedHealthy = await cleanupStaleShipItCache({
				cachesDir,
				bundleId: "com.autorag.app",
				isShipItRunning: async () => false,
				log: () => undefined,
			});
			expect(cleanedHealthy).toBe(false);

			await writeFile(join(shipItDir, "ShipIt_stderr.log"), "Installation error: failed\n");
			const cleanedWhileRunning = await cleanupStaleShipItCache({
				cachesDir,
				bundleId: "com.autorag.app",
				isShipItRunning: async () => true,
				log: () => undefined,
			});
			expect(cleanedWhileRunning).toBe(false);
		} finally {
			await rm(cachesDir, { recursive: true, force: true });
		}
	});
});

describe("update host parsing", () => {
	it("reads the generic feed url from app-update.yml", () => {
		expect(feedUrlFromAppUpdateYml("provider: generic\nurl: https://dl.nomadamas.org/latest/\nuseMultipleRangeRequest: false\nupdaterCacheDirName: dazzi-updater\n")).toBe("https://dl.nomadamas.org/latest/");
		expect(feedUrlFromAppUpdateYml("provider: generic\nupdaterCacheDirName: dazzi-updater\n")).toBeNull();
	});

	it("treats only a Team-ID signature as installable", () => {
		expect(isDeveloperIdSigned("Executable=/A.app/Contents/MacOS/A\nAuthority=Developer ID Application: X (M23FFWRBMY)\nTeamIdentifier=M23FFWRBMY\n")).toBe(true);
		expect(isDeveloperIdSigned("Executable=/A.app/Contents/MacOS/A\nSignature=adhoc\nTeamIdentifier=not set\n")).toBe(false);
		expect(isDeveloperIdSigned("code object is not signed at all\n")).toBe(false);
	});

	it("manual download prefers the dmg and falls back to the first file", () => {
		expect(manualDownloadUrl({ version: "2.0.0", files: [{ url: "Dazzi-2.0.0-arm64.zip" }] }, "https://dl.example.org/v2.0.0")).toBe("https://dl.example.org/v2.0.0/Dazzi-2.0.0-arm64.zip");
		expect(manualDownloadUrl({ version: "2.0.0", files: [] }, "https://dl.example.org/latest/")).toBeNull();
	});
});
