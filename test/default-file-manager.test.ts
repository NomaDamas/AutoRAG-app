import { describe, expect, it } from "vitest";
import {
	isDefaultFileManagerApplyRequest,
	isWindowsVirtualShellPath,
} from "../src/shared/default-file-manager-contract";
import {
	createDefaultFileManagerService,
	MAC_DAZZI_BUNDLE_ID,
	MAC_FINDER_BUNDLE_ID,
	parseExternalOpenArgv,
	WIN_EXPLORER_CLSID,
	winDefaultManagerInstallCommands,
	winDefaultManagerUninstallCommands,
	winFolderOpenCommand,
	winNewWindowCommand,
} from "../src/main/default-file-manager";

describe("default-file-manager contract", () => {
	it("distinguishes real Windows filesystem paths from virtual shell namespace targets", () => {
		expect(isWindowsVirtualShellPath("C:\\Users\\jeffrey\\Documents")).toBe(false);
		expect(isWindowsVirtualShellPath("D:\\")).toBe(false);
		expect(isWindowsVirtualShellPath("D:")).toBe(false);
		expect(isWindowsVirtualShellPath("\\\\fileserver\\share\\folder")).toBe(false);
		expect(isWindowsVirtualShellPath("::{20D04FE0-3AEA-1069-A2D8-08002B30309D}")).toBe(true);
		expect(isWindowsVirtualShellPath("::{F02C1A0D-BE21-4350-88B0-7367FC96EF3C}")).toBe(true);
		expect(isWindowsVirtualShellPath("shell:ControlPanelFolder")).toBe(true);
		expect(isWindowsVirtualShellPath("search-ms:query=report")).toBe(true);
		expect(isWindowsVirtualShellPath("")).toBe(true);
		expect(isWindowsVirtualShellPath("   ")).toBe(true);
	});

	it("validates apply request payloads", () => {
		expect(isDefaultFileManagerApplyRequest({ enabled: true })).toBe(true);
		expect(isDefaultFileManagerApplyRequest({ enabled: true, interceptReveal: true })).toBe(true);
		expect(isDefaultFileManagerApplyRequest({ enabled: false, interceptReveal: false })).toBe(true);
		expect(isDefaultFileManagerApplyRequest({ enabled: "yes" })).toBe(false);
		expect(isDefaultFileManagerApplyRequest({ enabled: true, interceptReveal: "yes" })).toBe(false);
		expect(isDefaultFileManagerApplyRequest(null)).toBe(false);
	});
});

describe("parseExternalOpenArgv", () => {
	it("extracts bare folder/file paths from OS open invocations while ignoring Electron/app flags", () => {
		expect(
			parseExternalOpenArgv(["/Applications/Dazzi.app/Contents/MacOS/Dazzi", "--user-data-dir=/tmp/ud", "/Users/a/Documents"], {
				isPackaged: true,
				platform: "darwin",
			}),
		).toEqual({ kind: "paths", paths: ["/Users/a/Documents"] });

		expect(
			parseExternalOpenArgv(["C:\\Apps\\Dazzi\\Dazzi.exe", "C:\\Users\\a\\Documents"], {
				isPackaged: true,
				platform: "win32",
			}),
		).toEqual({ kind: "paths", paths: ["C:\\Users\\a\\Documents"] });
	});

	it("fixes trailing quotes left by Windows drive-root escaping (D:\\\")", () => {
		expect(
			parseExternalOpenArgv(["C:\\Apps\\Dazzi\\Dazzi.exe", '--autorag-default-open', 'D:\\"'], {
				isPackaged: true,
				platform: "win32",
			}),
		).toEqual({ kind: "paths", paths: ["D:\\"] });
	});

	it("returns fallback-explorer for Windows virtual shell namespace targets", () => {
		expect(
			parseExternalOpenArgv(["C:\\Apps\\Dazzi\\Dazzi.exe", "--autorag-default-open", "::{20D04FE0-3AEA-1069-A2D8-08002B30309D}"], {
				isPackaged: true,
				platform: "win32",
			}),
		).toEqual({ kind: "fallback-explorer", rawTarget: "::{20D04FE0-3AEA-1069-A2D8-08002B30309D}" });
	});

	it("recognizes Win+E new-window launches (--autorag-new-window)", () => {
		expect(
			parseExternalOpenArgv(["C:\\Apps\\Dazzi\\Dazzi.exe", "--autorag-new-window"], {
				isPackaged: true,
				platform: "win32",
			}),
		).toEqual({ kind: "new-window" });
	});

	it("ignores unpackaged app entry directory (including relative '.') as a target path", () => {
		expect(
			parseExternalOpenArgv(["/path/to/Electron", "/Volumes/SSD1/4/AutoRAG-app", "--user-data-dir=/tmp/ud"], {
				isPackaged: false,
				platform: "darwin",
				appPath: "/Volumes/SSD1/4/AutoRAG-app",
			}),
		).toBeNull();
		expect(
			parseExternalOpenArgv(["C:\\app\\node_modules\\electron\\dist\\electron.exe", ".", "--user-data-dir=C:\\tmp\\ud"], {
				isPackaged: false,
				platform: "win32",
				appPath: "C:\\dev\\dazzi-qa\\app",
			}),
		).toBeNull();
		expect(
			parseExternalOpenArgv(["C:\\app\\node_modules\\electron\\dist\\electron.exe", "out\\main\\index.js", "--user-data-dir=C:\\tmp\\ud"], {
				isPackaged: false,
				platform: "win32",
				appPath: "C:\\dev\\dazzi-qa\\app",
			}),
		).toBeNull();
	});

	it("ignores launches already carrying --autorag-request= flags", () => {
		expect(
			parseExternalOpenArgv(["C:\\Apps\\Dazzi\\Dazzi.exe", "--autorag-request=open", "--autorag-path=C:\\Users\\a"], {
				isPackaged: true,
				platform: "win32",
			}),
		).toBeNull();
	});
});

describe("Windows registry commands", () => {
	const deps = {
		execPath: "C:\\Users\\jeffrey\\AppData\\Local\\Programs\\Dazzi\\Dazzi.exe",
		appArgs: [] as readonly string[],
	};

	it("builds safe per-user HKCU commands for Folder, Directory, and Win+E CLSID", () => {
		const calls = winDefaultManagerInstallCommands(deps);
		const keys = calls.map((args) => args[1]);
		expect(keys.every((k) => k?.startsWith("HKCU\\Software\\Classes\\"))).toBe(true);
		expect(keys).toContain("HKCU\\Software\\Classes\\Folder\\shell\\open\\command");
		expect(keys).toContain("HKCU\\Software\\Classes\\Directory\\shell\\open\\command");
		expect(keys).toContain(`HKCU\\Software\\Classes\\CLSID\\${WIN_EXPLORER_CLSID}\\shell\\opennewwindow\\command`);
		expect(winFolderOpenCommand(deps.execPath, deps.appArgs)).toBe(
			`"${deps.execPath}" --autorag-default-open "%1"`,
		);
		expect(winNewWindowCommand(deps.execPath, deps.appArgs)).toBe(
			`"${deps.execPath}" --autorag-new-window`,
		);
	});

	it("clears DelegateExecute so Windows does not bypass open/command and restores cleanly on uninstall", () => {
		const install = winDefaultManagerInstallCommands(deps);
		expect(install).toContainEqual([
			"add",
			"HKCU\\Software\\Classes\\Folder\\shell\\open\\command",
			"/v",
			"DelegateExecute",
			"/d",
			"",
			"/f",
		]);
		expect(install).toContainEqual([
			"add",
			`HKCU\\Software\\Classes\\CLSID\\${WIN_EXPLORER_CLSID}\\shell\\opennewwindow\\command`,
			"/v",
			"DelegateExecute",
			"/d",
			"",
			"/f",
		]);

		const uninstall = winDefaultManagerUninstallCommands();
		expect(uninstall).toContainEqual(["delete", "HKCU\\Software\\Classes\\Folder\\shell\\open", "/f"]);
		expect(uninstall).toContainEqual(["delete", "HKCU\\Software\\Classes\\Directory\\shell\\open", "/f"]);
		expect(uninstall).toContainEqual(["delete", `HKCU\\Software\\Classes\\CLSID\\${WIN_EXPLORER_CLSID}`, "/f"]);
	});
});

describe("createDefaultFileManagerService (macOS)", () => {
	it("writes NSFileViewer and LaunchServices public.folder handler on enable, and restores Finder on disable", async () => {
		const runs: { cmd: string; args: readonly string[] }[] = [];
		let nsFileViewer = "";
		let lsFolderHandler = MAC_FINDER_BUNDLE_ID;

		const service = createDefaultFileManagerService({
			platform: "darwin",
			isPackaged: true,
			execPath: "/Applications/Dazzi.app/Contents/MacOS/Dazzi",
			appArgs: [],
			bundleId: MAC_DAZZI_BUNDLE_ID,
			macRevealHookLoaded: true,
			run: async (cmd, args) => {
				runs.push({ cmd, args });
				if (cmd === "/usr/bin/defaults" && args[0] === "read" && args[1] === "-g" && args[2] === "NSFileViewer") {
					if (nsFileViewer === "") throw new Error("does not exist");
					return `${nsFileViewer}\n`;
				}
				if (cmd === "/usr/bin/defaults" && args[0] === "write" && args[1] === "-g" && args[2] === "NSFileViewer") {
					nsFileViewer = args[4] ?? "";
					return "";
				}
				if (cmd === "/usr/bin/defaults" && args[0] === "delete" && args[1] === "-g" && args[2] === "NSFileViewer") {
					nsFileViewer = "";
					return "";
				}
				if (cmd === "/usr/bin/osascript" && args[0] === "-l" && args[1] === "JavaScript") {
					const script = args[3] ?? "";
					if (script.includes("LSSetDefaultRoleHandlerForContentType")) {
						lsFolderHandler = args[4] ?? lsFolderHandler;
						return "0\n";
					}
					return `${lsFolderHandler}\n`;
				}
				return "";
			},
		});

		const initial = await service.status({ enabled: false, interceptReveal: false });
		expect(initial.supported).toBe(true);
		expect(initial.osRegistered).toBe(false);
		expect(initial.macRevealHookLoaded).toBe(true);
		expect(initial.interceptReveal).toBe(false);
		expect(initial.interceptRevealActive).toBe(false);

		const enabled = await service.apply({ enabled: true, interceptReveal: false });
		expect(enabled.enabled).toBe(true);
		expect(enabled.osRegistered).toBe(true);
		expect(nsFileViewer).toBe(MAC_DAZZI_BUNDLE_ID);
		expect(lsFolderHandler).toBe(MAC_DAZZI_BUNDLE_ID);

		const disabled = await service.apply({ enabled: false, interceptReveal: false });
		expect(disabled.enabled).toBe(false);
		expect(disabled.osRegistered).toBe(false);
		expect(nsFileViewer).toBe("");
		expect(lsFolderHandler).toBe(MAC_FINDER_BUNDLE_ID);
	});

	it("starts and stops the macOS Finder window watcher when interceptReveal is toggled", async () => {
		let watcherRunning = false;
		const watcherEvents: string[] = [];
		let nsFileViewer = "";
		let lsFolderHandler = MAC_FINDER_BUNDLE_ID;

		const service = createDefaultFileManagerService({
			platform: "darwin",
			isPackaged: true,
			execPath: "/Applications/Dazzi.app/Contents/MacOS/Dazzi",
			appArgs: [],
			bundleId: MAC_DAZZI_BUNDLE_ID,
			macRevealHookLoaded: true,
			macWatcher: {
				isRunning: () => watcherRunning,
				start: () => {
					watcherRunning = true;
					watcherEvents.push("start");
				},
				stop: () => {
					watcherRunning = false;
					watcherEvents.push("stop");
				},
			},
			run: async (cmd, args) => {
				if (cmd === "/usr/bin/defaults" && args[0] === "read") {
					if (nsFileViewer === "") throw new Error("missing");
					return `${nsFileViewer}\n`;
				}
				if (cmd === "/usr/bin/defaults" && args[0] === "write") {
					nsFileViewer = args[4] ?? "";
					return "";
				}
				if (cmd === "/usr/bin/defaults" && args[0] === "delete") {
					nsFileViewer = "";
					return "";
				}
				if (cmd === "/usr/bin/osascript") {
					const script = args[3] ?? "";
					if (script.includes("LSSetDefaultRoleHandlerForContentType")) {
						lsFolderHandler = args[4] ?? lsFolderHandler;
						return "0\n";
					}
					return `${lsFolderHandler}\n`;
				}
				return "";
			},
		});

		const enabledWithIntercept = await service.apply({ enabled: true, interceptReveal: true });
		expect(enabledWithIntercept.enabled).toBe(true);
		expect(enabledWithIntercept.osRegistered).toBe(true);
		expect(enabledWithIntercept.interceptReveal).toBe(true);
		expect(enabledWithIntercept.interceptRevealActive).toBe(true);
		expect(watcherEvents).toEqual(["start"]);

		const interceptOff = await service.apply({ enabled: true, interceptReveal: false });
		expect(interceptOff.interceptReveal).toBe(false);
		expect(interceptOff.interceptRevealActive).toBe(false);
		expect(watcherEvents).toEqual(["start", "stop"]);

		const interceptBackOn = await service.apply({ enabled: true, interceptReveal: true });
		expect(interceptBackOn.interceptRevealActive).toBe(true);

		const allOff = await service.apply({ enabled: false, interceptReveal: true });
		expect(allOff.enabled).toBe(false);
		expect(allOff.interceptRevealActive).toBe(false);
		expect(watcherEvents).toEqual(["start", "stop", "start", "stop"]);

		// Startup sync starts the macOS watcher when packaged and both flags are enabled.
		await service.syncOnStartup({ enabled: true, interceptReveal: true });
		expect(watcherRunning).toBe(true);

		// Dispose always stops the macOS watcher.
		service.dispose();
		expect(watcherRunning).toBe(false);
	});
});

describe("createDefaultFileManagerService (Windows)", () => {
	it("registers HKCU folder + Win+E handlers and starts/stops the Explorer reveal interceptor", async () => {
		const registry = new Map<string, string>();
		let watcherRunning = false;
		const watcherEvents: string[] = [];

		const service = createDefaultFileManagerService({
			platform: "win32",
			isPackaged: true,
			execPath: "C:\\Apps\\Dazzi\\Dazzi.exe",
			appArgs: [],
			run: async (cmd, args) => {
				if (cmd !== "reg.exe") return "";
				const op = args[0];
				const key = args[1] ?? "";
				if (op === "add") {
					const valIdx = args.indexOf("/d");
					const vIdx = args.indexOf("/v");
					const prop = vIdx >= 0 ? args[vIdx + 1] : "(Default)";
					registry.set(`${key}::${prop}`, valIdx >= 0 ? (args[valIdx + 1] ?? "") : "");
					return "";
				}
				if (op === "delete") {
					for (const k of [...registry.keys()]) {
						if (k.startsWith(key)) registry.delete(k);
					}
					return "";
				}
				if (op === "query") {
					const val = registry.get(`${key}::(Default)`);
					if (val === undefined) throw new Error("ERROR: The system was unable to find the specified registry key or value.");
					return `\r\n${key}\r\n    (Default)    REG_SZ    ${val}\r\n`;
				}
				return "";
			},
			windowsWatcher: {
				isRunning: () => watcherRunning,
				start: () => {
					watcherRunning = true;
					watcherEvents.push("start");
				},
				stop: () => {
					watcherRunning = false;
					watcherEvents.push("stop");
				},
			},
		});

		const before = await service.status({ enabled: false, interceptReveal: false });
		expect(before.supported).toBe(true);
		expect(before.osRegistered).toBe(false);
		expect(before.interceptRevealActive).toBe(false);

		const afterEnable = await service.apply({ enabled: true, interceptReveal: true });
		expect(afterEnable.enabled).toBe(true);
		expect(afterEnable.osRegistered).toBe(true);
		expect(afterEnable.interceptReveal).toBe(true);
		expect(afterEnable.interceptRevealActive).toBe(true);
		expect(watcherEvents).toEqual(["start"]);

		const afterWatcherOff = await service.apply({ enabled: true, interceptReveal: false });
		expect(afterWatcherOff.osRegistered).toBe(true);
		expect(afterWatcherOff.interceptReveal).toBe(false);
		expect(afterWatcherOff.interceptRevealActive).toBe(false);
		expect(watcherEvents).toEqual(["start", "stop"]);

		const afterDisable = await service.apply({ enabled: false, interceptReveal: false });
		expect(afterDisable.enabled).toBe(false);
		expect(afterDisable.osRegistered).toBe(false);
		expect(afterDisable.interceptRevealActive).toBe(false);
		expect(registry.size).toBe(0);
	});
});
