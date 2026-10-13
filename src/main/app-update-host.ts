import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { autoUpdater as nativeUpdater, Menu, MenuItem } from "electron";
// CommonJS package: its `autoUpdater` is a lazy getter, so importing it constructs nothing until first use.
import electronUpdater from "electron-updater";
import { t } from "../shared/i18n/core";
import type { AppUpdateMode, AppUpdateSnapshot } from "../shared/update-contract";
import { createAppUpdater, type AppUpdaterService, type UpdaterLike } from "./app-updater";

const execFileAsync = promisify(execFile);

/**
 * Electron side of the self-update: decides whether this build can update at
 * all, which mode it gets, and builds the electron-updater instance. The
 * policy lives in `app-updater.ts`.
 *
 * A build updates only when electron-builder wrote `resources/app-update.yml`,
 * which happens only when the release was packed with `AUTORAG_UPDATE_FEED_URL`
 * (electron-builder.config.mjs). Development runs and local packs never check.
 */

export interface AppUpdateHostDeps {
	readonly isPackaged: boolean;
	readonly platform: NodeJS.Platform;
	readonly resourcesPath: string;
	readonly executablePath: string;
	readonly currentVersion: string;
	readonly logPath: string;
	readonly autoInstall: () => Promise<boolean>;
	readonly openExternal: (url: string) => Promise<void>;
	readonly onChange: (snapshot: AppUpdateSnapshot) => void;
}

/** `url:` of the generic feed in `app-update.yml`, or null when the file is absent or has none. */
export function feedUrlFromAppUpdateYml(text: string): string | null {
	const match = /^url:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text);
	return match?.[1] ?? null;
}

/**
 * `codesign -dv` output → whether Squirrel.Mac can install over this bundle: it
 * requires a real signing identity (a Team ID), which an ad-hoc build lacks.
 */
export function isDeveloperIdSigned(codesignOutput: string): boolean {
	if (/^Signature=adhoc$/m.test(codesignOutput)) return false;
	const team = /^TeamIdentifier=(.+)$/m.exec(codesignOutput)?.[1]?.trim();
	return team !== undefined && team !== "not set";
}

/** The `.app` directory holding the running executable. */
function macBundlePath(executablePath: string): string {
	const marker = `${sep}Contents${sep}MacOS${sep}`;
	const at = executablePath.indexOf(marker);
	return at >= 0 ? executablePath.slice(0, at) : executablePath;
}

async function resolveMode(deps: AppUpdateHostDeps): Promise<AppUpdateMode | null> {
	if (deps.platform === "win32") return "install";
	if (deps.platform !== "darwin") return null;
	try {
		// codesign prints the description on stderr.
		const { stdout, stderr } = await execFileAsync("codesign", ["-dv", "--verbose=2", macBundlePath(deps.executablePath)]);
		return isDeveloperIdSigned(`${stdout}\n${stderr}`) ? "install" : "notify";
	} catch {
		return "notify";
	}
}

function unsupported(currentVersion: string): AppUpdaterService {
	const snapshot: AppUpdateSnapshot = { currentVersion, mode: null, state: { kind: "unsupported" } };
	return {
		snapshot: () => snapshot,
		check: async () => snapshot,
		download: async () => undefined,
		install: () => undefined,
		applySettings: async () => undefined,
		start: () => undefined,
	};
}

/**
 * Appends to `updater.log`: electron-updater's own lines (blockmap plans, download sizes) land here.
 * Its debug level is dropped: one differential plan logs hundreds of "duplicated in blockmap" lines.
 */
function fileLogger(path: string): { info: (m: unknown) => void; warn: (m: unknown) => void; error: (m: unknown) => void } {
	let ready: Promise<unknown> | null = null;
	const write = (level: string, message: unknown): void => {
		const line = `${new Date().toISOString()} ${level} ${message instanceof Error ? (message.stack ?? message.message) : String(message)}\n`;
		ready ??= mkdir(dirname(path), { recursive: true });
		void ready.then(() => appendFile(path, line)).catch(() => undefined);
		if (level === "error") console.error(`[app-update] ${line.trimEnd()}`);
	};
	return { info: (m) => write("info", m), warn: (m) => write("warn", m), error: (m) => write("error", m) };
}

export async function createAppUpdateHost(deps: AppUpdateHostDeps): Promise<AppUpdaterService> {
	if (!deps.isPackaged) return unsupported(deps.currentVersion);
	let feedUrl: string | null;
	try {
		feedUrl = feedUrlFromAppUpdateYml(await readFile(join(deps.resourcesPath, "app-update.yml"), "utf8"));
	} catch {
		feedUrl = null;
	}
	if (feedUrl === null) return unsupported(deps.currentVersion);
	const mode = await resolveMode(deps);
	if (mode === null) return unsupported(deps.currentVersion);

	const logger = fileLogger(deps.logPath);
	const autoUpdater = electronUpdater.autoUpdater;
	autoUpdater.logger = logger;
	// Pre-release builds (v1.2.3-rc.1) follow their own channel file; releases never see them.
	autoUpdater.allowDowngrade = false;
	logger.info(`feed ${feedUrl}, mode ${mode}, version ${deps.currentVersion}`);
	return createAppUpdater({
		currentVersion: deps.currentVersion,
		mode,
		updater: autoUpdater as unknown as UpdaterLike,
		feedUrl,
		autoInstall: deps.autoInstall,
		openExternal: deps.openExternal,
		onChange: deps.onChange,
		log: (line) => logger.info(line),
		// electron-updater's MacUpdater drives Electron's Squirrel.Mac updater; its own event means staged.
		...(deps.platform === "darwin" ? { onInstallerStaged: (listener: () => void) => void nativeUpdater.on("update-downloaded", listener) } : {}),
	});
}

/**
 * "Check for Updates…" in the macOS app menu, below About (Windows has no menu bar:
 * the titlebar is hidden, so Settings → 일반 is its only entry point). Only an
 * updatable build gets the item.
 */
export function installCheckForUpdatesMenuItem(service: AppUpdaterService): void {
	if (process.platform !== "darwin" || service.snapshot().mode === null) return;
	const menu = Menu.getApplicationMenu();
	// Electron types the role as "appMenu"; the default menu reports it lowercased at runtime.
	const appMenu = menu?.items.find((item) => item.role?.toLowerCase() === "appmenu")?.submenu;
	if (menu === null || appMenu === undefined) return;
	// Labelled in the interface language at launch, like the rest of the menu Electron builds once.
	appMenu.insert(1, new MenuItem({ label: t("main.update.checkMenu"), click: () => void service.check() }));
	Menu.setApplicationMenu(menu);
}
