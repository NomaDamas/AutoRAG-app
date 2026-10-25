import type { BrowserWindowConstructorOptions, TitleBarOverlayOptions } from "electron";
import type { AppAppearance } from "../shared/settings-contract";

/**
 * The main window draws its own top bar (the onboarding band, the Finder toolbar), so the native title strip
 * is removed on every OS:
 *  - macOS keeps `hiddenInset`: the traffic lights float over the sidebar header / toolbar.
 *  - Windows and Linux use `hidden` plus a window-controls overlay: only minimize / maximize / close remain, drawn
 *    over the top-right corner of the page, with no title text. The in-window `File Edit View Window` menu bar
 *    goes too (`hasInWindowMenuBar`): nothing in this app is reachable only through it.
 */

/** What the page's own top bar is: the overlay's height must match it so the buttons sit centered in the bar. */
export type WindowPhase = "onboarding" | "finder";

/** `.onb` grid row (onboarding.css) and `--size-toolbar` (tokens.css). */
const TOP_BAR_HEIGHT: Readonly<Record<WindowPhase, number>> = { onboarding: 42, finder: 52 };

const SYMBOL_COLOR: Readonly<Record<AppAppearance, string>> = {
	light: "#1D1D1F",
	dark: "#F5F5F7",
};

/** Transparent: the page's own bar shows behind the three buttons; only their symbols are tinted. */
export function windowControlsOverlay(appearance: AppAppearance, phase: WindowPhase): TitleBarOverlayOptions {
	return { color: "#00000000", symbolColor: SYMBOL_COLOR[appearance], height: TOP_BAR_HEIGHT[phase] };
}

/** Title-bar related `BrowserWindow` options for the host OS. */
export function mainWindowChrome(
	platform: NodeJS.Platform,
	appearance: AppAppearance,
	phase: WindowPhase,
): Pick<BrowserWindowConstructorOptions, "titleBarStyle" | "titleBarOverlay"> {
	if (platform === "darwin") return { titleBarStyle: "hiddenInset" };
	return { titleBarStyle: "hidden", titleBarOverlay: windowControlsOverlay(appearance, phase) };
}

/** Whether the window draws its own controls and menu bar (Windows and Linux); macOS has the global menu bar. */
export function hasInWindowMenuBar(platform: NodeJS.Platform): boolean {
	return platform !== "darwin";
}
