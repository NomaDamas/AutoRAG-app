import type { IpcRenderer, IpcRendererEvent } from "electron";
import { ACCOUNT_CHANNELS, type AccountBridge, type AccountStatus } from "../shared/account-contract";

/** The renderer's account surface: status only, never the API key. */
export function createAccountBridge(ipcRenderer: IpcRenderer): AccountBridge {
	return {
		status: () => ipcRenderer.invoke(ACCOUNT_CHANNELS.status),
		refresh: () => ipcRenderer.invoke(ACCOUNT_CHANNELS.refresh),
		signIn: (options) => ipcRenderer.invoke(ACCOUNT_CHANNELS.signIn, options),
		cancelSignIn: () => ipcRenderer.invoke(ACCOUNT_CHANNELS.cancelSignIn),
		signOut: () => ipcRenderer.invoke(ACCOUNT_CHANNELS.signOut),
		checkout: (plan, promoCode) => ipcRenderer.invoke(ACCOUNT_CHANNELS.checkout, plan, promoCode),
		useManagedModel: () => ipcRenderer.invoke(ACCOUNT_CHANNELS.useManagedModel),
		onChanged: (listener) => {
			const handler = (_event: IpcRendererEvent, status: AccountStatus): void => listener(status);
			ipcRenderer.on(ACCOUNT_CHANNELS.changed, handler);
			return () => ipcRenderer.removeListener(ACCOUNT_CHANNELS.changed, handler);
		},
	};
}
