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
	// Left to choose, @parcel/watcher probes for Watchman on every subscribe with
	// `popen("watchman ...")`. On Windows that starts `cmd.exe` outside Node, where
	// no `windowsHide` applies, so a console window flashed each time a folder was
	// opened. Naming the native backend skips the probe.
	const native: ParcelWatcher.Options = (deps.platform ?? process.platform) === "win32" ? { backend: "windows" } : {};
	return {
		async subscribe(dir, onEvents, onError) {
			const subscription = await watcher.subscribe(
				dir,
				(error, events) => {
					if (error !== null) {
						onError(error);
						return;
					}
					onEvents(events.map(({ path, type }) => ({ path, type })));
				},
				{ ...native, ignore: [NESTED_PATH_IGNORE] },
			);
			return () => subscription.unsubscribe();
		},
	};
}
