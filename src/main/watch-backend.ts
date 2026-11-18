import parcelWatcher from "@parcel/watcher";
import type ParcelWatcher from "@parcel/watcher";
import type { FsChange } from "../shared/live-contract";

export interface WatchBackend {
	subscribe(
		dir: string,
		onEvents: (events: readonly FsChange[]) => void,
		onError: (error: Error) => void,
	): Promise<() => Promise<void>>;
}

/**
 * Parcel matches RegExp ignore entries against the path *relative to the watched
 * root* (see `wrapper.js` -> `Watcher::isIgnored`) and wraps the source for
 * substring semantics. A relative path containing a separator is below the
 * root's direct children, so this keeps root and direct-child events (including
 * root deletion) while stopping the native watcher from surfacing recursive
 * subtree traffic. Matching the relative path — not the absolute one — is what
 * the previous glob assumption got wrong.
 */
const NESTED_PATH_IGNORE = /[/\\]/;

/**
 * Windows caps a plain path at `MAX_PATH` (260 characters), and a directory
 * path spends 12 of them on the 8.3 short name, so `CreateFileW` — which is how
 * `@parcel/watcher`'s Windows backend opens the watched directory — fails from
 * 248 characters on with `Invalid handle`. Node's own `fs` calls add the
 * extended-length prefix themselves, which is why listing and navigating a deep
 * directory works while the watcher cannot attach to it (#419).
 */
const WINDOWS_DIRECTORY_PATH_LIMIT = 248;
const EXTENDED_PATH_PREFIX = "\\\\?\\";
const EXTENDED_UNC_PREFIX = "\\\\?\\UNC\\";
const DRIVE_ABSOLUTE_PATH = /^[A-Za-z]:\\/;

/**
 * The extended-length form (`\\?\C:\…`, `\\?\UNC\server\share\…`) of an
 * over-long absolute Windows path, or null when the path is short enough to
 * open directly, already extended, or cannot carry a prefix (relative or
 * drive-relative paths). The returned path is what the native watcher must be
 * subscribed with; callers report its events under the original `dir`.
 */
function extendedWindowsPath(dir: string): string | null {
	if (dir.length < WINDOWS_DIRECTORY_PATH_LIMIT) return null;
	if (dir.startsWith(EXTENDED_PATH_PREFIX)) return null;
	// The prefix turns path normalization off, so forward slashes stop being
	// separators and must not survive into a prefixed path.
	const normalized = dir.replace(/\//g, "\\");
	if (DRIVE_ABSOLUTE_PATH.test(normalized)) return EXTENDED_PATH_PREFIX + normalized;
	if (normalized.startsWith("\\\\")) return EXTENDED_UNC_PREFIX + normalized.slice(2);
	return null;
}

/** The slice of `@parcel/watcher` the backend uses; tests pass a recording fake. */
export interface ParcelWatcherLike {
	subscribe(dir: string, callback: ParcelWatcher.SubscribeCallback, options?: ParcelWatcher.Options): Promise<ParcelWatcher.AsyncSubscription>;
}

export interface ParcelWatchBackendDeps {
	readonly watcher?: ParcelWatcherLike;
	readonly platform?: NodeJS.Platform;
}

export function createParcelWatchBackend(deps: ParcelWatchBackendDeps = {}): WatchBackend {
	const watcher = deps.watcher ?? parcelWatcher;
	const windows = (deps.platform ?? process.platform) === "win32";
	// Left to choose, @parcel/watcher probes for Watchman on every subscribe with
	// `popen("watchman ...")`. On Windows that starts `cmd.exe` outside Node, where
	// no `windowsHide` applies, so a console window flashed each time a folder was
	// opened. Naming the native backend skips the probe.
	const native: ParcelWatcher.Options = windows ? { backend: "windows" } : {};
	return {
		async subscribe(dir, onEvents, onError) {
			// Only the native subscription needs the extended-length form; every
			// path handed back to the caller stays in the form the caller used.
			const extended = windows ? extendedWindowsPath(dir) : null;
			const subscription = await watcher.subscribe(
				extended ?? dir,
				(error, events) => {
					if (error !== null) {
						onError(error);
						return;
					}
					onEvents(
						events.map(({ path, type }) => ({
							path: extended === null ? path : dir + path.slice(extended.length),
							type,
						})),
					);
				},
				{ ...native, ignore: [NESTED_PATH_IGNORE] },
			);
			return () => subscription.unsubscribe();
		},
	};
}
