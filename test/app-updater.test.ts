import { EventEmitter, once } from "node:events";
import { describe, expect, it } from "vitest";
import { createAppUpdater, manualDownloadUrl, type UpdaterLike } from "../src/main/app-updater";
import { feedUrlFromAppUpdateYml, isDeveloperIdSigned } from "../src/main/app-update-host";
import type { AppUpdateMode, AppUpdateSnapshot } from "../src/shared/update-contract";

/** electron-updater stand-in: `checkForUpdates` plays back the events the real one emits. */
class FakeUpdater extends EventEmitter implements UpdaterLike {
	autoDownload = true;
	autoInstallOnAppQuit = true;
	next: "none" | { version: string } | Error = "none";
	downloads = 0;
	installs: [boolean | undefined, boolean | undefined][] = [];
	async checkForUpdates(): Promise<unknown> {
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
		if (this.autoDownload) this.emit("update-downloaded", info);
		return info;
	}
	async downloadUpdate(): Promise<unknown> {
		this.downloads += 1;
		this.emit("download-progress", { percent: 42.4 });
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
	/** The first-check timer start() arms; tests fire it by hand instead of waiting. */
	let firstCheck: () => void = () => undefined;
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
		setTimeout: (callback) => {
			firstCheck = callback;
			return {};
		},
		setInterval: () => ({}),
		...(staged === undefined ? {} : { onInstallerStaged: (listener: () => void) => void staged.on("staged", listener) }),
	});
	return { updater, service, seen, opened, setAuto: (value: boolean) => (auto = value), fireFirstCheck: () => firstCheck() };
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

	it("restart-now installs silently and relaunches, and only when an update is ready", async () => {
		const { updater, service } = setup("install");
		service.install();
		expect(updater.installs).toEqual([]);
		updater.next = { version: "1.1.0" };
		await service.check();
		service.install();
		expect(updater.installs).toEqual([[true, true]]);
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
