/**
 * The desktop half of the Ready → Finder reveal.
 *
 * When the user presses "시작하기", spawns one borderless, transparent, click-through `BrowserWindow` per connected
 * display (no OS permissions needed) and keeps the Dazzi window directly above them. Each of those windows draws the
 * reveal's light (`src/shared/reveal-light.ts`) in screen coordinates from the frames the renderer sends, so the dusk
 * and the light run across the whole desktop and continue seamlessly into the Dazzi window.
 *
 * Safety invariants:
 * - Never spawns if the main window is fullscreen, minimized, or destroyed.
 * - Click-through (`setIgnoreMouseEvents(true)`) and non-focusable (`focusable: false`).
 * - Destroys all backdrop windows and restores the normal window level when a frame has nothing left to draw, the
 *   main window closes, on explicit `clear()`, or after a hard safety timeout (`BACKDROP_SAFETY_TIMEOUT_MS`).
 */

import { BrowserWindow, screen, type Rectangle } from "electron";
import { type RevealLightFrame, type RevealLightScene, revealBackdropPageHtml } from "../shared/reveal-light";

/** The strongest the dusk gets on the desktop: dark, with a hint of the desktop still showing through. */
export const BACKDROP_DUSK_MAX = 0.86;

/** Hard upper bound so a crashed renderer can never strand an overlay over the user's desktop. */
export const BACKDROP_SAFETY_TIMEOUT_MS = 12_000;

/** Below this, a frame draws nothing visible and the backdrop is torn down. */
const BACKDROP_VISIBLE_EPSILON = 0.002;

export interface BackdropDisplay {
	readonly id: number;
	readonly bounds: Rectangle;
	readonly workArea: Rectangle;
}

export interface BackdropWindowLike {
	isDestroyed(): boolean;
	setAlwaysOnTop(flag: boolean, level?: "normal" | "floating" | "torn-off-menu" | "modal-panel" | "main-menu" | "status" | "pop-up-menu" | "screen-saver"): void;
	setIgnoreMouseEvents(ignore: boolean): void;
	setVisibleOnAllWorkspaces?(visible: boolean, options?: { visibleOnFullScreen?: boolean }): void;
	showInactive(): void;
	destroy(): void;
	/** Draws one frame of the light. */
	drawFrame(frame: RevealLightFrame): void;
}

export interface TargetWindowLike {
	isDestroyed(): boolean;
	isFullScreen(): boolean;
	isMinimized(): boolean;
	getContentBounds(): Rectangle;
	setAlwaysOnTop(flag: boolean, level?: "normal" | "floating" | "torn-off-menu" | "modal-panel" | "main-menu" | "status" | "pop-up-menu" | "screen-saver"): void;
	moveTop(): void;
	once(event: "closed", listener: () => void): void;
}

export interface RevealBackdropController {
	/** Draws one frame on every display; a frame with no dusk and no light (or `null`) tears the backdrop down. */
	setFrame(frame: RevealLightFrame | null): void;
	/** Immediately destroys all backdrop windows and restores normal z-order. */
	clear(): void;
	/** Number of live backdrop windows (primarily for diagnostics & tests). */
	activeCount(): number;
}

export interface RevealBackdropDeps {
	readonly platform: NodeJS.Platform;
	readonly getDisplays: () => readonly BackdropDisplay[];
	readonly getTargetWindow: () => TargetWindowLike | null;
	readonly createBackdropWindow: (bounds: Rectangle, scene: RevealLightScene) => BackdropWindowLike;
}

/** The display that holds the centre of `rect`, or the first display. */
function displayHolding(displays: readonly BackdropDisplay[], rect: Rectangle): BackdropDisplay {
	const cx = rect.x + rect.width / 2;
	const cy = rect.y + rect.height / 2;
	return (
		displays.find((d) => cx >= d.bounds.x && cx < d.bounds.x + d.bounds.width && cy >= d.bounds.y && cy < d.bounds.y + d.bounds.height) ??
		displays[0]!
	);
}

/** Pure factory with injectable Electron primitives so unit tests exercise every lifecycle path. */
export function createRevealBackdropController(deps: RevealBackdropDeps): RevealBackdropController {
	let backdrops: BackdropWindowLike[] = [];
	let elevatedTarget: TargetWindowLike | null = null;
	let safetyTimer: ReturnType<typeof setTimeout> | null = null;

	const clearSafetyTimer = (): void => {
		if (safetyTimer !== null) {
			clearTimeout(safetyTimer);
			safetyTimer = null;
		}
	};

	const clear = (): void => {
		clearSafetyTimer();
		const oldBackdrops = backdrops;
		backdrops = [];
		for (const win of oldBackdrops) {
			try {
				if (!win.isDestroyed()) win.destroy();
			} catch {
				// Window may already be tearing down during app quit
			}
		}
		const target = elevatedTarget;
		elevatedTarget = null;
		if (target !== null && !target.isDestroyed()) {
			try {
				target.setAlwaysOnTop(false);
			} catch {
				// Ignore during teardown
			}
		}
	};

	const armSafetyTimer = (): void => {
		clearSafetyTimer();
		safetyTimer = setTimeout(() => {
			clear();
		}, BACKDROP_SAFETY_TIMEOUT_MS);
	};

	const ensureBackdrops = (target: TargetWindowLike): boolean => {
		if (backdrops.length > 0) return true;
		if (target.isDestroyed() || target.isFullScreen() || target.isMinimized()) return false;

		const displays = deps.getDisplays();
		if (displays.length === 0) return false;

		const content = target.getContentBounds();
		const unit = displayHolding(displays, content).bounds.height;
		const created: BackdropWindowLike[] = [];
		for (const display of displays) {
			// On macOS keep the menu bar clear (workArea); on Windows/Linux cover the full display bounds.
			const rect = deps.platform === "darwin" ? display.workArea : display.bounds;
			const scene: RevealLightScene = {
				originX: rect.x,
				originY: rect.y,
				windowX: content.x,
				windowY: content.y,
				windowWidth: content.width,
				windowHeight: content.height,
				unit,
				duskMax: BACKDROP_DUSK_MAX,
			};
			const win = deps.createBackdropWindow(rect, scene);
			win.setIgnoreMouseEvents(true);
			win.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: false });
			win.setAlwaysOnTop(true, "floating");
			win.showInactive();
			created.push(win);
		}
		backdrops = created;

		// Keep the Dazzi window directly above the light so Finder rises out of it.
		elevatedTarget = target;
		target.setAlwaysOnTop(true, "floating");
		target.moveTop();
		target.once("closed", clear);
		return true;
	};

	const setFrame = (frame: RevealLightFrame | null): void => {
		if (frame === null || (frame.dusk <= BACKDROP_VISIBLE_EPSILON && frame.light <= BACKDROP_VISIBLE_EPSILON)) {
			clear();
			return;
		}
		const target = deps.getTargetWindow();
		if (target === null) {
			clear();
			return;
		}
		if (!ensureBackdrops(target)) return;

		armSafetyTimer();
		for (const win of backdrops) {
			if (!win.isDestroyed()) win.drawFrame(frame);
		}
		if (!target.isDestroyed()) {
			target.moveTop();
		}
	};

	return {
		setFrame,
		clear,
		activeCount: () => backdrops.filter((win) => !win.isDestroyed()).length,
	};
}

/** Creates the production Electron desktop backdrop controller bound to `screen` and the main Finder window. */
export function createElectronRevealBackdrop(getMainWindow: () => BrowserWindow | null): RevealBackdropController {
	return createRevealBackdropController({
		platform: process.platform,
		getDisplays: () => screen.getAllDisplays(),
		getTargetWindow: getMainWindow,
		createBackdropWindow: (rect, scene) => {
			const win = new BrowserWindow({
				x: rect.x,
				y: rect.y,
				width: rect.width,
				height: rect.height,
				frame: false,
				transparent: true,
				backgroundColor: "#00000000",
				hasShadow: false,
				resizable: false,
				movable: false,
				minimizable: false,
				maximizable: false,
				closable: false,
				focusable: false,
				skipTaskbar: true,
				fullscreenable: false,
				show: false,
				enableLargerThanScreen: true,
				roundedCorners: false,
				webPreferences: {
					sandbox: true,
					contextIsolation: true,
					nodeIntegration: false,
					backgroundThrottling: false,
				},
			});
			void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(revealBackdropPageHtml(scene))}`).catch(() => {});
			return {
				isDestroyed: () => win.isDestroyed(),
				setAlwaysOnTop: (flag, level) => win.setAlwaysOnTop(flag, level),
				setIgnoreMouseEvents: (ignore) => win.setIgnoreMouseEvents(ignore),
				setVisibleOnAllWorkspaces: (visible, options) => win.setVisibleOnAllWorkspaces(visible, options),
				showInactive: () => win.showInactive(),
				destroy: () => win.destroy(),
				drawFrame: (frame) => {
					if (win.isDestroyed() || win.webContents.isLoading()) return;
					void win.webContents.executeJavaScript(`window.__revealFrame&&window.__revealFrame(${JSON.stringify(frame)})`).catch(() => {});
				},
			};
		},
	});
}
