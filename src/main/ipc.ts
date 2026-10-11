import { app, BrowserWindow, ipcMain, nativeImage, type WebContents } from "electron";
import {
	ACTIONS_CHANNELS,
	isActionAnchor,
	isActionPaths,
	isActionRequest,
} from "../shared/actions-contract";
import { FS_CHANNELS } from "../shared/fs-contract";
import { SEARCH_CHANNELS, type SearchBridge } from "../shared/search-contract";
import { OS_REQUEST_CHANNELS } from "../shared/os-request-contract";
import { SETTINGS_CHANNELS, type EmbeddingChangeRequest, type JsonValue, type ProviderAuthKind, type ProviderServerInput, type SettingsBridge } from "../shared/settings-contract";
import { ACCOUNT_CHANNELS } from "../shared/account-contract";
import { ONBOARDING_CHANNELS } from "../shared/onboarding-contract";
import { isServiceRunRequest, SERVICES_CHANNELS } from "../shared/services-contract";
import { INDEX_ACTIVITY_CHANNELS } from "../shared/index-activity-contract";
import type { ActionService } from "./action-service";
import type { IndexActivityService } from "./index-activity";
import { dragOutPaths } from "./drag-out";
import type { AccountService } from "./account-service";
import type { OnboardingService } from "./onboarding-service";
import type { OsRequestService } from "./os-request-service";
import type { ServicesService } from "./services-service";

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
	ipcMain.handle(ACTIONS_CHANNELS.run, (event, paths: unknown, request: unknown) => {
		if (!isActionPaths(paths)) throw new Error("파일 경로가 올바르지 않습니다");
		if (!isActionRequest(request)) throw new Error("알 수 없는 파일 작업입니다");
		return service.run(paths, request, BrowserWindow.fromWebContents(event.sender));
	});
	ipcMain.handle(ACTIONS_CHANNELS.openWithApplications, (_event, path: unknown) => {
		if (typeof path !== "string" || path.length === 0) throw new Error("파일 경로가 올바르지 않습니다");
		return service.openWithApplications(path);
	});
	ipcMain.handle(ACTIONS_CHANNELS.share, (event, paths: unknown, anchor: unknown) => {
		if (!isActionPaths(paths)) throw new Error("파일 경로가 올바르지 않습니다");
		if (!isActionAnchor(anchor)) throw new Error("공유 위치가 올바르지 않습니다");
		return service.share(paths, anchor, BrowserWindow.fromWebContents(event.sender));
	});
}

/** The OS Services submenu: list what the system offers for a selection, and perform one. */
export function registerServicesIpcHandlers(service: ServicesService): void {
	ipcMain.handle(SERVICES_CHANNELS.list, (_event, paths: unknown) => {
		if (!isActionPaths(paths)) throw new Error("파일 경로가 올바르지 않습니다");
		return service.list(paths);
	});
	ipcMain.handle(SERVICES_CHANNELS.run, (_event, id: unknown, paths: unknown) => {
		if (typeof id !== "string" || !isServiceRunRequest(id, paths)) throw new Error("서비스 요청이 올바르지 않습니다");
		return service.run(id, paths);
	});
}

export function registerSearchIpcHandlers(service: SearchBridge): void {
	ipcMain.handle(SEARCH_CHANNELS.start, (_event, searchId: string, chatId: string, query: string, attachments) =>
		service.start(searchId, chatId, query, attachments),
	);
	ipcMain.handle(SEARCH_CHANNELS.cancel, (_event, searchId: string) => service.cancel(searchId));
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

function requireNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
	return value;
}

function requireProviderAuthKind(value: unknown): ProviderAuthKind {
	if (value !== "api_key" && value !== "oauth") throw new TypeError("authType must be 'api_key' or 'oauth'");
	return value;
}

/** Validate a local/custom server payload the renderer sends to discover/upsert. */
function requireProviderServerInput(value: unknown): ProviderServerInput {
	if (value === null || typeof value !== "object") throw new TypeError("provider server input must be an object");
	const input = value as Record<string, unknown>;
	if (input.kind !== "local" && input.kind !== "custom") throw new TypeError("provider kind must be 'local' or 'custom'");
	const label = requireNonEmptyString(input.label, "provider label");
	const baseUrl = requireNonEmptyString(input.baseUrl, "provider baseUrl");
	if (input.id !== undefined && typeof input.id !== "string") throw new TypeError("provider id must be a string");
	if (input.apiKey !== undefined && typeof input.apiKey !== "string") throw new TypeError("provider apiKey must be a string");
	return {
		kind: input.kind,
		label,
		baseUrl,
		...(typeof input.id === "string" ? { id: input.id } : {}),
		...(typeof input.apiKey === "string" ? { apiKey: input.apiKey } : {}),
	};
}

/** Validate the shape of an embedding change request. */
function requireEmbeddingChangeRequest(value: unknown): EmbeddingChangeRequest {
	if (value === null || typeof value !== "object") throw new TypeError("embedding request must be an object");
	const request = value as Record<string, unknown>;
	requireNonEmptyString(request.profileId, "embedding profileId");
	return value as EmbeddingChangeRequest;
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
	ipcMain.handle(SETTINGS_CHANNELS.providersList, () => service.providersList());
	ipcMain.handle(SETTINGS_CHANNELS.providerLoginStart, (_event, providerId: unknown, authType: unknown) =>
		service.providerLoginStart(requireNonEmptyString(providerId, "providerId"), requireProviderAuthKind(authType)),
	);
	ipcMain.handle(SETTINGS_CHANNELS.providerLoginRespond, (_event, sessionId: unknown, value: unknown) => {
		if (typeof value !== "string") throw new TypeError("provider:loginRespond expects a string value");
		return service.providerLoginRespond(requireNonEmptyString(sessionId, "sessionId"), value);
	});
	ipcMain.handle(SETTINGS_CHANNELS.providerLoginCancel, (_event, sessionId: unknown) =>
		service.providerLoginCancel(requireNonEmptyString(sessionId, "sessionId")),
	);
	ipcMain.handle(SETTINGS_CHANNELS.providerLogout, (_event, providerId: unknown) =>
		service.providerLogout(requireNonEmptyString(providerId, "providerId")),
	);
	ipcMain.handle(SETTINGS_CHANNELS.providersDiscover, (_event, input: unknown) => service.providersDiscover(requireProviderServerInput(input)));
	ipcMain.handle(SETTINGS_CHANNELS.providersUpsert, (_event, input: unknown) => service.providersUpsert(requireProviderServerInput(input)));
	ipcMain.handle(SETTINGS_CHANNELS.providersRemove, (_event, id: unknown) => service.providersRemove(requireNonEmptyString(id, "provider id")));
	ipcMain.handle(SETTINGS_CHANNELS.providersTest, (_event, id: unknown) => service.providersTest(requireNonEmptyString(id, "provider id")));
	ipcMain.handle(SETTINGS_CHANNELS.sourcesSync, (_event, id: unknown) => service.sourcesSync(requireNonEmptyString(id, "datasource id")));
	ipcMain.handle(SETTINGS_CHANNELS.refreshScheduleGet, () => service.refreshScheduleGet());
	ipcMain.handle(SETTINGS_CHANNELS.refreshScheduleApply, () => service.refreshScheduleApply());
	ipcMain.handle(SETTINGS_CHANNELS.embeddingGet, () => service.embeddingGet());
	ipcMain.handle(SETTINGS_CHANNELS.embeddingPlan, (_event, request: unknown) =>
		service.embeddingPlan(requireEmbeddingChangeRequest(request)),
	);
	ipcMain.handle(SETTINGS_CHANNELS.embeddingApply, (_event, request: unknown) =>
		service.embeddingApply(requireEmbeddingChangeRequest(request)),
	);
}

/** AutoRAG account: the plan is the only renderer-supplied payload and is validated here. */
export function registerAccountIpcHandlers(service: AccountService): void {
	ipcMain.handle(ACCOUNT_CHANNELS.status, () => service.status());
	ipcMain.handle(ACCOUNT_CHANNELS.refresh, () => service.refresh());
	ipcMain.handle(ACCOUNT_CHANNELS.signIn, () => service.signIn());
	ipcMain.handle(ACCOUNT_CHANNELS.cancelSignIn, () => service.cancelSignIn());
	ipcMain.handle(ACCOUNT_CHANNELS.signOut, () => service.signOut());
	ipcMain.handle(ACCOUNT_CHANNELS.checkout, (_event, plan: unknown) => {
		if (plan !== "air" && plan !== "pro") throw new TypeError("account:checkout expects \"air\" or \"pro\"");
		return service.checkout(plan);
	});
	ipcMain.handle(ACCOUNT_CHANNELS.portal, () => service.portal());
	ipcMain.handle(ACCOUNT_CHANNELS.useManagedModel, () => service.useManagedModel());
}

/** First-run onboarding: every payload is validated inside the service. */
export function registerOnboardingIpcHandlers(service: OnboardingService): void {
	ipcMain.handle(ONBOARDING_CHANNELS.load, () => service.load());
	ipcMain.handle(ONBOARDING_CHANNELS.save, (_event, draft: unknown) => service.save(draft));
	ipcMain.handle(ONBOARDING_CHANNELS.permissions, () => service.permissions());
	ipcMain.handle(ONBOARDING_CHANNELS.openFullDiskAccess, () => service.openFullDiskAccess());
	ipcMain.on(ONBOARDING_CHANNELS.dragApp, () => service.dragApp());
	ipcMain.handle(ONBOARDING_CHANNELS.relaunch, () => service.relaunch());
	ipcMain.handle(ONBOARDING_CHANNELS.requestNotifications, () => service.requestNotifications());
	ipcMain.handle(ONBOARDING_CHANNELS.openNotificationSettings, () => service.openNotificationSettings());
	ipcMain.handle(ONBOARDING_CHANNELS.checkNetwork, () => service.checkNetwork());
	ipcMain.handle(ONBOARDING_CHANNELS.setLaunchAtLogin, (_event, enabled: unknown) => {
		if (typeof enabled !== "boolean") throw new TypeError("onboarding:setLaunchAtLogin expects a boolean");
		return service.setLaunchAtLogin(enabled);
	});
	ipcMain.handle(ONBOARDING_CHANNELS.folderCandidates, () => service.folderCandidates());
	ipcMain.handle(ONBOARDING_CHANNELS.pickFolders, () => service.pickFolders());
	ipcMain.handle(ONBOARDING_CHANNELS.scanFolders, (_event, paths: unknown) => {
		if (!Array.isArray(paths)) throw new TypeError("onboarding:scanFolders expects an array of paths");
		return service.scanFolders(paths);
	});
	ipcMain.handle(ONBOARDING_CHANNELS.embedding, () => service.embedding());
	ipcMain.handle(ONBOARDING_CHANNELS.detectSources, () => service.detectSources());
	ipcMain.handle(ONBOARDING_CHANNELS.detectModels, () => service.detectModels());
	ipcMain.handle(ONBOARDING_CHANNELS.verifyModel, (_event, request: unknown) => service.verifyModel(request));
	ipcMain.handle(ONBOARDING_CHANNELS.startIndexing, (_event, request: unknown) => service.startIndexing(request));
	ipcMain.handle(ONBOARDING_CHANNELS.indexStatus, () => service.indexStatus());
	ipcMain.handle(ONBOARDING_CHANNELS.complete, () => service.complete());
}

/** The renderer drains requests that came from the OS file menu. */
export function registerOsRequestIpcHandlers(service: OsRequestService): void {
	ipcMain.handle(OS_REQUEST_CHANNELS.take, () => service.take());
}

/** The renderer's one read of what is indexing right now; changes are pushed by the main process. */
export function registerIndexActivityIpcHandlers(service: IndexActivityService): void {
	ipcMain.handle(INDEX_ACTIVITY_CHANNELS.get, () => service.snapshot());
}
