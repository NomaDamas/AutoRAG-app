/**
 * What the launcher window is made of. On macOS the window is a transparent panel and a small native addon puts the
 * material behind the page: macOS 26's Liquid Glass (`NSGlassEffectView`) with the palette's own corner radius, or on
 * an older macOS a blurred `NSVisualEffectView` masked to the same corners. Electron's own `vibrancy` option fills the
 * rectangle and cannot round it past the system's ~10pt, which is why it is not used here. Without the addon the window
 * falls back to that plain vibrancy; off macOS the window is opaque. Pure and injected so the choice is testable.
 */

import type { QuickSearchMaterial } from "../shared/quick-search-contract";

/** The palette's corner radius, Tinycast's: the glass and the page's rounded sheet must agree to the pixel. */
export const LAUNCHER_CORNER_RADIUS = 26;

/** The native addon's surface (`vendor/mac-glass.node`). `attach` returns what it managed to put behind the page. */
export interface GlassAddon {
	attach(handle: Buffer, cornerRadius: number): "glass" | "vibrancy";
}

export interface MaterialWindow {
	readonly platform: NodeJS.Platform;
	/** `BrowserWindow.getNativeWindowHandle()`: the `NSView*` of the window's content. */
	readonly handle: Buffer;
	setVibrancy(type: "under-window"): void;
}

/** The constructor options that differ by platform; the shared ones stay with the window. */
export function launcherWindowOptions(platform: NodeJS.Platform, dark: boolean): Electron.BrowserWindowConstructorOptions {
	if (platform === "darwin") return { type: "panel", transparent: true, backgroundColor: "#00000000" };
	return { backgroundColor: dark ? "#1E1E20" : "#FFFFFF" };
}

export function applyLauncherMaterial(window: MaterialWindow, addon: GlassAddon | null, cornerRadius: number): QuickSearchMaterial {
	if (window.platform !== "darwin") return "solid";
	if (addon !== null) {
		try {
			return addon.attach(window.handle, cornerRadius);
		} catch (error) {
			console.warn("[quick-search] native material failed, using vibrancy:", error instanceof Error ? error.message : error);
		}
	}
	window.setVibrancy("under-window");
	return "vibrancy";
}
