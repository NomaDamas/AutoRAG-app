import type { IpcRenderer } from "electron";
import { SETTINGS_CHANNELS, type SettingsBridge } from "../shared/settings-contract";

export function createSettingsBridge(ipcRenderer: IpcRenderer): SettingsBridge {
	return {
		get: () => ipcRenderer.invoke(SETTINGS_CHANNELS.get),
		set: (patch) => ipcRenderer.invoke(SETTINGS_CHANNELS.set, patch),
		clearHistory: () => ipcRenderer.invoke(SETTINGS_CHANNELS.clearHistory),
		permGet: (path) => ipcRenderer.invoke(SETTINGS_CHANNELS.permGet, path),
		permSet: (path, value, cascade) => ipcRenderer.invoke(SETTINGS_CHANNELS.permSet, path, value, cascade),
		permClear: (path) => ipcRenderer.invoke(SETTINGS_CHANNELS.permClear, path),
		permExplicitUnder: (path) => ipcRenderer.invoke(SETTINGS_CHANNELS.permExplicitUnder, path),
		sourcesList: () => ipcRenderer.invoke(SETTINGS_CHANNELS.sourcesList),
		sourcesSetEnabled: (id, enabled) => ipcRenderer.invoke(SETTINGS_CHANNELS.sourcesSetEnabled, id, enabled),
		sourcesSetDescription: (id, description) => ipcRenderer.invoke(SETTINGS_CHANNELS.sourcesSetDescription, id, description),
		modelsResolve: () => ipcRenderer.invoke(SETTINGS_CHANNELS.modelsResolve),
		configGet: () => ipcRenderer.invoke(SETTINGS_CHANNELS.configGet),
		configSet: (path, value) => ipcRenderer.invoke(SETTINGS_CHANNELS.configSet, path, value),
		configRemove: (path) => ipcRenderer.invoke(SETTINGS_CHANNELS.configRemove, path),
		configPatch: (updates) => ipcRenderer.invoke(SETTINGS_CHANNELS.configPatch, updates),
		configRename: (from, to) => ipcRenderer.invoke(SETTINGS_CHANNELS.configRename, from, to),
		modelsCatalog: () => ipcRenderer.invoke(SETTINGS_CHANNELS.modelsCatalog),
		configRefresh: (methods) => ipcRenderer.invoke(SETTINGS_CHANNELS.configRefresh, methods),
		credentialsList: (envNames) => ipcRenderer.invoke(SETTINGS_CHANNELS.credentialsList, envNames),
		credentialsSet: (envName, secret) => ipcRenderer.invoke(SETTINGS_CHANNELS.credentialsSet, envName, secret),
		credentialsRemove: (envName) => ipcRenderer.invoke(SETTINGS_CHANNELS.credentialsRemove, envName),
	};
}
