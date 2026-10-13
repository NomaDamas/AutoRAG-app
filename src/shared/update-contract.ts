/**
 * App self-update (electron-updater against the CDN feed). The main process
 * owns the updater; the renderer only reads the snapshot and asks for actions.
 *
 * Modes:
 * - `install`: the build can replace itself (Windows NSIS; a Developer ID
 *   signed macOS app). Updates download in the background (differential when a
 *   previous payload is cached) and apply on quit or on "restart now".
 * - `notify`: an ad-hoc signed macOS build. Squirrel.Mac refuses to install
 *   into it, so the app only reports the new version and links its installer.
 * `null` mode: development runs and builds without a feed never check.
 */

export type AppUpdateMode = "install" | "notify";

export type AppUpdateState =
	| { readonly kind: "unsupported" }
	/** Nothing pending. `checkedAt` is the last successful check (ISO), null before the first. */
	| { readonly kind: "idle"; readonly checkedAt: string | null }
	| { readonly kind: "checking" }
	/** A newer version exists and is not downloaded. `downloadUrl` is the manual installer (notify mode). */
	| { readonly kind: "available"; readonly version: string; readonly downloadUrl: string | null }
	| { readonly kind: "downloading"; readonly version: string; readonly percent: number }
	/** Downloaded and verified; applies on quit or {@link AppUpdateBridge.install}. */
	| { readonly kind: "ready"; readonly version: string }
	| { readonly kind: "error"; readonly message: string };

export interface AppUpdateSnapshot {
	readonly currentVersion: string;
	readonly mode: AppUpdateMode | null;
	readonly state: AppUpdateState;
}

export const APP_UPDATE_CHANNELS = {
	get: "app-update:get",
	check: "app-update:check",
	download: "app-update:download",
	install: "app-update:install",
	changed: "app-update:changed",
} as const;

export interface AppUpdateBridge {
	get(): Promise<AppUpdateSnapshot>;
	/** Ask the feed now; resolves with the snapshot after the check settles. */
	check(): Promise<AppUpdateSnapshot>;
	/** Install mode: start the download. Notify mode: open the installer link in the browser. */
	download(): Promise<void>;
	/** Quit and apply a `ready` update. */
	install(): Promise<void>;
	/** Pushed whenever the snapshot changes; returns the unsubscribe. */
	onChange(listener: (snapshot: AppUpdateSnapshot) => void): () => void;
}
