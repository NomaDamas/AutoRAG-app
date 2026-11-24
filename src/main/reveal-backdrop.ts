/**
 * Arc / Dia-style desktop spotlight backdrop for the Ready → Finder reveal.
 *
 * When the user presses "시작하기", spawns one borderless click-through dark
 * `BrowserWindow` per connected display (zero OS permissions required) and
 * elevates the Dazzi window directly above it so the user's desktop and other
 * apps fade into cinema darkness while Dazzi floats in the spotlight.
 *
 * Safety invariants:
 * - Never spawns if the main window is fullscreen, minimized, or destroyed.
 * - Click-through (`setIgnoreMouseEvents(true)`) and non-focusable (`focusable: false`).
 * - Destroys all backdrop windows and restores normal window level on opacity → 0,
 *   main window close, explicit dispose, or a hard safety timeout (`BACKDROP_SAFETY_TIMEOUT_MS`).
 */

import { BrowserWindow, screen, type Rectangle } from "electron";

/** Maximum opacity of the desktop dimmer (matches Arc's ~0.88 cinema dim without pure blackout). */
export const BACKDROP_MAX_OPACITY = 0.88;

/** Hard upper bound so a crashed renderer can never strand a dark overlay over the user's desktop. */
export const BACKDROP_SAFETY_TIMEOUT_MS = 12_000;

export interface BackdropDisplay {
	readonly id: number;
	readonly bounds: Rectangle;
	readonly workArea: Rectangle;
}

export interface BackdropWindowLike {
	isDestroyed(): boolean;
	setOpacity(opacity: number): void;
	setAlwaysOnTop(flag: boolean, level?: "normal" | "floating" | "torn-off-menu" | "modal-panel" | "main-menu" | "status" | "pop-up-menu" | "screen-saver"): void;
	setIgnoreMouseEvents(ignore: boolean): void;
	setVisibleOnAllWorkspaces?(visible: boolean, options?: { visibleOnFullScreen?: boolean }): void;
	showInactive(): void;
	destroy(): void;
}

export interface TargetWindowLike {
	isDestroyed(): boolean;
	isFullScreen(): boolean;
	isMinimized(): boolean;
	setAlwaysOnTop(flag: boolean, level?: "normal" | "floating" | "torn-off-menu" | "modal-panel" | "main-menu" | "status" | "pop-up-menu" | "screen-saver"): void;
	moveTop(): void;
	once(event: "closed", listener: () => void): void;
}

export interface RevealBackdropController {
	/** Set desktop dimmer opacity in `[0, BACKDROP_MAX_OPACITY]`. `<= 0.002` tears down all backdrops cleanly. */
	setOpacity(opacity: number): void;
	/** Immediately destroys all backdrop windows and restores normal z-order. */
	clear(): void;
	/** Number of live backdrop windows (primarily for diagnostics & tests). */
	activeCount(): number;
}

export interface RevealBackdropDeps {
	readonly platform: NodeJS.Platform;
	readonly getDisplays: () => readonly BackdropDisplay[];
	readonly getTargetWindow: () => TargetWindowLike | null;
	readonly createBackdropWindow: (bounds: Rectangle) => BackdropWindowLike;
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

		const created: BackdropWindowLike[] = [];
		for (const display of displays) {
			// On macOS keep the menu bar clear (workArea); on Windows/Linux cover the full display bounds.
			const rect = deps.platform === "darwin" ? display.workArea : display.bounds;
			const win = deps.createBackdropWindow(rect);
			win.setIgnoreMouseEvents(true);
			win.setOpacity(0);
			win.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: false });
			win.setAlwaysOnTop(true, "floating");
			win.showInactive();
			created.push(win);
		}
		backdrops = created;

		// Elevate the Dazzi window directly above the floating dimmer windows so it glows in the spotlight
		elevatedTarget = target;
		target.setAlwaysOnTop(true, "floating");
		target.moveTop();
		target.once("closed", clear);
		return true;
	};

	const setOpacity = (rawOpacity: number): void => {
		const clamped = Number.isFinite(rawOpacity) ? Math.max(0, Math.min(BACKDROP_MAX_OPACITY, rawOpacity)) : 0;
		if (clamped <= 0.002) {
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
			if (!win.isDestroyed()) win.setOpacity(clamped);
		}
		if (!target.isDestroyed()) {
			target.moveTop();
		}
	};

	return {
		setOpacity,
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
		createBackdropWindow: (rect) => {
			const win = new BrowserWindow({
				x: rect.x,
				y: rect.y,
				width: rect.width,
				height: rect.height,
				frame: false,
				transparent: false,
				backgroundColor: "#06070d",
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
				},
			});
			return win;
		},
	});
}
