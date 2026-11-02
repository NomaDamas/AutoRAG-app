import { createActivityJournal, type ActivityItemSeed, type ActivityJournal } from "./index-activity-journal";
import { acquireRefreshLock, isLockHeld, type RefreshLock, type RefreshLockHolder } from "./refresh-lock";
import type { SchedulePaths } from "./refresh-schedule";

export interface RefreshQueueOutcome {
	readonly ok: boolean;
	readonly error: string | null;
}

export interface RefreshQueueRequest<T extends RefreshQueueOutcome, Busy> {
	readonly item: ActivityItemSeed;
	readonly owner: string;
	readonly work: () => Promise<T>;
	readonly onBusy: (holder: RefreshLockHolder) => Busy;
}

export interface RefreshQueue {
	enqueue<T extends RefreshQueueOutcome, Busy>(request: RefreshQueueRequest<T, Busy>): Promise<T | Busy>;
}

interface QueuedEntry {
	readonly item: ActivityItemSeed;
	readonly work: () => Promise<RefreshQueueOutcome>;
	readonly resolve: (value: unknown) => void;
	readonly reject: (reason?: unknown) => void;
}

interface ActiveWave {
	readonly lock: RefreshLock;
	readonly journal: ActivityJournal;
	readonly pending: QueuedEntry[];
}

/**
 * Coordinates every in-app manual index refresh and datasource sync into one
 * background FIFO queue under the shared refresh lock.
 *
 * Without this queue, clicking Sync on a second datasource (or refreshing local
 * folders while a datasource syncs) either failed with "busy" or overwrote
 * `activity.json` via `journal.begin(...)`. Here, subsequent items join the
 * live wave immediately as `queued`, appear in `IndexActivitySnapshot.items`,
 * and run sequentially until the wave drains.
 */
export function createRefreshQueue(paths: SchedulePaths): RefreshQueue {
	let activeWave: ActiveWave | null = null;
	const coalesced = new Map<string, Promise<unknown>>();

	function startDrain(wave: ActiveWave): void {
		void (async () => {
			try {
				while (wave.pending.length > 0) {
					const next = wave.pending.shift();
					if (next === undefined) break;
					coalesced.delete(next.item.key);
					wave.journal.start(next.item.key);
					try {
						const result = await next.work();
						wave.journal.finish(next.item.key, result.ok, result.error);
						next.resolve(result);
					} catch (error) {
						wave.journal.finish(next.item.key, false, error instanceof Error ? error.message : String(error));
						next.reject(error);
					}
				}
			} finally {
				activeWave = null;
				coalesced.clear();
				wave.journal.end();
				wave.lock.release();
			}
		})();
	}

	return {
		enqueue<T extends RefreshQueueOutcome, Busy>(request: RefreshQueueRequest<T, Busy>): Promise<T | Busy> {
			if (activeWave !== null) {
				const existing = coalesced.get(request.item.key);
				if (existing !== undefined) return existing as Promise<T>;
				const { promise, resolve, reject } = Promise.withResolvers<T>();
				coalesced.set(request.item.key, promise);
				activeWave.pending.push({
					item: request.item,
					work: request.work,
					resolve: resolve as (value: unknown) => void,
					reject,
				});
				activeWave.journal.enqueue([request.item]);
				return promise;
			}

			const lock = acquireRefreshLock(paths.lock, { owner: request.owner });
			if (isLockHeld(lock)) {
				return Promise.resolve(request.onBusy(lock.heldBy));
			}

			const journal = createActivityJournal(paths.activity, { owner: request.owner });
			journal.begin([request.item]);
			const { promise, resolve, reject } = Promise.withResolvers<T>();
			const wave: ActiveWave = {
				lock,
				journal,
				pending: [
					{
						item: request.item,
						work: request.work,
						resolve: resolve as (value: unknown) => void,
						reject,
					},
				],
			};
			activeWave = wave;
			startDrain(wave);
			return promise;
		},
	};
}
