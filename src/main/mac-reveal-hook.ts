import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Loads the optional macOS N-API addon (`vendor/mac-reveal-hook.node`) that
 * registers an `NSAppleEventManager` handler for `misc`/`mvis`
 * (`kAERevealSelection`).
 *
 * When macOS `NSFileViewer` is set to Dazzi's bundle ID, apps calling
 * `NSWorkspace.activateFileViewerSelectingURLs:` (Chrome, VS Code, Slack,
 * Safari, etc.) send `misc`/`mvis` to Dazzi. Electron only exposes `aevt`/`odoc`
 * via `app.on("open-file")`, so this addon bridges `misc`/`mvis` back to JS.
 */

interface NativeRevealHook {
	install(callback: (jsonPaths: string) => void): boolean;
	uninstall(): boolean;
}

export interface MacRevealHookHandle {
	readonly loaded: boolean;
	uninstall(): void;
}

function resolveAddonPath(): string | null {
	const baseDir = import.meta.dirname;
	const unpackedBase = baseDir.replace(/([\\/])app\.asar([\\/])/u, "$1app.asar.unpacked$2");
	const candidates = [
		join(unpackedBase, "vendor", "mac-reveal-hook.node"),
		join(baseDir, "vendor", "mac-reveal-hook.node"),
		join(dirname(unpackedBase), "main", "vendor", "mac-reveal-hook.node"),
		join(dirname(baseDir), "main", "vendor", "mac-reveal-hook.node"),
		join(process.resourcesPath ?? "", "app.asar.unpacked", "out", "main", "vendor", "mac-reveal-hook.node"),
		join(process.resourcesPath ?? "", "app", "out", "main", "vendor", "mac-reveal-hook.node"),
	];
	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) return candidate;
	}
	return null;
}

export function installMacRevealHook(onReveal: (paths: readonly string[]) => void): MacRevealHookHandle {
	if (process.platform !== "darwin") {
		return { loaded: false, uninstall: () => undefined };
	}
	const addonPath = resolveAddonPath();
	if (addonPath === null) {
		return { loaded: false, uninstall: () => undefined };
	}
	try {
		const req = createRequire(import.meta.url);
		const addon = req(addonPath) as NativeRevealHook;
		const ok = addon.install((json) => {
			try {
				const parsed: unknown = JSON.parse(json);
				if (!Array.isArray(parsed)) return;
				const paths = parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
				if (paths.length > 0) onReveal(paths);
			} catch (error) {
				console.error("[mac-reveal-hook] failed to parse AppleEvent payload:", error);
			}
		});
		if (!ok) return { loaded: false, uninstall: () => undefined };
		return {
			loaded: true,
			uninstall: () => {
				try {
					addon.uninstall();
				} catch {
					// Ignore errors during teardown.
				}
			},
		};
	} catch (error) {
		console.warn("[mac-reveal-hook] could not load native reveal hook:", error instanceof Error ? error.message : error);
		return { loaded: false, uninstall: () => undefined };
	}
}
