import type { IpcRenderer } from "electron";
import {
	ONBOARDING_CHANNELS,
	ONBOARDING_PENDING_FLAG,
	type OnboardingBridge,
} from "../shared/onboarding-contract";

/**
 * The renderer's onboarding surface. `pending` comes from the preload argument
 * the main process adds when the window opens on onboarding; `load` is the
 * authoritative value (it also carries the persisted draft). Scan and index
 * events push the payload object straight to the listener.
 */
export function createOnboardingBridge(ipcRenderer: IpcRenderer): OnboardingBridge {
	return {
		pending: process.argv.includes(ONBOARDING_PENDING_FLAG),
		load: () => ipcRenderer.invoke(ONBOARDING_CHANNELS.load),
		save: (draft) => ipcRenderer.invoke(ONBOARDING_CHANNELS.save, draft),
		permissions: () => ipcRenderer.invoke(ONBOARDING_CHANNELS.permissions),
		openFullDiskAccess: () => ipcRenderer.invoke(ONBOARDING_CHANNELS.openFullDiskAccess),
		dragApp: () => ipcRenderer.send(ONBOARDING_CHANNELS.dragApp, null),
		relaunch: () => ipcRenderer.invoke(ONBOARDING_CHANNELS.relaunch),
		requestNotifications: () => ipcRenderer.invoke(ONBOARDING_CHANNELS.requestNotifications),
		openNotificationSettings: () => ipcRenderer.invoke(ONBOARDING_CHANNELS.openNotificationSettings),
		checkNetwork: () => ipcRenderer.invoke(ONBOARDING_CHANNELS.checkNetwork),
		setLaunchAtLogin: (enabled) => ipcRenderer.invoke(ONBOARDING_CHANNELS.setLaunchAtLogin, enabled),
		folderCandidates: () => ipcRenderer.invoke(ONBOARDING_CHANNELS.folderCandidates),
		pickFolders: () => ipcRenderer.invoke(ONBOARDING_CHANNELS.pickFolders),
		scanFolders: (paths) => ipcRenderer.invoke(ONBOARDING_CHANNELS.scanFolders, paths),
		onScanProgress: (listener) => subscribe(ipcRenderer, ONBOARDING_CHANNELS.scanProgress, listener),
		embedding: () => ipcRenderer.invoke(ONBOARDING_CHANNELS.embedding),
		detectSources: () => ipcRenderer.invoke(ONBOARDING_CHANNELS.detectSources),
		onSourceDetected: (listener) => subscribe(ipcRenderer, ONBOARDING_CHANNELS.sourceDetected, listener),
		onSourcesDone: (listener) => subscribe<null>(ipcRenderer, ONBOARDING_CHANNELS.sourcesDone, () => listener()),
		detectModels: () => ipcRenderer.invoke(ONBOARDING_CHANNELS.detectModels),
		verifyModel: (request) => ipcRenderer.invoke(ONBOARDING_CHANNELS.verifyModel, request),
		startIndexing: (request) => ipcRenderer.invoke(ONBOARDING_CHANNELS.startIndexing, request),
		indexStatus: () => ipcRenderer.invoke(ONBOARDING_CHANNELS.indexStatus),
		onIndexProgress: (listener) => subscribe(ipcRenderer, ONBOARDING_CHANNELS.indexProgress, listener),
		complete: () => ipcRenderer.invoke(ONBOARDING_CHANNELS.complete),
	};
}

function subscribe<T>(ipcRenderer: IpcRenderer, channel: string, listener: (payload: T) => void): () => void {
	const handler = (_event: unknown, payload: T): void => listener(payload);
	ipcRenderer.on(channel, handler);
	return () => ipcRenderer.removeListener(channel, handler);
}
