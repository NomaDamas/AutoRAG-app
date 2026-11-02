import { useSyncExternalStore } from "react";
import type { ErrorFixBridge, ErrorFixEvent } from "../../../shared/error-fix-contract";
import {
	activeErrorFixSession,
	dismissErrorFixStore,
	enqueueErrorFixStore,
	initialErrorFixSession,
	initialErrorFixStore,
	openErrorFixStoreById,
	reduceErrorFixStore,
	removeErrorFixSessionFromStore,
	type ErrorFixSession,
	type ErrorFixStore,
} from "../state/error-fix";

type ErrorFixWindow = Window & { readonly autorag?: { readonly errorFix?: ErrorFixBridge } };

/**
 * Window-wide multi-session store for "AI로 고치기": minimizing or starting a
 * second repair keeps every in-flight and unreviewed background repair in the
 * queue instead of cancelling or overwriting earlier sessions.
 */
let current: ErrorFixStore = initialErrorFixStore;
let cachedActiveSession: ErrorFixSession = initialErrorFixSession;
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;
let boundBridge: ErrorFixBridge | undefined;

function getBridge(): ErrorFixBridge | undefined {
	return (window as ErrorFixWindow).autorag?.errorFix;
}

function publish(next: ErrorFixStore): void {
	if (next === current) return;
	current = next;
	cachedActiveSession = activeErrorFixSession(next);
	for (const listener of listeners) listener();
}

function ensureSubscribed(): void {
	const bridge = getBridge();
	if (bridge === undefined) return;
	if (boundBridge === bridge && unsubscribe !== null) return;
	unsubscribe?.();
	boundBridge = bridge;
	unsubscribe = bridge.onEvent((event: ErrorFixEvent) => {
		publish(reduceErrorFixStore(current, event));
	});
}

function subscribe(listener: () => void): () => void {
	ensureSubscribed();
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Starts a repair (or reopens the modal if the exact same error is already
 * being repaired). Other minimized repairs stay alive in the background queue.
 */
export function startErrorFix(message: string): void {
	ensureSubscribed();
	const existing = current.sessions.find((entry) => entry.run.status === "running" && entry.message === message);
	if (existing !== undefined) {
		publish(openErrorFixStoreById(current, existing.id));
		return;
	}
	const runId = crypto.randomUUID();
	publish(enqueueErrorFixStore(current, runId, message));
	const bridge = getBridge();
	if (bridge === undefined) return;
	bridge.start(runId, { message, surface: "ai-search" }).catch((error: unknown) => {
		const reason = error instanceof Error ? error.message : String(error);
		publish(reduceErrorFixStore(current, { type: "error", runId, message: reason, changes: [], backupPath: null }));
	});
}

/** Retries the currently open dialog session's error message. */
export function retryErrorFix(): void {
	const active = current.activeId === null ? undefined : current.sessions.find((entry) => entry.id === current.activeId);
	if (active === undefined) return;
	publish(removeErrorFixSessionFromStore(current, active.id));
	startErrorFix(active.message);
}

/** Explicitly stops the currently open running repair (only the Stop button calls this). */
export function stopErrorFix(): void {
	const active = current.activeId === null ? undefined : current.sessions.find((entry) => entry.id === current.activeId);
	if (active?.run.status === "running") {
		void getBridge()?.cancel(active.run.runId);
	}
}

/** Reopens a minimized or background-completed repair modal (by id, or the first background session). */
export function openErrorFixDialog(id?: string): void {
	const targetId = id ?? current.sessions[0]?.id;
	if (targetId !== undefined) publish(openErrorFixStoreById(current, targetId));
}

/** Hides the modal if still running (continues in background), or clears ONLY the reviewed finished session. */
export function dismissErrorFixDialog(): void {
	publish(dismissErrorFixStore(current));
}

/** Resets store state between unit tests. */
export function resetErrorFixStoreForTests(): void {
	unsubscribe?.();
	unsubscribe = null;
	boundBridge = undefined;
	current = initialErrorFixStore;
	cachedActiveSession = initialErrorFixSession;
	for (const listener of listeners) listener();
}

export function useErrorFixStore(): ErrorFixStore {
	return useSyncExternalStore(
		subscribe,
		() => current,
		() => initialErrorFixStore,
	);
}

export function useErrorFixSession(): ErrorFixSession {
	return useSyncExternalStore(
		subscribe,
		() => cachedActiveSession,
		() => initialErrorFixSession,
	);
}
