import { BrowserWindow, ipcMain } from "electron";
import {
	ACTIONS_CHANNELS,
	isActionAnchor,
	isActionRequest,
} from "../shared/actions-contract";
import {
	FS_CHANNELS,
	type FsClipboard,
	type FsCoreBridge,
	type FsIndexBridge,
	type FsSearchOptions,
} from "../shared/fs-contract";
import { isNewFileFormatId, type NewFileFormatId } from "../shared/new-file-contract";
import { SEARCH_CHANNELS, type SearchBridge } from "../shared/search-contract";
import { SETTINGS_CHANNELS, type JsonValue, type SettingsBridge } from "../shared/settings-contract";
import { LIVE_CHANNELS } from "../shared/live-contract";
import type { ActionService } from "./action-service";
import type { ChangeHub } from "./change-hub";
import type { VersionFamilyService } from "./version-family-service";

/** Extra work a channel runs after the filesystem operation itself succeeded. */
export interface FsIpcHooks {
	/**
	 * Paths that actually reached the Trash. A deleted duplicate must leave the
	 * version-family snapshot at once, so the user can see it is gone.
	 */
	readonly onTrashed?: (paths: readonly string[]) => void | Promise<void>;
}

/** Register one ipcMain.handle per FS_CHANNELS channel, in contract order. */
export function registerFsIpcHandlers(service: FsCoreBridge, hooks: FsIpcHooks = {}): void {
	ipcMain.handle(FS_CHANNELS.listDir, (_event, path: string) => service.listDir(path));
	ipcMain.handle(FS_CHANNELS.enrichEntries, (_event, targets, thumbnails: boolean) =>
		service.enrichEntries(targets, thumbnails),
	);
	ipcMain.handle(FS_CHANNELS.finderMetadata, (_event, targets) => service.finderMetadata(targets));
	ipcMain.handle(FS_CHANNELS.readEntries, (_event, dir: string, paths: readonly string[]) =>
		service.readEntries(dir, paths),
	);
	ipcMain.handle(FS_CHANNELS.stat, (_event, path: string) => service.stat(path));
	ipcMain.handle(FS_CHANNELS.details, (_event, path: string) => service.details(path));
	ipcMain.handle(FS_CHANNELS.previewIcon, (_event, path: string, modifiedAt: string) =>
		service.previewIcon(path, modifiedAt),
	);
	ipcMain.handle(FS_CHANNELS.exists, (_event, path: string) => service.exists(path));
	ipcMain.handle(FS_CHANNELS.search, (_event, query: string, options: FsSearchOptions | undefined) =>
		service.search(query, options),
	);
	ipcMain.handle(FS_CHANNELS.locations, () => service.locations());
	ipcMain.handle(FS_CHANNELS.ejectLocation, (_event, path: string) => service.ejectLocation(path));
	ipcMain.handle(FS_CHANNELS.copy, (_event, paths: readonly string[], destDir: string) => service.copy(paths, destDir));
	ipcMain.handle(FS_CHANNELS.move, (_event, paths: readonly string[], destDir: string) => service.move(paths, destDir));
	ipcMain.handle(FS_CHANNELS.duplicate, (_event, paths: readonly string[]) => service.duplicate(paths));
	ipcMain.handle(FS_CHANNELS.rename, (_event, path: string, newName: string) => service.rename(path, newName));
	ipcMain.handle(FS_CHANNELS.createFolder, (_event, directory: string) => service.createFolder(directory));
	ipcMain.handle(FS_CHANNELS.createFile, (_event, directory: string, format: NewFileFormatId) => {
		if (!isNewFileFormatId(format)) throw new Error(`알 수 없는 파일 형식입니다: ${String(format)}`);
		return service.createFile(directory, format);
	});
	ipcMain.handle(FS_CHANNELS.trash, async (_event, paths: readonly string[]) => {
		const result = await service.trash(paths);
		if (result.ok.length > 0) {
			try {
				await hooks.onTrashed?.(result.ok);
			} catch (error) {
				// The move to the Trash already happened; a stale snapshot must not
				// turn into a failed delete for the caller.
				console.error("trash follow-up failed", error);
			}
		}
		return result;
	});
	ipcMain.handle(FS_CHANNELS.reveal, (_event, path: string) => service.reveal(path));
	ipcMain.handle(FS_CHANNELS.quickLook, (_event, path: string) => service.quickLook(path));
	ipcMain.handle(FS_CHANNELS.open, (_event, path: string) => service.open(path));
	ipcMain.handle(FS_CHANNELS.openUrl, (_event, url: unknown) => {
		if (typeof url !== "string") throw new Error("웹 주소가 올바르지 않습니다");
		return service.openUrl(url);
	});
	ipcMain.handle(FS_CHANNELS.clipboardSet, (_event, clipboard: FsClipboard) => service.clipboardSet(clipboard));
	ipcMain.handle(FS_CHANNELS.undo, () => service.undo());
	ipcMain.handle(FS_CHANNELS.clipboardGet, () => service.clipboardGet());
	ipcMain.handle(FS_CHANNELS.copyPathsToClipboard, (_event, paths: readonly string[]) =>
		service.copyPathsToClipboard(paths),
	);
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

/** The persisted-snapshot version-family service owns its own two channels. */
export function registerVersionFamilyIpcHandlers(service: VersionFamilyService): void {
	ipcMain.handle(FS_CHANNELS.versionFamilies, () => service.result());
	ipcMain.handle(FS_CHANNELS.versionFamiliesRefresh, () => service.refresh());
}

export function registerIndexIpcHandlers(service: FsIndexBridge): void {
	ipcMain.handle(FS_CHANNELS.indexStatus, (_event, paths: readonly string[]) => service.indexStatus(paths));
	ipcMain.handle(FS_CHANNELS.indexSetExcluded, (_event, path: string, excluded: boolean) => service.setIndexExcluded(path, excluded));
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

export function registerLiveIpcHandlers(
	watch: { setWatchSet(dirs: readonly string[]): Promise<void> },
	hub: ChangeHub,
): void {
	ipcMain.handle(LIVE_CHANNELS.setWatchSet, (_event, dirs: unknown) => {
		if (!Array.isArray(dirs) || dirs.some((dir) => typeof dir !== "string")) {
			const error = new TypeError("live:setWatchSet expects an array of strings");
			console.error("[live] malformed watch set", error);
			throw error;
		}
		return watch.setWatchSet(dirs);
	});
	ipcMain.handle(LIVE_CHANNELS.layers, () => {
		if (process.env.AUTORAG_FS_WATCH_DIAG === "1") {
			console.info("[live] layers requested");
		}
		return hub.resync();
	});
}
