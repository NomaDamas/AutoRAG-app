import { useSyncExternalStore } from "react";
import type { ErrorFixBridge, ErrorFixEvent } from "../../../shared/error-fix-contract";
import {
	beginErrorFixSession,
	dismissErrorFixSession,
	initialErrorFixSession,
	openErrorFixSession,
	reduceErrorFixSession,
	type ErrorFixSession,
} from "../state/error-fix";

type ErrorFixWindow = Window & { readonly autorag?: { readonly errorFix?: ErrorFixBridge } };

/**
 * Window-wide singleton for the "AI로 고치기" session so minimizing or closing
 * the modal keeps the repair running in the background while the sidebar shows
 * live progress, and clicking the sidebar block reopens the modal at any time.
 */
let current: ErrorFixSession = initialErrorFixSession;
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;
let boundBridge: ErrorFixBridge | undefined;

function getBridge(): ErrorFixBridge | undefined {
	return (window as ErrorFixWindow).autorag?.errorFix;
}

function publish(next: ErrorFixSession): void {
	if (next === current) return;
	current = next;
	for (const listener of listeners) listener();
}

function ensureSubscribed(): void {
	const bridge = getBridge();
	if (bridge === undefined) return;
	if (boundBridge === bridge && unsubscribe !== null) return;
	unsubscribe?.();
	boundBridge = bridge;
	unsubscribe = bridge.onEvent((event: ErrorFixEvent) => {
		publish(reduceErrorFixSession(current, event));
	});
}

function subscribe(listener: () => void): () => void {
	ensureSubscribed();
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Starts a repair (or reopens the modal if the exact same error is already being repaired). */
export function startErrorFix(message: string): void {
	ensureSubscribed();
	if (current.run.status === "running" && current.message === message) {
		publish(openErrorFixSession(current));
		return;
	}
	if (current.run.status === "running") {
		void getBridge()?.cancel(current.run.runId);
	}
	const runId = crypto.randomUUID();
	publish(beginErrorFixSession(runId, message));
	const bridge = getBridge();
	if (bridge === undefined) return;
	bridge.start(runId, { message, surface: "ai-search" }).catch((error: unknown) => {
		const reason = error instanceof Error ? error.message : String(error);
		publish(reduceErrorFixSession(current, { type: "error", runId, message: reason, changes: [], backupPath: null }));
	});
}

/** Retries the current session's error message from the dialog. */
export function retryErrorFix(): void {
	if (current.message !== null) startErrorFix(current.message);
}

/** Explicitly stops a running repair (only the Stop button calls this). */
export function stopErrorFix(): void {
	if (current.run.status === "running") {
		void getBridge()?.cancel(current.run.runId);
	}
}

/** Reopens a minimized or background-completed repair modal. */
export function openErrorFixDialog(): void {
	publish(openErrorFixSession(current));
}

/** Hides the modal if still running (continues in background), or clears the finished session. */
export function dismissErrorFixDialog(): void {
	publish(dismissErrorFixSession(current));
}

/** Resets store state between unit tests. */
export function resetErrorFixStoreForTests(): void {
	unsubscribe?.();
	unsubscribe = null;
	boundBridge = undefined;
	current = initialErrorFixSession;
	for (const listener of listeners) listener();
}

export function useErrorFixSession(): ErrorFixSession {
	return useSyncExternalStore(
		subscribe,
		() => current,
		() => initialErrorFixSession,
	);
}
