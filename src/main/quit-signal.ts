import { app, autoUpdater } from "electron";

/**
 * Runs `listener` once, when the app starts to quit.
 *
 * A window that hides instead of closing (the quick-search launcher, the Quick Look panels) must stop refusing
 * `close` once the app is quitting. Two events announce that, and an app that only listens to `before-quit` never
 * finishes installing an update on macOS: Squirrel.Mac's `quitAndInstall` closes every window first and waits
 * until all of them are gone, and emits `before-quit-for-update` instead of `before-quit` until then. A window
 * that still refuses to close keeps the install from ever reaching ShipIt.
 */
export function whenQuitting(listener: () => void): void {
	let fired = false;
	const fire = (): void => {
		if (fired) return;
		fired = true;
		listener();
	};
	app.once("before-quit", fire);
	autoUpdater.once("before-quit-for-update", fire);
}
