/**
 * macOS Services in the in-app right-click menu.
 *
 * Finder's right-click → Services lists what other apps register for the
 * selected files (Keka's "Send to Keka", QSpace, a Terminal "New Terminal at
 * Folder", Quick Action workflows…). The Finder window offers the same entries
 * under its own right-click → 서비스, and a click performs the service on the
 * selection exactly as the system would (`NSPerformService`).
 *
 * Main owns discovery and execution; the renderer only shows `ServiceEntry`
 * rows and sends back the id it was given. All paths are absolute OS paths.
 */

import { t } from "./i18n/core";

/** IPC channel names. Keep in 1:1 sync with the main-process handlers. */
export const SERVICES_CHANNELS = {
	list: "services:list",
	run: "services:run",
} as const;

/**
 * One service the OS offers for a selection. `id` is the service's full menu
 * title (`Keka/Send to Keka`), which is what the system performs by name.
 */
export interface ServiceEntry {
	readonly id: string;
	/** The owning application's submenu title, or null for a service that sits at the top level. */
	readonly group: string | null;
	/** The row label: the title after the group. */
	readonly name: string;
}

/** Exposed to the Finder window as `window.autorag.services`. */
export interface ServicesBridge {
	/** The services the OS offers for exactly these paths; empty where the platform has none. */
	list(paths: readonly string[]): Promise<readonly ServiceEntry[]>;
	/** Perform the service `id` on `paths`; rejects when the OS no longer offers it for them. */
	run(id: string, paths: readonly string[]): Promise<void>;
}

/** The weakest bridge: nothing is offered and nothing runs. Used where the real bridge is absent. */
export const NO_SERVICES: ServicesBridge = {
	list: () => Promise.resolve([]),
	run: () => Promise.reject(new Error(t("finderState.servicesUnavailable"))),
};

/**
 * `Keka/Send to Keka` → group `Keka`, name `Send to Keka`. Only the first
 * slash splits; a title with no group, or a slash at either end, stays whole.
 */
export function splitServiceTitle(title: string): { readonly group: string | null; readonly name: string } {
	const slash = title.indexOf("/");
	if (slash <= 0 || slash === title.length - 1) return { group: null, name: title };
	return { group: title.slice(0, slash), name: title.slice(slash + 1) };
}

/** Whether a `services:run` call is well formed: a service id and a non-empty list of absolute paths. */
export function isServiceRunRequest(id: unknown, paths: unknown): paths is readonly string[] {
	return (
		typeof id === "string" &&
		id.length > 0 &&
		Array.isArray(paths) &&
		paths.length > 0 &&
		paths.every((path): path is string => typeof path === "string" && path.startsWith("/"))
	);
}
