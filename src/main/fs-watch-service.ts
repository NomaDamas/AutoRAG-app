import { stat as fsStat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { FsChange, FsDirChange } from "../shared/live-contract";
import { RECENTS_PATH } from "../shared/fs-contract";
import type { WatchBackend } from "./watch-backend";

const CONTACTS_PATH = "Contacts"; // Must match src/renderer/src/state/tabs.ts:124.
const TRAILING_MS = 150;
const MAX_WAIT_MS = 1000;

interface TimerApi {
	readonly set: (handler: () => void, ms: number) => unknown;
	readonly clear: (handle: unknown) => void;
}

export interface FsWatchServiceDeps {
	readonly backend: WatchBackend;
	readonly onBatch: (batch: FsDirChange) => void;
	readonly stat?: (dir: string) => Promise<boolean>;
	readonly setTimer?: (handler: () => void, ms: number) => unknown;
	readonly clearTimer?: (handle: unknown) => void;
	readonly now?: () => number;
}

export interface FsWatchService {
	setWatchSet(dirs: readonly string[]): Promise<void>;
	dispose(): Promise<void>;
}

interface PendingBatch {
	readonly changes: FsChange[];
	readonly startedAt: number;
	trailingTimer: unknown;
	maxWaitTimer: unknown;
}

interface WatchState {
	readonly unsubscribe: () => Promise<void>;
	pending: PendingBatch | null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function normalizedWatchSet(dirs: readonly string[]): string[] {
	const result = new Set<string>();
	for (const input of dirs) {
		if (!isAbsolute(input)) continue;
		if (input === "/kakao" || input.startsWith("/kakao/")) continue;
		const dir = resolve(input);
		if (dir === RECENTS_PATH || dir === CONTACTS_PATH) continue;
		result.add(dir);
	}
	return [...result];
}

export function createFsWatchService(deps: FsWatchServiceDeps): FsWatchService {
	const timers: TimerApi = {
		set: deps.setTimer ?? ((handler, ms) => setTimeout(handler, ms)),
		clear: deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout)),
	};
	const stat = deps.stat ?? (async (dir: string) => (await fsStat(dir)).isDirectory());
	const now = deps.now ?? (() => Date.now());
	const watches = new Map<string, WatchState>();
	let operation = Promise.resolve();
	let disposed = false;
	const diagnostics = process.env.AUTORAG_FS_WATCH_DIAG === "1";

	const logError = (dir: string, error: unknown): void => {
		console.error(`[fs-watch] ${dir}: ${errorMessage(error)}`);
	};

	const clearPendingTimers = (pending: PendingBatch): void => {
		timers.clear(pending.trailingTimer);
		timers.clear(pending.maxWaitTimer);
	};

	const emitBatch = (
		dir: string,
		state: WatchState,
		overflow = false,
		dirGone = false,
		changesOverride?: readonly FsChange[],
	): void => {
		const pending = state.pending;
		if (pending !== null) {
			clearPendingTimers(pending);
			state.pending = null;
		}
		const changes = changesOverride ?? pending?.changes ?? [];
		if (diagnostics) console.info(`[fs-watch] batch ${dir} ${changes.length}`);
		deps.onBatch({ dir, changes, overflow, dirGone });
	};

	const unsubscribe = async (dir: string): Promise<void> => {
		const state = watches.get(dir);
		if (state === undefined) return;
		watches.delete(dir);
		if (state.pending !== null) clearPendingTimers(state.pending);
		if (diagnostics) console.info(`[fs-watch] unwatch ${dir}`);
		try {
			await state.unsubscribe();
		} catch (error) {
			logError(dir, error);
		}
	};

	const handleFailure = async (dir: string, state: WatchState, error: unknown): Promise<void> => {
		logError(dir, error);
		const exists = await stat(dir).catch((statError: unknown) => {
			logError(dir, statError);
			return false;
		});
		if (!exists) {
			emitBatch(dir, state, false, true);
			await unsubscribe(dir);
			return;
		}
		emitBatch(dir, state, true, false);
	};

	const subscribe = async (dir: string): Promise<void> => {
		try {
			const state: WatchState = {
				unsubscribe: await deps.backend.subscribe(
					dir,
					(events) => {
						const filtered = events.filter((event) => event.path === dir || dirname(event.path) === dir);
						if (filtered.some((event) => event.path === dir && event.type === "delete")) {
							const current = watches.get(dir);
							if (current !== undefined) {
								void stat(dir)
									.then(async (exists) => {
										if (exists) {
											emitBatch(dir, current, true, false);
											return;
										}
										emitBatch(dir, current, false, true, []);
										await unsubscribe(dir);
									})
									.catch((error: unknown) => void handleFailure(dir, current, error));
							}
							return;
						}
						for (const event of filtered) {
							const current = watches.get(dir);
							if (current === undefined) return;
							let pending = current.pending;
							if (pending === null) {
								pending = {
									changes: [],
									startedAt: now(),
									trailingTimer: undefined,
									maxWaitTimer: undefined,
								};
								pending.maxWaitTimer = timers.set(() => emitBatch(dir, current), MAX_WAIT_MS);
								current.pending = pending;
							}
							const previous = pending.changes[pending.changes.length - 1];
							if (previous?.path !== event.path || previous.type !== event.type) {
								pending.changes.push(event);
							}
							timers.clear(pending.trailingTimer);
							const elapsed = now() - pending.startedAt;
							pending.trailingTimer = timers.set(
								() => emitBatch(dir, current),
								Math.max(0, Math.min(TRAILING_MS, MAX_WAIT_MS - elapsed)),
							);
						}
					},
					(error) => {
						const current = watches.get(dir);
						if (current !== undefined) void handleFailure(dir, current, error);
					},
				),
				pending: null,
			};
			if (disposed) {
				await state.unsubscribe();
				return;
			}
			watches.set(dir, state);
			if (diagnostics) console.info(`[fs-watch] watch ${dir}`);
		} catch (error) {
			logError(dir, error);
			const exists = await stat(dir).catch((statError: unknown) => {
				logError(dir, statError);
				return false;
			});
			deps.onBatch({ dir, changes: [], overflow: exists, dirGone: !exists });
		}
	};

	const enqueue = (task: () => Promise<void>): Promise<void> => {
		const next = operation.then(task, task);
		operation = next.catch((error: unknown) => {
			console.error("[fs-watch] watch operation failed:", error);
		});
		return next;
	};

	return {
		setWatchSet(dirs) {
			return enqueue(async () => {
				if (disposed) return;
				const wanted = new Set(normalizedWatchSet(dirs));
				await Promise.all([...watches.keys()].filter((dir) => !wanted.has(dir)).map(unsubscribe));
				for (const dir of wanted) {
					if (!watches.has(dir)) await subscribe(dir);
				}
			});
		},
		dispose() {
			return enqueue(async () => {
				disposed = true;
				await Promise.all([...watches.keys()].map(unsubscribe));
			});
		},
	};
}
