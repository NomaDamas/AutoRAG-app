import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AutoRagConfigSnapshot, JsonObject } from "../../../../shared/settings-contract";

/**
 * Serialized, debounced config writes for Settings panels.
 *
 * Guarantees:
 * - at most one write is in flight; requests arriving during a write coalesce to
 *   the latest payload and drain afterwards (no overlapping writes);
 * - `queue` debounces text/number edits while `flush` writes selects, toggles,
 *   and blur immediately;
 * - a payload whose write rejects is remembered by its `key`, so the same edit
 *   is attempted once and then waits for a *new* edit instead of looping;
 * - unmount flushes a pending debounced write, so switching Settings tabs
 *   cannot drop a committed input.
 */
export interface AutoSaveOptions<T> {
	/**
	 * Stable semantic identity of a payload (trimmed/normalized). Equal keys are
	 * the same edit; a failed key is not retried until it changes.
	 */
	readonly key: (value: T) => string;
	/** Performs one write. A rejection marks the current payload as failed. */
	readonly perform: (value: T) => Promise<void>;
	/** Debounce before a queued text/number write fires. */
	readonly delayMs?: number | undefined;
}

export interface AutoSaveHandle<T> {
	/** Debounced write of `value` (text/number edits). */
	queue(value: T): void;
	/** Write `value`, or the pending payload, now and cancel the debounce. */
	flush(value?: T | undefined): void;
	/** Drop a pending debounced payload without writing it (reset). */
	cancel(): void;
	/** Resolve once no write is pending or in flight. */
	drain(): Promise<void>;
	/** True while a write is scheduled or in flight. */
	readonly busy: boolean;
}

interface PendingWrite<T> {
	readonly value: T;
	readonly key: string;
}

/**
 * Freshest known config object for a panel.
 *
 * A write's `perform` normally reads the `snapshot` prop to diff leaves, but the
 * prop lags a just-completed write until React re-renders. When two writes drain
 * back-to-back (e.g. type then clear), the second would diff against the stale
 * prop and skip a leaf it must change. Panels record each write response through
 * `record`, and the hook adopts a new snapshot prop only when it is not the echo
 * of a local write — so an older echo can never move the ref backwards past a
 * newer local response.
 */
export interface LatestConfig {
	/** Freshest known config object; safe to read at write time. */
	readonly current: JsonObject;
	/** Record a config object returned by a local write. */
	record(config: JsonObject): void;
}

export function useLatestConfig(snapshot: AutoRagConfigSnapshot): LatestConfig {
	const snapshotRef = useRef(snapshot);
	const configRef = useRef<JsonObject>(snapshot.config);
	const localWritesRef = useRef(new WeakSet<object>());
	useEffect(() => {
		if (snapshotRef.current === snapshot) return;
		snapshotRef.current = snapshot;
		// A snapshot produced by our own write is already in `configRef` (possibly
		// superseded by a newer local write); keep the newest.
		if (localWritesRef.current.has(snapshot.config)) return;
		configRef.current = snapshot.config;
	}, [snapshot]);
	return useMemo(
		() => ({
			get current(): JsonObject {
				return configRef.current;
			},
			record(config: JsonObject): void {
				localWritesRef.current.add(config);
				configRef.current = config;
			},
		}),
		[],
	);
}

export function useAutoSave<T>(options: AutoSaveOptions<T>): AutoSaveHandle<T> {
	const performRef = useRef(options.perform);
	performRef.current = options.perform;
	const keyRef = useRef(options.key);
	keyRef.current = options.key;
	const delayMs = options.delayMs ?? 350;

	const timerRef = useRef<number | null>(null);
	const pendingRef = useRef<PendingWrite<T> | null>(null);
	const activeKeyRef = useRef<string | null>(null);
	const failedKeyRef = useRef<string | null>(null);
	const runningRef = useRef(false);
	const mountedRef = useRef(true);
	const waitersRef = useRef<Array<() => void>>([]);
	const [busy, setBusy] = useState(false);

	const clearTimer = useCallback((): void => {
		if (timerRef.current !== null) {
			window.clearTimeout(timerRef.current);
			timerRef.current = null;
		}
	}, []);

	const settle = useCallback((): void => {
		if (runningRef.current || pendingRef.current !== null) return;
		const waiters = waitersRef.current;
		waitersRef.current = [];
		for (const waiter of waiters) waiter();
	}, []);

	const kick = useCallback((): void => {
		if (runningRef.current) return;
		clearTimer();
		const item = pendingRef.current;
		if (item === null) {
			settle();
			return;
		}
		pendingRef.current = null;
		runningRef.current = true;
		activeKeyRef.current = item.key;
		if (mountedRef.current) setBusy(true);
		let result: Promise<void>;
		try {
			result = performRef.current(item.value);
		} catch (cause) {
			result = Promise.reject(cause);
		}
		result
			.catch(() => {
				// The panel surfaces the error; remember the key so it is not retried.
				failedKeyRef.current = item.key;
			})
			.finally(() => {
				runningRef.current = false;
				activeKeyRef.current = null;
				if (mountedRef.current) setBusy(pendingRef.current !== null);
				kick();
			});
	}, [clearTimer, settle]);

	const queue = useCallback(
		(value: T): void => {
			const key = keyRef.current(value);
			if (key === activeKeyRef.current) {
				// The latest edit equals the write already in flight: drop any queued
				// intermediate payload so it cannot drain and win afterwards.
				if (pendingRef.current !== null) {
					pendingRef.current = null;
					clearTimer();
					if (mountedRef.current) setBusy(activeKeyRef.current !== null);
				}
				return;
			}
			if (pendingRef.current !== null && pendingRef.current.key === key) return;
			if (key === failedKeyRef.current) return;
			failedKeyRef.current = null;
			pendingRef.current = { value, key };
			clearTimer();
			if (mountedRef.current) setBusy(true);
			timerRef.current = window.setTimeout(() => {
				timerRef.current = null;
				kick();
			}, delayMs);
		},
		[clearTimer, kick, delayMs],
	);

	const flush = useCallback(
		(value?: T): void => {
			if (value !== undefined) {
				const key = keyRef.current(value);
				if (key === activeKeyRef.current) {
					// Latest edit equals the in-flight write: drop a queued intermediate.
					if (pendingRef.current !== null) {
						pendingRef.current = null;
						clearTimer();
					}
				} else if (key !== failedKeyRef.current) {
					const alreadyPending = pendingRef.current !== null && pendingRef.current.key === key;
					if (!alreadyPending) {
						failedKeyRef.current = null;
						pendingRef.current = { value, key };
					}
				}
			}
			kick();
		},
		[kick, clearTimer],
	);

	const cancel = useCallback((): void => {
		clearTimer();
		pendingRef.current = null;
		failedKeyRef.current = null;
		if (mountedRef.current) setBusy(activeKeyRef.current !== null);
		settle();
	}, [clearTimer, settle]);

	const drain = useCallback((): Promise<void> => {
		if (!runningRef.current && pendingRef.current === null) return Promise.resolve();
		return new Promise<void>((resolve) => {
			waitersRef.current.push(resolve);
		});
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			clearTimer();
			// Flush a pending debounced write so a tab switch cannot drop it.
			kick();
		};
	}, [clearTimer, kick]);

	return useMemo(
		() => ({ queue, flush, cancel, drain, busy }),
		[queue, flush, cancel, drain, busy],
	);
}
