import parcelWatcher from "@parcel/watcher";
import type { FsChange } from "../shared/live-contract";

export interface WatchBackend {
	subscribe(
		dir: string,
		onEvents: (events: readonly FsChange[]) => void,
		onError: (error: Error) => void,
	): Promise<() => Promise<void>>;
}

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
				{ ignore: [] },
			);
			return () => subscription.unsubscribe();
		},
	};
}
