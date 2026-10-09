import type { IpcRenderer, IpcRendererEvent } from "electron";
import { SETTINGS_CHANNELS, type ProviderLoginEvent, type SettingsBridge } from "../shared/settings-contract";

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
		sourcesSync: (id) => ipcRenderer.invoke(SETTINGS_CHANNELS.sourcesSync, id),
		sourcesSetAccess: (id, allowed) => ipcRenderer.invoke(SETTINGS_CHANNELS.sourcesSetAccess, id, allowed),
		refreshScheduleGet: () => ipcRenderer.invoke(SETTINGS_CHANNELS.refreshScheduleGet),
		refreshScheduleApply: () => ipcRenderer.invoke(SETTINGS_CHANNELS.refreshScheduleApply),
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
		providersList: () => ipcRenderer.invoke(SETTINGS_CHANNELS.providersList),
		providerLoginStart: (providerId, authType) => ipcRenderer.invoke(SETTINGS_CHANNELS.providerLoginStart, providerId, authType),
		providerLoginRespond: (sessionId, value) => ipcRenderer.invoke(SETTINGS_CHANNELS.providerLoginRespond, sessionId, value),
		providerLoginCancel: (sessionId) => ipcRenderer.invoke(SETTINGS_CHANNELS.providerLoginCancel, sessionId),
		providerLogout: (providerId) => ipcRenderer.invoke(SETTINGS_CHANNELS.providerLogout, providerId),
		onProviderLoginEvent: (listener) => {
			const handler = (_event: IpcRendererEvent, event: ProviderLoginEvent): void => listener(event);
			ipcRenderer.on(SETTINGS_CHANNELS.providerLoginEvent, handler);
			return () => {
				ipcRenderer.removeListener(SETTINGS_CHANNELS.providerLoginEvent, handler);
			};
		},
		providersDiscover: (input) => ipcRenderer.invoke(SETTINGS_CHANNELS.providersDiscover, input),
		providersUpsert: (input) => ipcRenderer.invoke(SETTINGS_CHANNELS.providersUpsert, input),
		providersRemove: (id) => ipcRenderer.invoke(SETTINGS_CHANNELS.providersRemove, id),
		providersTest: (id) => ipcRenderer.invoke(SETTINGS_CHANNELS.providersTest, id),
		embeddingGet: () => ipcRenderer.invoke(SETTINGS_CHANNELS.embeddingGet),
		embeddingPlan: (request) => ipcRenderer.invoke(SETTINGS_CHANNELS.embeddingPlan, request),
		embeddingApply: (request) => ipcRenderer.invoke(SETTINGS_CHANNELS.embeddingApply, request),
	};
}
