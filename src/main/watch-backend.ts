import parcelWatcher from "@parcel/watcher";
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

export function createParcelWatchBackend(): WatchBackend {
	return {
		async subscribe(dir, onEvents, onError) {
			const subscription = await parcelWatcher.subscribe(
				dir,
				(error, events) => {
					if (error !== null) {
						onError(error);
						return;
					}
					onEvents(events.map(({ path, type }) => ({ path, type })));
				},
				{ ignore: [NESTED_PATH_IGNORE] },
			);
			return () => subscription.unsubscribe();
		},
	};
}
