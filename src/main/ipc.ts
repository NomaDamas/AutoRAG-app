import { app, BrowserWindow, ipcMain, nativeImage, type WebContents } from "electron";
import {
	ACTIONS_CHANNELS,
	isActionAnchor,
	isActionRequest,
} from "../shared/actions-contract";
import { FS_CHANNELS } from "../shared/fs-contract";
import { SEARCH_CHANNELS, type SearchBridge } from "../shared/search-contract";
import { SETTINGS_CHANNELS, type JsonValue, type SettingsBridge } from "../shared/settings-contract";
import type { ActionService } from "./action-service";
import { dragOutPaths } from "./drag-out";

/**
 * The row drag-out: the renderer has already cancelled its own drag
 * (`preventDefault`), so the main process starts the OS file drag here. The
 * image under the cursor is the first row's OS icon, with a transparent tile as
 * the fallback — `startDrag` refuses an empty image.
 */
async function startNativeDrag(webContents: WebContents, paths: readonly string[]): Promise<void> {
	let icon = nativeImage.createEmpty();
	try {
		icon = await app.getFileIcon(paths[0] as string);
	} catch (error) {
		console.error("drag-out icon failed", error);
	}
	if (icon.isEmpty()) icon = nativeImage.createFromBitmap(Buffer.alloc(4), { width: 1, height: 1 });
	if (webContents.isDestroyed()) return;
	// Electron's type requires `file`; `files` overrides it at runtime for multi-select.
	webContents.startDrag({ file: paths[0] as string, files: [...paths], icon });
}

/** One `send` channel: a Finder row drag-out the OS will carry as real files. */
export function registerDragOutIpcHandlers(): void {
	ipcMain.on(FS_CHANNELS.startDrag, (event, paths: unknown) => {
		const valid = dragOutPaths(paths);
		if (valid === null) return;
		void startNativeDrag(event.sender, valid);
	});
}

/** Inspector file actions: probe once, run one request, or pop the share sheet. */
export function registerActionsIpcHandlers(service: ActionService): void {
	ipcMain.handle(ACTIONS_CHANNELS.capabilities, () => service.capabilities());
	ipcMain.handle(ACTIONS_CHANNELS.run, (event, path: unknown, request: unknown) => {
		if (typeof path !== "string" || path.length === 0) throw new Error("파일 경로가 올바르지 않습니다");
		if (!isActionRequest(request)) throw new Error("알 수 없는 파일 작업입니다");
		return service.run(path, request, BrowserWindow.fromWebContents(event.sender));
	});
	ipcMain.handle(ACTIONS_CHANNELS.share, (event, path: unknown, anchor: unknown) => {
		if (typeof path !== "string" || path.length === 0) throw new Error("파일 경로가 올바르지 않습니다");
		if (!isActionAnchor(anchor)) throw new Error("공유 위치가 올바르지 않습니다");
		return service.share(path, anchor, BrowserWindow.fromWebContents(event.sender));
	});
}

export function registerSearchIpcHandlers(service: SearchBridge): void {
	ipcMain.handle(SEARCH_CHANNELS.start, (_event, searchId: string, chatId: string, query: string, attachments) =>
		service.start(searchId, chatId, query, attachments),
	);
	ipcMain.handle(SEARCH_CHANNELS.cancel, (_event, searchId: string) => service.cancel(searchId));
	ipcMain.handle(SEARCH_CHANNELS.feedback, (_event, sessionId: string, useful: readonly number[], notUseful: readonly number[]) =>
		service.feedback(sessionId, useful, notUseful),
	);
	ipcMain.handle(SEARCH_CHANNELS.historyList, () => service.historyList());
	ipcMain.handle(SEARCH_CHANNELS.historyGet, (_event, chatId: string) => service.historyGet(chatId));
	ipcMain.handle(SEARCH_CHANNELS.historySearch, (_event, query: string) => service.historySearch(query));
	ipcMain.handle(SEARCH_CHANNELS.historyClear, () => service.historyClear());
}

interface ConfigUpdatePayload {
	readonly path: readonly string[];
	readonly value?: unknown;
	readonly remove?: true;
}

/** A config:patch item is a set (`value` present) or a removal (`remove: true`). */
function isConfigUpdatePayload(value: unknown): value is ConfigUpdatePayload {
	if (value === null || typeof value !== "object" || !("path" in value)) return false;
	const path = value.path;
	if (!Array.isArray(path) || path.some((segment) => typeof segment !== "string")) return false;
	if ("remove" in value) return value.remove === true;
	return "value" in value;
}

export function registerSettingsIpcHandlers(service: SettingsBridge): void {
	ipcMain.handle(SETTINGS_CHANNELS.get, () => service.get());
	ipcMain.handle(SETTINGS_CHANNELS.set, (_event, patch) => service.set(patch));
	ipcMain.handle(SETTINGS_CHANNELS.clearHistory, () => service.clearHistory());
	ipcMain.handle(SETTINGS_CHANNELS.permGet, (_event, path: string) => service.permGet(path));
	ipcMain.handle(SETTINGS_CHANNELS.permSet, (_event, path: string, value, cascade) => service.permSet(path, value, cascade));
	ipcMain.handle(SETTINGS_CHANNELS.permClear, (_event, path: string) => service.permClear(path));
	ipcMain.handle(SETTINGS_CHANNELS.permExplicitUnder, (_event, path: string) => service.permExplicitUnder(path));
	ipcMain.handle(SETTINGS_CHANNELS.sourcesList, () => service.sourcesList());
	ipcMain.handle(SETTINGS_CHANNELS.sourcesSetEnabled, (_event, id: string, enabled: boolean) => service.sourcesSetEnabled(id, enabled));
	ipcMain.handle(SETTINGS_CHANNELS.sourcesSetDescription, (_event, id: string, description: string) =>
		service.sourcesSetDescription(id, description),
	);
	ipcMain.handle(SETTINGS_CHANNELS.modelsResolve, () => service.modelsResolve());
	ipcMain.handle(SETTINGS_CHANNELS.configGet, () => service.configGet());
	ipcMain.handle(SETTINGS_CHANNELS.configSet, (_event, path: unknown, value: unknown) => {
		if (!Array.isArray(path) || path.some((segment) => typeof segment !== "string")) {
			throw new TypeError("config:set expects a path array of strings");
		}
		return service.configSet(path, value as JsonValue);
	});
	ipcMain.handle(SETTINGS_CHANNELS.configRemove, (_event, path: unknown) => {
		if (!Array.isArray(path) || path.some((segment) => typeof segment !== "string")) {
			throw new TypeError("config:remove expects a path array of strings");
		}
		return service.configRemove(path);
	});
	ipcMain.handle(SETTINGS_CHANNELS.configPatch, (_event, updates: unknown) => {
		if (!Array.isArray(updates) || !updates.every(isConfigUpdatePayload)) {
			throw new TypeError("config:patch expects an array of { path, value } updates");
		}
		// The config service re-validates each value as JSON before writing.
		return service.configPatch(
			updates.map((update) =>
				"remove" in update && update.remove === true
					? { path: update.path, remove: true as const }
					: { path: update.path, value: update.value as JsonValue },
			),
		);
	});
	ipcMain.handle(SETTINGS_CHANNELS.configRename, (_event, from: unknown, to: unknown) => {
		if (!Array.isArray(from) || from.some((segment) => typeof segment !== "string")) {
			throw new TypeError("config:rename expects a `from` string path array");
		}
		if (!Array.isArray(to) || to.some((segment) => typeof segment !== "string")) {
			throw new TypeError("config:rename expects a `to` string path array");
		}
		return service.configRename(from as readonly string[], to as readonly string[]);
	});
	ipcMain.handle(SETTINGS_CHANNELS.modelsCatalog, () => service.modelsCatalog());
	ipcMain.handle(SETTINGS_CHANNELS.configRefresh, (_event, methods: unknown) => {
		if (methods === undefined) return service.configRefresh();
		if (!Array.isArray(methods) || methods.some((method) => typeof method !== "string")) {
			throw new TypeError("config:refresh expects an array of method names");
		}
		return service.configRefresh(methods as readonly string[]);
	});
	ipcMain.handle(SETTINGS_CHANNELS.credentialsList, (_event, envNames: unknown) => {
		if (envNames === undefined) return service.credentialsList();
		if (!Array.isArray(envNames) || envNames.some((name) => typeof name !== "string")) {
			throw new TypeError("credentials:list expects an array of env var names");
		}
		return service.credentialsList(envNames as readonly string[]);
	});
	ipcMain.handle(SETTINGS_CHANNELS.credentialsSet, (_event, envName: unknown, secret: unknown) => {
		if (typeof envName !== "string" || typeof secret !== "string") {
			throw new TypeError("credentials:set expects an env var name and a secret string");
		}
		return service.credentialsSet(envName, secret);
	});
	ipcMain.handle(SETTINGS_CHANNELS.credentialsRemove, (_event, envName: unknown) => {
		if (typeof envName !== "string") throw new TypeError("credentials:remove expects an env var name");
		return service.credentialsRemove(envName);
	});
}

