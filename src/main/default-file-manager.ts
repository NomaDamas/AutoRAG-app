import {
	isWindowsVirtualShellPath,
	type DefaultFileManagerApplyRequest,
	type DefaultFileManagerPlatform,
	type DefaultFileManagerStatus,
} from "../shared/default-file-manager-contract";
import { OS_REQUEST_FLAG } from "../shared/os-request-contract";

/**
 * Default file manager integration for macOS and Windows.
 *
 * macOS:
 *   - Writes global `NSFileViewer` to Dazzi's bundle ID (`com.autorag.app`) so
 *     apps calling `NSWorkspace.activateFileViewerSelectingURLs:` / `selectFile:`
 *     route "Reveal in Finder" to Dazzi (received via `mac-reveal-hook.ts`).
 *   - Sets LaunchServices default role handler for `public.folder` to Dazzi's
 *     bundle ID so `open /path/to/dir` and folder-open actions route to Dazzi
 *     (received via Electron `app.on("open-file")`).
 *   - Restores Finder (`com.apple.finder`) and deletes `NSFileViewer` on disable.
 *
 * Windows:
 *   - Registers per-user (no UAC) `HKCU\Software\Classes\Folder\shell\open\command`
 *     and `Directory\shell\open\command` (with empty `DelegateExecute` so Explorer
 *     honors the command), passing `--autorag-default-open "%1"`.
 *   - Registers `HKCU\Software\Classes\CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}\shell\opennewwindow\command`
 *     so pressing `Win+E` opens Dazzi (`--autorag-new-window`).
 *   - Virtual shell namespace paths (`::{CLSID}`, `shell:`, Control Panel, etc.)
 *     are detected via {@link isWindowsVirtualShellPath} and safely forwarded
 *     back to `explorer.exe`.
 *   - Optional `interceptReveal` toggles the background `Shell.Application`
 *     Explorer window watcher (`windows-explorer-watcher.ts`) so `SHOpenFolderAndSelectItems`
 *     calls (Chrome, VS Code, Slack) are also handed to Dazzi.
 *   - Disabling deletes all HKCU keys we wrote, immediately restoring Windows File Explorer.
 */

export const MAC_DAZZI_BUNDLE_ID = "com.autorag.app";
export const MAC_FINDER_BUNDLE_ID = "com.apple.finder";
export const WIN_EXPLORER_CLSID = "{52205fd8-5dfb-447d-801a-d0b52f2e83e1}";
export const DEFAULT_OPEN_FLAG = "--autorag-default-open";
export const NEW_WINDOW_FLAG = "--autorag-new-window";

const DEFAULTS_BIN = "/usr/bin/defaults";
const OSASCRIPT_BIN = "/usr/bin/osascript";

/** JXA script reading LaunchServices default role handler for `public.folder`. */
const MAC_GET_FOLDER_HANDLER_JXA = `
ObjC.import("CoreServices");
function run() {
	const handler = $.LSCopyDefaultRoleHandlerForContentType($("public.folder"), $.kLSRolesAll);
	return handler.isNil() ? "" : ObjC.unwrap(handler);
}
`.trim();

/** JXA script setting LaunchServices default role handler for `public.folder` to argv[0]. */
const MAC_SET_FOLDER_HANDLER_JXA = `
ObjC.import("CoreServices");
function run(argv) {
	const bundleId = argv[0];
	if (!bundleId) return "-1";
	const status = $.LSSetDefaultRoleHandlerForContentType($("public.folder"), $.kLSRolesAll, $(bundleId));
	return String(status);
}
`.trim();

export type ExternalOpenResult =
	| { readonly kind: "paths"; readonly paths: readonly string[] }
	| { readonly kind: "fallback-explorer"; readonly rawTarget: string }
	| { readonly kind: "new-window" };

/**
 * Parses argv from an OS default-file-manager launch (`--autorag-default-open <target>`,
 * `--autorag-new-window`, or bare path arguments). Returns null when the launch is
 * an ordinary app start or already handled by `--autorag-request=`.
 */
export function parseExternalOpenArgv(
	argv: readonly string[],
	options: {
		readonly isPackaged: boolean;
		readonly platform: NodeJS.Platform;
		readonly appPath?: string;
	},
): ExternalOpenResult | null {
	// Menu/CLI requests carry `--autorag-request=` and are handled by `parseOsRequestArgv`.
	if (argv.some((arg) => arg.startsWith(OS_REQUEST_FLAG))) return null;

	const args = argv.slice(1);
	if (args.includes(NEW_WINDOW_FLAG)) {
		return { kind: "new-window" };
	}

	const defaultOpenIndex = args.indexOf(DEFAULT_OPEN_FLAG);
	if (defaultOpenIndex >= 0) {
		const raw = args[defaultOpenIndex + 1] ?? "";
		// Windows passes `"D:\"` with an escaped trailing quote in argv; strip stray trailing `"`.
		const cleaned = raw.endsWith('"') ? raw.slice(0, -1) : raw;
		if (options.platform === "win32" && isWindowsVirtualShellPath(cleaned)) {
			return { kind: "fallback-explorer", rawTarget: cleaned };
		}
		return cleaned.length > 0 ? { kind: "paths", paths: [cleaned] } : null;
	}

	// Bare positional path arguments (for example double-clicking/opening a folder directly with the app).
	// Unpackaged Electron launches always pass the app entry (`.` or a folder/script path) as the first
	// positional argument — never treat it as a folder to open or a Windows virtual shell target.
	const normalizedAppPath = options.appPath?.replace(/[\\/]+$/u, "").toLowerCase() ?? null;
	let skippedEntry = options.isPackaged;
	const paths: string[] = [];
	for (const arg of args) {
		if (arg === "" || arg.startsWith("-")) continue;
		if (!skippedEntry) {
			skippedEntry = true;
			continue;
		}
		if (!options.isPackaged && normalizedAppPath !== null && arg.replace(/[\\/]+$/u, "").toLowerCase() === normalizedAppPath) {
			continue;
		}
		if (options.platform === "win32") {
			const cleaned = arg.endsWith('"') ? arg.slice(0, -1) : arg;
			// Only real absolute Windows paths (drive letter or UNC) count as bare positional targets;
			// virtual shell namespaces (`::{CLSID}`, `shell:`) come through `--autorag-default-open`.
			if (!isWindowsVirtualShellPath(cleaned)) {
				paths.push(cleaned);
			}
		} else if (arg.startsWith("/")) {
			paths.push(arg);
		}
	}
	return paths.length > 0 ? { kind: "paths", paths } : null;
}

export function winFolderOpenCommand(execPath: string, appArgs: readonly string[]): string {
	const launcher = [execPath, ...appArgs].map((part) => `"${part}"`).join(" ");
	return `${launcher} ${DEFAULT_OPEN_FLAG} "%1"`;
}

export function winNewWindowCommand(execPath: string, appArgs: readonly string[]): string {
	const launcher = [execPath, ...appArgs].map((part) => `"${part}"`).join(" ");
	return `${launcher} ${NEW_WINDOW_FLAG}`;
}

export function winDefaultManagerInstallCommands(deps: {
	readonly execPath: string;
	readonly appArgs: readonly string[];
}): readonly (readonly string[])[] {
	const openCmd = winFolderOpenCommand(deps.execPath, deps.appArgs);
	const newWinCmd = winNewWindowCommand(deps.execPath, deps.appArgs);
	const clsidCmdKey = `HKCU\\Software\\Classes\\CLSID\\${WIN_EXPLORER_CLSID}\\shell\\opennewwindow\\command`;
	return [
		// Folder open verb
		["add", "HKCU\\Software\\Classes\\Folder\\shell\\open\\command", "/ve", "/d", openCmd, "/f"],
		["add", "HKCU\\Software\\Classes\\Folder\\shell\\open\\command", "/v", "DelegateExecute", "/d", "", "/f"],
		// Directory open verb
		["add", "HKCU\\Software\\Classes\\Directory\\shell\\open\\command", "/ve", "/d", openCmd, "/f"],
		["add", "HKCU\\Software\\Classes\\Directory\\shell\\open\\command", "/v", "DelegateExecute", "/d", "", "/f"],
		// Win+E shortcut handler
		["add", clsidCmdKey, "/ve", "/d", newWinCmd, "/f"],
		["add", clsidCmdKey, "/v", "DelegateExecute", "/d", "", "/f"],
	];
}

export function winDefaultManagerUninstallCommands(): readonly (readonly string[])[] {
	return [
		["delete", "HKCU\\Software\\Classes\\Folder\\shell\\open", "/f"],
		["delete", "HKCU\\Software\\Classes\\Directory\\shell\\open", "/f"],
		["delete", `HKCU\\Software\\Classes\\CLSID\\${WIN_EXPLORER_CLSID}`, "/f"],
	];
}

export interface DefaultFileManagerWatcherControl {
	isRunning(): boolean;
	start(): void;
	stop(): void;
}

export interface DefaultFileManagerServiceDeps {
	readonly platform: NodeJS.Platform;
	readonly isPackaged: boolean;
	readonly execPath: string;
	readonly appArgs: readonly string[];
	readonly bundleId?: string;
	readonly macRevealHookLoaded?: boolean;
	/** Runs one OS command with argv (never a shell) and resolves its stdout. */
	readonly run: (command: string, args: readonly string[]) => Promise<string>;
	readonly windowsWatcher?: DefaultFileManagerWatcherControl;
}

export interface DefaultFileManagerService {
	readonly supported: boolean;
	status(stored: { readonly enabled: boolean; readonly interceptReveal: boolean }): Promise<DefaultFileManagerStatus>;
	apply(request: DefaultFileManagerApplyRequest): Promise<DefaultFileManagerStatus>;
	syncOnStartup(stored: { readonly enabled: boolean; readonly interceptReveal: boolean }): Promise<void>;
	dispose(): void;
}

function normalizePlatform(platform: NodeJS.Platform): DefaultFileManagerPlatform {
	if (platform === "darwin" || platform === "win32") return platform;
	return "unsupported";
}

export function createDefaultFileManagerService(deps: DefaultFileManagerServiceDeps): DefaultFileManagerService {
	const platform = normalizePlatform(deps.platform);
	const bundleId = deps.bundleId ?? MAC_DAZZI_BUNDLE_ID;
	const macRevealHookLoaded = deps.macRevealHookLoaded === true;
	const supported = platform !== "unsupported";

	async function readMacRegistered(): Promise<boolean> {
		let viewer = "";
		try {
			viewer = (await deps.run(DEFAULTS_BIN, ["read", "-g", "NSFileViewer"])).trim();
		} catch {
			viewer = "";
		}
		let folderHandler = "";
		try {
			folderHandler = (await deps.run(OSASCRIPT_BIN, ["-l", "JavaScript", "-e", MAC_GET_FOLDER_HANDLER_JXA])).trim();
		} catch {
			folderHandler = "";
		}
		return viewer === bundleId || folderHandler.toLowerCase() === bundleId.toLowerCase();
	}

	async function readWinRegistered(): Promise<boolean> {
		try {
			const out = await deps.run("reg.exe", ["query", "HKCU\\Software\\Classes\\Folder\\shell\\open\\command", "/ve"]);
			return out.includes(DEFAULT_OPEN_FLAG);
		} catch {
			return false;
		}
	}

	async function probeOsRegistered(): Promise<boolean> {
		if (platform === "darwin") return readMacRegistered();
		if (platform === "win32") return readWinRegistered();
		return false;
	}

	async function buildStatus(
		stored: { readonly enabled: boolean; readonly interceptReveal: boolean },
		error: string | null = null,
	): Promise<DefaultFileManagerStatus> {
		const osRegistered = supported ? await probeOsRegistered() : false;
		return {
			supported,
			platform,
			enabled: stored.enabled,
			osRegistered,
			interceptReveal: platform === "win32" ? stored.interceptReveal : false,
			interceptRevealActive: platform === "win32" ? (deps.windowsWatcher?.isRunning() ?? false) : false,
			macRevealHookLoaded: platform === "darwin" ? macRevealHookLoaded : false,
			requiresPackagedApp: platform === "darwin" && !deps.isPackaged,
			error,
		};
	}

	async function applyMac(enabled: boolean): Promise<void> {
		if (enabled) {
			await deps.run(DEFAULTS_BIN, ["write", "-g", "NSFileViewer", "-string", bundleId]);
			await deps.run(OSASCRIPT_BIN, ["-l", "JavaScript", "-e", MAC_SET_FOLDER_HANDLER_JXA, bundleId]);
		} else {
			await deps.run(DEFAULTS_BIN, ["delete", "-g", "NSFileViewer"]).catch(() => undefined);
			await deps.run(OSASCRIPT_BIN, ["-l", "JavaScript", "-e", MAC_SET_FOLDER_HANDLER_JXA, MAC_FINDER_BUNDLE_ID]);
		}
	}

	async function applyWin(enabled: boolean, interceptReveal: boolean): Promise<void> {
		if (enabled) {
			for (const args of winDefaultManagerInstallCommands(deps)) {
				await deps.run("reg.exe", args);
			}
			if (interceptReveal) {
				deps.windowsWatcher?.start();
			} else {
				deps.windowsWatcher?.stop();
			}
		} else {
			deps.windowsWatcher?.stop();
			for (const args of winDefaultManagerUninstallCommands()) {
				await deps.run("reg.exe", args).catch(() => undefined);
			}
		}
	}

	return {
		supported,
		status: (stored) => buildStatus(stored),
		async apply(request) {
			const interceptReveal = platform === "win32" ? (request.interceptReveal ?? false) : false;
			if (!supported) {
				return buildStatus({ enabled: false, interceptReveal: false }, "Unsupported operating system");
			}
			if (platform === "darwin") {
				await applyMac(request.enabled);
			} else if (platform === "win32") {
				await applyWin(request.enabled, interceptReveal);
			}
			return buildStatus({ enabled: request.enabled, interceptReveal });
		},
		async syncOnStartup(stored) {
			if (!supported) return;
			if (!stored.enabled) {
				deps.windowsWatcher?.stop();
				return;
			}
			if (platform === "win32") {
				// Refresh registry paths in case the executable path moved across updates.
				for (const args of winDefaultManagerInstallCommands(deps)) {
					await deps.run("reg.exe", args);
				}
				if (stored.interceptReveal) {
					deps.windowsWatcher?.start();
				}
			} else if (platform === "darwin" && deps.isPackaged) {
				// Ensure NSFileViewer stays intact if the user enabled it.
				if (!(await readMacRegistered())) {
					await applyMac(true);
				}
			}
		},
		dispose() {
			deps.windowsWatcher?.stop();
		},
	};
}
