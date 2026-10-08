import type { LiveBridge, LiveMessage, LiveResync } from "../shared/live-contract";
import { FS_WORKER_PUSH, type WorkerClient } from "../shared/fs-worker-protocol";

/** `window.autorag.live`: the fs worker's watches and change hub, over its MessagePort. */
export function createLiveBridge(worker: WorkerClient): LiveBridge {
	return {
		setWatchSet: (dirs) => worker.call<void>("setWatchSet", [dirs]),
		layers: () => worker.call<LiveResync>("layers"),
		// The worker only pushes LiveMessages on this name.
		onMessage: (listener) => worker.onPush(FS_WORKER_PUSH.live, (message) => listener(message as LiveMessage)),
		onReconnect: (listener) => worker.onRestart(listener),
	};
}
