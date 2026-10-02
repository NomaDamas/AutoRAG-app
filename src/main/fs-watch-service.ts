import { realpath, stat as fsStat } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { FsChange, FsDirChange } from "../shared/live-contract";
import { RECENTS_PATH } from "../shared/fs-contract";
import type { WatchBackend } from "./watch-backend";

const CONTACTS_PATH = "Contacts"; // Must match src/renderer/src/state/tabs.ts:124.
const TRAILING_MS = 150;
const MAX_WAIT_MS = 1000;
/** How often a wanted directory without a live subscription is probed for recreation. */
const RETRY_MS = 1000;

interface TimerApi {
	readonly set: (handler: () => void, ms: number) => unknown;
	readonly clear: (handle: unknown) => void;
}

export interface FsWatchServiceDeps {
	readonly backend: WatchBackend;
	readonly onBatch: (batch: FsDirChange) => void;
	readonly stat?: (dir: string) => Promise<boolean>;
	/** Resolves a user-visible directory to the path the native watcher reports back. Defaults to `fs.realpath`. */
	readonly canonicalize?: (dir: string) => Promise<string>;
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
	/** The user-visible directory a tab opened; every emitted path is translated back to this root. */
	readonly alias: string;
	/** The last known real path the native watcher was told about; events arrive as children of this. */
	canonical: string;
	/** Bumped whenever a subscription is torn down so late callbacks from superseded watches are ignored. */
	generation: number;
	unsubscribe: (() => Promise<void>) | null;
	pending: PendingBatch | null;
	/** No live subscription: the directory is absent, errored, or waiting for the retry timer. */
	missing: boolean;
}

type AttachResult =
	| { readonly kind: "attached" }
	| { readonly kind: "recovered" }
	| { readonly kind: "missing"; readonly exists: boolean }
	| { readonly kind: "stale" };

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
	const canonicalize = deps.canonicalize ?? realpath;
	const now = deps.now ?? (() => Date.now());
	const watches = new Map<string, WatchState>();
	let wanted = new Set<string>();
	let operation = Promise.resolve();
	let disposed = false;
	let retryArmed = false;
	let retryTimer: unknown = null;
	const diagnostics = process.env.AUTORAG_FS_WATCH_DIAG === "1";

	const logError = (dir: string, error: unknown): void => {
		console.error(`[fs-watch] ${dir}: ${errorMessage(error)}`);
	};

	const clearPendingTimers = (pending: PendingBatch): void => {
		timers.clear(pending.trailingTimer);
		timers.clear(pending.maxWaitTimer);
	};

	const emitBatch = (
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
		if (diagnostics) console.info(`[fs-watch] batch ${state.alias} ${changes.length}`);
		deps.onBatch({ dir: state.alias, changes, overflow, dirGone });
	};

	/** Translate a native (canonical) path back to the user-visible alias for its watch. */
	const mapEvent = (state: WatchState, event: FsChange): FsChange | null => {
		const path = event.path;
		if (path === state.canonical) return { path: state.alias, type: event.type };
		if (path.startsWith(state.canonical + sep)) {
			return { path: state.alias + path.slice(state.canonical.length), type: event.type };
		}
		return null;
	};

	const current = (state: WatchState, generation: number): boolean =>
		watches.get(state.alias) === state && state.generation === generation && !disposed && wanted.has(state.alias);

	/** Drop the live subscription and invalidate any callback still in flight from it. */
	const detach = async (state: WatchState): Promise<void> => {
		state.generation += 1;
		const unsubscribe = state.unsubscribe;
		state.unsubscribe = null;
		if (state.pending !== null) {
			clearPendingTimers(state.pending);
			state.pending = null;
		}
		if (diagnostics) console.info(`[fs-watch] unwatch ${state.alias}`);
		if (unsubscribe !== null) {
			try {
				await unsubscribe();
			} catch (error) {
				logError(state.alias, error);
			}
		}
	};

	const onEvents = (state: WatchState, generation: number, events: readonly FsChange[]): void => {
		if (!current(state, generation)) return;
		const direct: FsChange[] = [];
		let rootDelete = false;
		for (const event of events) {
			const change = mapEvent(state, event);
			if (change === null) continue;
			if (change.path === state.alias) {
				if (change.type === "delete") {
					rootDelete = true;
					continue;
				}
			} else if (dirname(change.path) !== state.alias) {
				// Recursive subtree traffic is suppressed natively in the backend; never forward it.
				continue;
			}
			direct.push(change);
		}
		if (rootDelete) {
			// The native stream dies when its root is removed; tear it down and reattach if possible.
			void enqueue(() => handleRootDelete(state));
			return;
		}
		for (const event of direct) {
			if (!current(state, generation)) return;
			let pending = state.pending;
			if (pending === null) {
				pending = {
					changes: [],
					startedAt: now(),
					trailingTimer: undefined,
					maxWaitTimer: undefined,
				};
				pending.maxWaitTimer = timers.set(() => emitBatch(state), MAX_WAIT_MS);
				state.pending = pending;
			}
			const previous = pending.changes[pending.changes.length - 1];
			if (previous?.path !== event.path || previous.type !== event.type) {
				pending.changes.push(event);
			}
			timers.clear(pending.trailingTimer);
			const elapsed = now() - pending.startedAt;
			pending.trailingTimer = timers.set(
				() => emitBatch(state),
				Math.max(0, Math.min(TRAILING_MS, MAX_WAIT_MS - elapsed)),
			);
		}
	};

	const onError = (state: WatchState, generation: number, error: Error): void => {
		if (!current(state, generation)) return;
		void enqueue(() => handleFailure(state, error));
	};

	const handleFailure = async (state: WatchState, error: unknown): Promise<void> => {
		if (watches.get(state.alias) !== state || disposed) return;
		logError(state.alias, error);
		const exists = await stat(state.canonical).catch((statError: unknown) => {
			logError(state.alias, statError);
			return false;
		});
		if (watches.get(state.alias) !== state || disposed) return;
		if (!exists) {
			state.missing = true;
			emitBatch(state, false, true, []);
			await detach(state);
			armRetry();
			return;
		}
		emitBatch(state, true, false, []);
	};

	const handleRootDelete = async (state: WatchState): Promise<void> => {
		if (watches.get(state.alias) !== state || disposed) return;
		await detach(state);
		if (watches.get(state.alias) !== state || disposed) return;
		state.missing = true;
		const result = await attach(state);
		if (result.kind === "recovered") {
			// Events during the gap were lost; ask listeners to relist.
			emitBatch(state, true, false, []);
		} else if (result.kind === "missing") {
			emitBatch(state, result.exists, !result.exists, []);
		}
	};

	/**
	 * Resolve `state.alias`, subscribe to its real path, and record the live subscription.
	 * Never emits; callers report the outcome to listeners.
	 */
	const attach = async (state: WatchState): Promise<AttachResult> => {
		const alias = state.alias;
		if (disposed || !wanted.has(alias) || state.unsubscribe !== null) return { kind: "stale" };
		const generation = state.generation;
		let canonical: string;
		try {
			canonical = await canonicalize(alias);
		} catch {
			if (!current(state, generation)) return { kind: "stale" };
			state.missing = true;
			armRetry();
			return { kind: "missing", exists: false };
		}
		if (!current(state, generation)) return { kind: "stale" };
		state.canonical = canonical;
		let unsubscribe: () => Promise<void>;
		try {
			unsubscribe = await deps.backend.subscribe(
				canonical,
				(events) => onEvents(state, generation, events),
				(error) => onError(state, generation, error),
			);
		} catch (error) {
			logError(alias, error);
			const exists = await stat(canonical).catch((statError: unknown) => {
				logError(alias, statError);
				return false;
			});
			if (!current(state, generation)) return { kind: "stale" };
			state.missing = true;
			armRetry();
			return { kind: "missing", exists };
		}
		if (!current(state, generation)) {
			try {
				await unsubscribe();
			} catch (error) {
				logError(alias, error);
			}
			return { kind: "stale" };
		}
		state.unsubscribe = unsubscribe;
		const recovered = state.missing;
		state.missing = false;
		if (diagnostics) console.info(`[fs-watch] watch ${alias} -> ${canonical}`);
		stopRetryIfIdle();
		return recovered ? { kind: "recovered" } : { kind: "attached" };
	};

	const cancelRetry = (): void => {
		if (retryTimer !== null) timers.clear(retryTimer);
		retryTimer = null;
		retryArmed = false;
	};

	const stopRetryIfIdle = (): void => {
		if (disposed) {
			cancelRetry();
			return;
		}
		for (const alias of wanted) {
			if (watches.get(alias)?.missing === true) return;
		}
		cancelRetry();
	};

	const armRetry = (): void => {
		if (disposed || retryArmed) return;
		retryArmed = true;
		retryTimer = timers.set(() => {
			retryArmed = false;
			retryTimer = null;
			void enqueue(retryMissing);
		}, RETRY_MS);
	};

	const retryMissing = async (): Promise<void> => {
		if (disposed) return;
		for (const alias of wanted) {
			const state = watches.get(alias);
			if (state === undefined || !state.missing) continue;
			const result = await attach(state);
			if (result.kind === "recovered") emitBatch(state, true, false, []);
		}
		stopRetryIfIdle();
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
				const next = new Set(normalizedWatchSet(dirs));
				wanted = next;
				for (const [alias, state] of [...watches]) {
					if (!next.has(alias)) {
						watches.delete(alias);
						await detach(state);
					}
				}
				for (const alias of next) {
					const state = watches.get(alias);
					if (state === undefined) {
						const created: WatchState = {
							alias,
							canonical: alias,
							generation: 0,
							unsubscribe: null,
							pending: null,
							missing: false,
						};
						watches.set(alias, created);
						const result = await attach(created);
						if (result.kind === "missing") emitBatch(created, result.exists, !result.exists, []);
					} else if (state.missing) {
						// Same watch set re-sent (e.g. tab focus): recover a directory that came back.
						const result = await attach(state);
						if (result.kind === "recovered") emitBatch(state, true, false, []);
					}
				}
				stopRetryIfIdle();
			});
		},
		dispose() {
			return enqueue(async () => {
				disposed = true;
				cancelRetry();
				await Promise.all([...watches.values()].map((state) => detach(state)));
				watches.clear();
				wanted.clear();
			});
		},
	};
}
