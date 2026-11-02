import { useSyncExternalStore } from "react";
import type { MagicAction } from "../../../shared/context-menu-contract";
import type { MagicActionBridge, MagicActionEvent } from "../../../shared/magic-actions-contract";
import {
	beginMagicActionSession,
	dismissMagicActionSession,
	initialMagicActionSession,
	openMagicActionSession,
	reduceMagicActionSession,
	type MagicActionSession,
} from "../state/magic-action";

type MagicActionWindow = Window & { readonly autorag?: { readonly magicAction?: MagicActionBridge } };

let current: MagicActionSession = initialMagicActionSession;
const listeners = new Set<() => void>();
const onDoneListeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;
let boundBridge: MagicActionBridge | undefined;

function getBridge(): MagicActionBridge | undefined {
	return (window as MagicActionWindow).autorag?.magicAction;
}

function publish(next: MagicActionSession): void {
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
	unsubscribe = bridge.onEvent((event: MagicActionEvent) => {
		publish(reduceMagicActionSession(current, event));
		if (event.type === "done") {
			for (const cb of onDoneListeners) cb();
		}
	});
}

function subscribe(listener: () => void): () => void {
	ensureSubscribed();
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function onMagicActionDone(cb: () => void): () => void {
	onDoneListeners.add(cb);
	return () => {
		onDoneListeners.delete(cb);
	};
}

export function startMagicActionRun(action: MagicAction, paths: readonly string[]): void {
	ensureSubscribed();
	if (current.run.status === "running") {
		void getBridge()?.cancel(current.run.runId);
	}
	const runId = crypto.randomUUID();
	publish(
		beginMagicActionSession({
			runId,
			actionId: action.id,
			actionLabel: action.label,
			executionKind: action.execution.kind,
			paths,
		}),
	);
	const bridge = getBridge();
	if (bridge === undefined) return;
	bridge.start(runId, { actionId: action.id, paths }).catch((error: unknown) => {
		const reason = error instanceof Error ? error.message : String(error);
		publish(
			reduceMagicActionSession(current, {
				type: "error",
				runId,
				actionLabel: action.label,
				message: reason,
			}),
		);
	});
}

export function stopMagicActionRun(): void {
	if (current.run.status === "running") {
		void getBridge()?.cancel(current.run.runId);
	}
}

export function openMagicActionDialog(): void {
	publish(openMagicActionSession(current));
}

export function dismissMagicActionDialog(): void {
	publish(dismissMagicActionSession(current));
}

export function resetMagicActionStoreForTests(): void {
	unsubscribe?.();
	unsubscribe = null;
	boundBridge = undefined;
	current = initialMagicActionSession;
	for (const listener of listeners) listener();
}

export function useMagicActionSession(): MagicActionSession {
	return useSyncExternalStore(
		subscribe,
		() => current,
		() => initialMagicActionSession,
	);
}
