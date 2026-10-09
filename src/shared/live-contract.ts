export type FsChangeType = "create" | "update" | "delete";

export interface FsChange {
	readonly path: string;
	readonly type: FsChangeType;
}

/** One coalesced batch for one watched directory. `dirGone`: the directory itself no longer exists; `overflow`: events were lost, relist. */
export interface FsDirChange {
	readonly dir: string;
	readonly changes: readonly FsChange[];
	readonly overflow: boolean;
	readonly dirGone: boolean;
}

export interface LayerPublication<T = unknown> {
	readonly layer: string;
	readonly version: number;
	readonly data: T;
}

/** Every push is totally ordered by seq; layers of a message are already reconciled with its dirs ("layers-before-view"). */
/** `reconciled`: ids of layers whose applyChanges finished for this message's dirs (changed or not); a timed-out or failed layer is absent. */
export interface LiveMessage {
	readonly seq: number;
	readonly dirs: readonly FsDirChange[];
	readonly layers: readonly LayerPublication[];
	readonly reconciled: readonly string[];
}

export interface LiveResync {
	readonly seq: number;
	readonly layers: readonly LayerPublication[];
	readonly reconciled: readonly string[];
}

export interface LiveBridge {
	setWatchSet(dirs: readonly string[]): Promise<void>;
	layers(): Promise<LiveResync>;
	onMessage(listener: (message: LiveMessage) => void): () => void;
	/**
	 * The filesystem worker restarted (it crashed or was killed) and kept
	 * nothing: no watches, and message `seq` starts over. Re-send the watch
	 * set and re-read what is on screen.
	 */
	onReconnect(listener: () => void): () => void;
}

export const DUPEY_LAYER_ID = "dupey";
