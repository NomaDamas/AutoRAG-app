import { useSyncExternalStore } from "react";
import type { ModelDownloadBridge, ModelDownloadStatus } from "../../../shared/model-download-contract";

/** Whole percent of the model on disk. 100 only once every file is verified (`ready`), never from bytes alone. */
export function downloadPercent(status: ModelDownloadStatus): number {
	if (status.state === "ready") return 100;
	if (status.bytesTotal <= 0) return 0;
	return Math.min(99, Math.max(0, Math.floor((status.bytesDone / status.bytesTotal) * 100)));
}

/** True when choosing `profileId` runs the on-device model and its weights are not on this computer yet. */
export function localModelNeeded(profileId: string, status: ModelDownloadStatus): boolean {
	return profileId === "local" && status.state !== "ready";
}

/** The status before the main process has answered: nothing known, nothing running. */
const UNKNOWN: ModelDownloadStatus = { state: "absent", bytesDone: 0, bytesTotal: 0, file: null, error: null };

/** `window.autorag` as the preload installs it; absent in a browser-only dev run. */
type ModelDownloadWindow = Window & { readonly autorag?: { readonly modelDownload?: ModelDownloadBridge } };

function bridgeOrNull(): ModelDownloadBridge | null {
	const rendererWindow: ModelDownloadWindow = window;
	return rendererWindow.autorag?.modelDownload ?? null;
}

/**
 * One subscription for the window: the onboarding step, the indexing screen and Settings read the same status,
 * so a download started in one place shows its progress in all of them.
 */
let current: ModelDownloadStatus = UNKNOWN;
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;

function publish(next: ModelDownloadStatus): void {
	current = next;
	for (const listener of listeners) listener();
}

function connect(): void {
	const bridge = bridgeOrNull();
	if (bridge === null) return;
	unsubscribe = bridge.onChange(publish);
	void bridge.get().then(publish, () => undefined);
}

function subscribe(listener: () => void): () => void {
	if (listeners.size === 0) connect();
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) {
			unsubscribe?.();
			unsubscribe = null;
		}
	};
}

export interface ModelDownloadControls {
	readonly status: ModelDownloadStatus;
	readonly start: () => void;
	readonly cancel: () => void;
}

export function useModelDownload(): ModelDownloadControls {
	const status = useSyncExternalStore(subscribe, () => current, () => UNKNOWN);
	return {
		status,
		start: () => void bridgeOrNull()?.start().then(publish, () => undefined),
		cancel: () => void bridgeOrNull()?.cancel().then(publish, () => undefined),
	};
}
