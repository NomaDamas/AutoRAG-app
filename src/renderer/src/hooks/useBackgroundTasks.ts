import { useSyncExternalStore } from "react";

export type BackgroundTaskKind = "reduce-size" | "convert-rename" | "compress" | "custom";
export type BackgroundTaskState = "queued" | "running" | "done" | "failed";

export interface BackgroundTaskItem {
	readonly id: string;
	readonly kind: BackgroundTaskKind;
	readonly state: BackgroundTaskState;
	/** `0` when queued, `null` or `0..99` when running, `100` when done/failed. */
	readonly percent: number | null;
	readonly headline: string;
	readonly queuedHeadline?: string | undefined;
	readonly doneHeadline: string;
	readonly failedHeadline: string;
	readonly detail: string | null;
	readonly error: string | null;
	readonly ariaLabel?: string | undefined;
	readonly onSelect?: (() => void) | undefined;
}

export interface BackgroundTaskRequest<T> {
	readonly id: string;
	readonly kind: BackgroundTaskKind;
	readonly headline: string;
	readonly queuedHeadline?: string | undefined;
	readonly doneHeadline: string;
	readonly failedHeadline: string;
	readonly detail: string | null;
	readonly ariaLabel?: string | undefined;
	readonly onSelect?: (() => void) | undefined;
	readonly onCancel?: (() => void) | undefined;
	readonly run: () => Promise<T>;
}

const DONE_LINGER_MS = 4_000;
const FAILED_LINGER_MS = 10_000;

interface InternalTask {
	item: BackgroundTaskItem;
	readonly run: () => Promise<unknown>;
	readonly resolve: (value: unknown) => void;
	readonly reject: (reason?: unknown) => void;
	readonly onCancel?: (() => void) | undefined;
	cancelled: boolean;
	lingerTimer: unknown;
}

const entries: InternalTask[] = [];
let snapshot: readonly BackgroundTaskItem[] = [];
let draining = false;
const listeners = new Set<() => void>();

function emit(): void {
	snapshot = entries.map((entry) => entry.item);
	for (const listener of listeners) listener();
}

function removeEntry(id: string): void {
	const index = entries.findIndex((entry) => entry.item.id === id);
	if (index < 0) return;
	const [removed] = entries.splice(index, 1);
	clearTimeout(removed?.lingerTimer as number | undefined);
	emit();
}

function scheduleRemoval(task: InternalTask, delayMs: number): void {
	clearTimeout(task.lingerTimer as number | undefined);
	task.lingerTimer = setTimeout(() => {
		removeEntry(task.item.id);
	}, delayMs);
}

function pumpQueue(): void {
	if (draining) return;
	const next = entries.find((entry) => entry.item.state === "queued" && !entry.cancelled);
	if (next === undefined) return;
	draining = true;
	next.item = { ...next.item, state: "running", percent: null };
	emit();

	void (async () => {
		try {
			const value = await next.run();
			if (next.cancelled) return;
			next.item = { ...next.item, state: "done", percent: 100 };
			emit();
			scheduleRemoval(next, DONE_LINGER_MS);
			next.resolve(value);
		} catch (error) {
			if (next.cancelled) return;
			const message = error instanceof Error ? error.message : String(error);
			next.item = { ...next.item, state: "failed", percent: 100, error: message };
			emit();
			scheduleRemoval(next, FAILED_LINGER_MS);
			next.reject(error);
		} finally {
			draining = false;
			pumpQueue();
		}
	})();
}

/**
 * Enqueues a background task (`reduce-size`, `convert-rename`, etc.) into the
 * window-wide FIFO runner so multiple file operations queue cleanly in the
 * bottom-left sidebar instead of blocking the window or overwriting each other.
 */
export function enqueueBackgroundTask<T>(request: BackgroundTaskRequest<T>): Promise<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	const item: BackgroundTaskItem = {
		id: request.id,
		kind: request.kind,
		state: "queued",
		percent: 0,
		headline: request.headline,
		queuedHeadline: request.queuedHeadline,
		doneHeadline: request.doneHeadline,
		failedHeadline: request.failedHeadline,
		detail: request.detail,
		error: null,
		ariaLabel: request.ariaLabel,
		onSelect: request.onSelect,
	};
	entries.push({
		item,
		run: request.run,
		resolve: resolve as (value: unknown) => void,
		reject,
		onCancel: request.onCancel,
		cancelled: false,
		lingerTimer: undefined,
	});
	emit();
	pumpQueue();
	return promise;
}

export function updateBackgroundTaskProgress(id: string, percent: number | null): void {
	const entry = entries.find((candidate) => candidate.item.id === id);
	if (entry === undefined || entry.item.state !== "running") return;
	const clamped = percent === null ? null : Math.max(0, Math.min(99, Math.round(percent)));
	if (entry.item.percent === clamped) return;
	entry.item = { ...entry.item, percent: clamped };
	emit();
}

export function cancelBackgroundTask(id: string): void {
	const entry = entries.find((candidate) => candidate.item.id === id);
	if (entry === undefined || entry.cancelled) return;
	const wasRunning = entry.item.state === "running";
	entry.cancelled = true;
	removeEntry(id);
	if (wasRunning) entry.onCancel?.();
	entry.reject(new Error("Task cancelled"));
}

export function getBackgroundTasksSnapshot(): readonly BackgroundTaskItem[] {
	return snapshot;
}

export function clearBackgroundTasksForTests(): void {
	for (const entry of entries) {
		entry.cancelled = true;
		clearTimeout(entry.lingerTimer as number | undefined);
	}
	entries.length = 0;
	snapshot = [];
	draining = false;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

const EMPTY_TASKS: readonly BackgroundTaskItem[] = [];

export function useBackgroundTasks(): readonly BackgroundTaskItem[] {
	return useSyncExternalStore(
		subscribe,
		() => snapshot,
		() => EMPTY_TASKS,
	);
}
