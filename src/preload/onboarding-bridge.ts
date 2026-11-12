import type { IpcRenderer } from "electron";
import { ONBOARDING_CHANNELS, ONBOARDING_PENDING_FLAG, type OnboardingBridge, type SetupStatus } from "../shared/onboarding-contract";

/**
 * The renderer's first-run surface. `pending` comes from the preload argument the
 * main process adds when the Finder window opened on the first run; `load` is the
 * authoritative value. `onProgress` streams the one setup status the main process
 * pushes while it works.
 */
export function createOnboardingBridge(ipcRenderer: IpcRenderer): OnboardingBridge {
	return {
		pending: process.argv.includes(ONBOARDING_PENDING_FLAG),
		load: () => ipcRenderer.invoke(ONBOARDING_CHANNELS.load),
		permissions: () => ipcRenderer.invoke(ONBOARDING_CHANNELS.permissions),
		openFullDiskAccess: () => ipcRenderer.invoke(ONBOARDING_CHANNELS.openFullDiskAccess),
		folders: () => ipcRenderer.invoke(ONBOARDING_CHANNELS.folders),
		pickFolders: () => ipcRenderer.invoke(ONBOARDING_CHANNELS.pickFolders),
		start: (folders) => ipcRenderer.invoke(ONBOARDING_CHANNELS.start, folders),
		status: () => ipcRenderer.invoke(ONBOARDING_CHANNELS.status),
		onProgress: (listener) => {
			const handler = (_event: unknown, payload: SetupStatus): void => listener(payload);
			ipcRenderer.on(ONBOARDING_CHANNELS.progress, handler);
			return () => ipcRenderer.removeListener(ONBOARDING_CHANNELS.progress, handler);
		},
		complete: () => ipcRenderer.invoke(ONBOARDING_CHANNELS.complete),
	};
}
