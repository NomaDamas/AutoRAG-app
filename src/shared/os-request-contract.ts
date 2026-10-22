import type { ChatAttachment } from "./search-contract";

/**
 * Requests that arrive from outside the window: the macOS Finder Quick
 * Action / Services entry and the Windows Explorer context-menu verbs the app
 * installs (Settings → General), and the `dazzi` command line launcher.
 *
 * Each of them launches the app binary with the flags below. A running app
 * receives the request over a per-profile local socket (see
 * `src/main/os-request-channel.ts`); a cold-started one reads it from its own
 * argv. Either way the request ends up in the renderer through
 * {@link OS_REQUEST_CHANNELS}.
 */

/**
 * `ask` attaches the paths to AI Search; `reveal` shows the first one in its folder; `open` is the
 * `dazzi <path>...` command: every folder opens in a tab, every file is shown selected in its folder.
 */
export type OsRequestAction = "ask" | "reveal" | "open";

export const OS_REQUEST_ACTIONS: readonly OsRequestAction[] = ["ask", "reveal", "open"];

/** The request as a menu entry states it: raw, untrusted paths. */
export interface OsLaunchRequest {
	readonly action: OsRequestAction;
	readonly paths: readonly string[];
}

/** The request after the main process checked the paths against the disk. */
export type OsRendererRequest =
	| { readonly action: "ask"; readonly attachments: readonly ChatAttachment[] }
	| { readonly action: "reveal"; readonly path: string }
	| { readonly action: "open"; readonly targets: readonly OsOpenTarget[] };

/** One existing path of an `open` request, with what it is on disk. */
export interface OsOpenTarget {
	readonly path: string;
	readonly kind: "file" | "folder";
}

/** argv flag naming the action; its presence marks a launch as a menu request. */
export const OS_REQUEST_FLAG = "--autorag-request=";
/** argv flag carrying one selected path; repeated once per item. */
export const OS_REQUEST_PATH_FLAG = "--autorag-path=";

/** More than this many items in one request are ignored: a menu never sends that many on purpose. */
export const OS_REQUEST_MAX_PATHS = 200;

export const OS_REQUEST_CHANNELS = {
	/** invoke: drain the queued requests. */
	take: "os-requests:take",
	/** main → renderer: the queue has something to take. */
	available: "os-requests:available",
} as const;

export interface OsRequestBridge {
	/** Requests received since the last call, oldest first. */
	take(): Promise<readonly OsRendererRequest[]>;
	/** Fires whenever a request is queued; returns the unsubscribe. */
	onAvailable(listener: () => void): () => void;
}

export function isOsRequestAction(value: unknown): value is OsRequestAction {
	return typeof value === "string" && (OS_REQUEST_ACTIONS as readonly string[]).includes(value);
}

/**
 * The request a launch's argv carries, or null for an ordinary launch (no
 * action flag, an unknown action, or no usable path). Only absolute paths are
 * kept, in order and without duplicates.
 */
export function parseOsRequestArgv(argv: readonly string[]): OsLaunchRequest | null {
	let action: OsRequestAction | null = null;
	const paths: string[] = [];
	for (const arg of argv) {
		if (arg.startsWith(OS_REQUEST_FLAG)) {
			const value = arg.slice(OS_REQUEST_FLAG.length);
			if (isOsRequestAction(value)) action = value;
		} else if (arg.startsWith(OS_REQUEST_PATH_FLAG)) {
			// Windows hands `"D:\"` to the argv parser as an escaped quote, leaving a stray `"` on a
			// drive-root path; no Windows path contains one, so it is safe to drop.
			const raw = arg.slice(OS_REQUEST_PATH_FLAG.length);
			paths.push(raw.endsWith('"') ? raw.slice(0, -1) : raw);
		}
	}
	return action === null ? null : normalizeOsLaunchRequest({ action, paths });
}

/**
 * Validate and clean an untrusted request (argv, or JSON off the socket).
 * Returns null unless an action and at least one absolute path survive.
 */
export function normalizeOsLaunchRequest(value: unknown): OsLaunchRequest | null {
	if (typeof value !== "object" || value === null) return null;
	const { action, paths } = value as { action?: unknown; paths?: unknown };
	if (!isOsRequestAction(action) || !Array.isArray(paths) || paths.length > OS_REQUEST_MAX_PATHS) return null;
	const kept: string[] = [];
	for (const entry of paths) {
		if (typeof entry !== "string" || entry.length === 0 || entry.includes("\0")) return null;
		const absolute = entry.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(entry) || entry.startsWith("\\\\");
		if (!absolute) continue;
		if (!kept.includes(entry)) kept.push(entry);
	}
	return kept.length === 0 ? null : { action, paths: kept };
}
