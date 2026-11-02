import { useSyncExternalStore } from "react";
import type { MagicAction } from "../../../shared/context-menu-contract";
import type { MagicActionBridge, MagicActionEvent } from "../../../shared/magic-actions-contract";
import {
	activeMagicActionSession,
	dismissMagicActionStore,
	enqueueMagicActionStore,
	initialMagicActionSession,
	initialMagicActionStore,
	openMagicActionStoreById,
	reduceMagicActionStore,
	type MagicActionSession,
	type MagicActionStore,
} from "../state/magic-action";

type MagicActionWindow = Window & { readonly autorag?: { readonly magicAction?: MagicActionBridge } };

let current: MagicActionStore = initialMagicActionStore;
let cachedActiveSession: MagicActionSession = initialMagicActionSession;
const listeners = new Set<() => void>();
const onDoneListeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;
let boundBridge: MagicActionBridge | undefined;

function getBridge(): MagicActionBridge | undefined {
	return (window as MagicActionWindow).autorag?.magicAction;
}

function publish(next: MagicActionStore): void {
	if (next === current) return;
	current = next;
	cachedActiveSession = activeMagicActionSession(next);
	for (const listener of listeners) listener();
}

function ensureSubscribed(): void {
	const bridge = getBridge();
	if (bridge === undefined) return;
	if (boundBridge === bridge && unsubscribe !== null) return;
	unsubscribe?.();
	boundBridge = bridge;
	unsubscribe = bridge.onEvent((event: MagicActionEvent) => {
		publish(reduceMagicActionStore(current, event));
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
	const runId = crypto.randomUUID();
	publish(
		enqueueMagicActionStore(current, {
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
			reduceMagicActionStore(current, {
				type: "error",
				runId,
				actionLabel: action.label,
				message: reason,
			}),
		);
	});
}

export function stopMagicActionRun(): void {
	const active = current.activeId === null ? undefined : current.sessions.find((entry) => entry.id === current.activeId);
	if (active?.run.status === "running") {
		void getBridge()?.cancel(active.run.runId);
	}
}

export function openMagicActionDialog(id?: string): void {
	const targetId = id ?? current.sessions[0]?.id;
	if (targetId !== undefined) publish(openMagicActionStoreById(current, targetId));
}

export function dismissMagicActionDialog(): void {
	publish(dismissMagicActionStore(current));
}

export function resetMagicActionStoreForTests(): void {
	unsubscribe?.();
	unsubscribe = null;
	boundBridge = undefined;
	current = initialMagicActionStore;
	cachedActiveSession = initialMagicActionSession;
	for (const listener of listeners) listener();
}

export function useMagicActionStore(): MagicActionStore {
	return useSyncExternalStore(
		subscribe,
		() => current,
		() => initialMagicActionStore,
	);
}

export function useMagicActionSession(): MagicActionSession {
	return useSyncExternalStore(
		subscribe,
		() => cachedActiveSession,
		() => initialMagicActionSession,
	);
}
