/**
 * Settings and access-rule contract shared by the Electron main process and
 * the renderer.
 *
 * Persistence lives in the main process under Electron's userData dir.
 */

export const SETTINGS_CHANNELS = {
	get: "settings:get",
	set: "settings:set",
	clearHistory: "settings:clearHistory",
	permGet: "access:get",
	permSet: "access:set",
	permClear: "access:clear",
	permExplicitUnder: "access:explicitUnder",
	sourcesList: "sources:list",
	sourcesSetEnabled: "sources:setEnabled",
	sourcesSetDescription: "sources:setDescription",
	modelsResolve: "models:resolve",
	configGet: "config:get",
	configSet: "config:set",
	configRemove: "config:remove",
	configPatch: "config:patch",
	configRename: "config:rename",
	modelsCatalog: "models:catalog",
	configRefresh: "config:refresh",
	credentialsList: "credentials:list",
	credentialsSet: "credentials:set",
	credentialsRemove: "credentials:remove",
} as const;

export type Permission = "ask" | "allow" | "deny";

export interface ResolvedPermission {
	readonly value: Permission;
	/** explicit = set on this exact path; inherited = from an ancestor; default = nothing set anywhere. */
	readonly origin: "explicit" | "inherited" | "default";
	/** The path the value came from (itself when explicit). */
	readonly sourcePath: string | null;
	/** True when explicit descendant values differ from this folder's resolved value. */
	readonly mixed: boolean;
}

export type AppAppearance = "light" | "dark";

export interface AppSettings {
	readonly appearance: AppAppearance;
	readonly language: "ko" | "en" | "ja" | "zh";
	readonly launchAtLogin: boolean;
	readonly showInMenuBar: boolean;
	readonly autoInstallUpdates: boolean;
	readonly telemetry: boolean;
	/** Off: dot-prefixed files never appear. On: they appear, rendered dimmed. */
	readonly showHiddenFiles: boolean;
	/** How often the app re-runs the dupey version-family scan, in minutes. */
	readonly dupeyScanIntervalMinutes: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
	appearance: "light",
	language: "ko",
	launchAtLogin: false,
	showInMenuBar: true,
	autoInstallUpdates: true,
	telemetry: false,
	showHiddenFiles: false,
	dupeyScanIntervalMinutes: 60,
};

/** Whether the backend a datasource needs is present on this machine. */
export type DataSourceInstallState = "installed" | "missing" | "builtin" | "credential-missing" | "unsupported";

/** How the AutoRAG agent sees the datasource, per the shared config and datasourceAccess. */
export type DataSourceAgentState = "connected" | "blocked" | "disabled" | "unsupported";

/** `external` means the backend CLI owns the index; AutoRAG queries it live. */
export type DataSourceIndexState = "indexed" | "empty" | "not-indexed" | "external";

export type DataSourceStatus = "ready" | "syncing" | "paused" | "attention";

/** One `datasources.<id>` entry of the shared AutoRAG config, with its live state. */
export interface DataSourceRow {
	readonly id: string;
	/** Built-in template (`type`, else the id). */
	readonly type: string;
	readonly description: string;
	readonly enabled: boolean;
	readonly status: DataSourceStatus;
	readonly install: {
		readonly state: DataSourceInstallState;
		readonly binary: string | null;
		readonly path: string | null;
		readonly detail: string;
	};
	readonly agent: {
		readonly state: DataSourceAgentState;
		/** Model-visible `datasource-<id>` skill the agent loads for this connection. */
		readonly skillName: string | null;
		readonly tags: readonly string[];
		readonly detail: string;
	};
	readonly index: {
		readonly state: DataSourceIndexState;
		readonly chunkCount: number | null;
		readonly indexedAt: string | null;
		readonly detail: string;
	};
}

/** Read fresh from the shared AutoRAG config on every call; the app keeps no copy. */
export interface DataSourcesSnapshot {
	readonly configPath: string;
	readonly configExists: boolean;
	/** Config could not be read; `sources` is empty. */
	readonly error: string | null;
	readonly accessTags: readonly string[];
	readonly refresh: {
		readonly state: "idle" | "running" | "success" | "failed";
		readonly phase: string | null;
		readonly finishedAt: string | null;
	};
	readonly sources: readonly DataSourceRow[];
}

/** Where the librarian's model resolution took this identity from. */
export type ModelResolutionSource = "config" | "flags" | "env" | "local_runtime" | "catalog" | "configured_alias" | "mixed";

/** The provider/model the shared AutoRAG config resolves to, as the running agent sees it. */
export interface ConfiguredModel {
	readonly provider: string;
	/** Catalog or configured id, e.g. `deepseek/deepseek-v4.1-flash`. */
	readonly modelId: string;
	readonly displayName: string;
	readonly api: string;
	readonly baseUrl: string | null;
	readonly resolutionSource: ModelResolutionSource;
	readonly auth: {
		readonly present: boolean;
		/** `pi_auth` = credential stored/refreshed by the Pi runtime (auth.json or OAuth). */
		readonly source: "env" | "local_runtime" | "pi_auth" | "catalog" | "none" | "unknown";
		/** Env var the key is read from, when one is known. */
		readonly envName: string | null;
	};
}

/** Read fresh from the shared AutoRAG config on every call; the app keeps no copy. */
export interface ConfiguredModelSnapshot {
	readonly configPath: string;
	readonly configExists: boolean;
	/** Config or model could not be resolved; `model` is null. */
	readonly error: string | null;
	readonly model: ConfiguredModel | null;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
	readonly [key: string]: JsonValue;
}

/** Narrow a JSON boundary value to an object whose fields remain unknown. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * One leaf write in an all-or-nothing `configPatch`. Either a set (`value`) or a
 * removal (`remove: true`); both are applied to the same candidate config so a
 * mixed batch is validated and written once.
 */
export type AutoRagConfigUpdate =
	| { readonly path: readonly string[]; readonly value: JsonValue }
	| { readonly path: readonly string[]; readonly remove: true };

export interface AutoRagConfigSnapshot {
	readonly configPath: string;
	readonly configExists: boolean;
	readonly error: string | null;
	/** Secret values are redacted; unchanged redacted values preserve the original. */
	readonly config: JsonObject;
}

export interface ModelCatalogEntry {
	readonly provider: string;
	readonly id: string;
	readonly name: string;
	readonly api: string;
	readonly available: boolean;
}

export interface ModelCatalogProvider {
	readonly id: string;
	readonly name: string;
	readonly baseUrl: string | null;
	readonly authConfigured: boolean;
	/** Environment variable the provider key is read from (never a secret). */
	readonly apiKeyEnv: string | null;
	readonly models: readonly ModelCatalogEntry[];
}

export interface ModelCatalogSnapshot {
	readonly error: string | null;
	readonly providers: readonly ModelCatalogProvider[];
}

/** One encrypted credential the app stores for a provider API-key env var. */
export interface ProviderCredentialStatus {
	readonly envName: string;
	/** True when the app holds an encrypted value for this variable. */
	readonly stored: boolean;
	/** The value the agent will use: stored > env > none. */
	readonly source: "stored" | "env" | "none";
}

export interface ConfigRefreshDiagnostic {
	readonly code: string;
	readonly severity: "info" | "warning" | "error";
	readonly message: string;
}

/** Outcome of a manual AutoRAGLite index refresh, with its diagnostics. */
export interface ConfigRefreshResult {
	readonly ok: boolean;
	readonly methods: readonly string[];
	readonly scanned: number;
	readonly written: number;
	readonly deleted: number;
	readonly skipped: number;
	readonly diagnostics: readonly ConfigRefreshDiagnostic[];
	readonly error: string | null;
}

export interface SettingsBridge {
	get(): Promise<AppSettings>;
	set(patch: Partial<AppSettings>): Promise<AppSettings>;
	clearHistory(): Promise<void>;

	permGet(path: string): Promise<ResolvedPermission>;
	/** Sets an explicit value. For folders the renderer runs the confirm modal first. */
	permSet(path: string, value: Permission, cascade: "apply-all" | "keep-individual"): Promise<void>;
	permClear(path: string): Promise<void>;
	/** Explicit values at or under a folder path (drives Mixed detection and the confirm modal counts). */
	permExplicitUnder(path: string): Promise<readonly { readonly path: string; readonly value: Permission }[]>;

	sourcesList(): Promise<DataSourcesSnapshot>;
	/** Writes `enabled` into the shared AutoRAG config, then returns the fresh snapshot. */
	sourcesSetEnabled(id: string, enabled: boolean): Promise<DataSourcesSnapshot>;
	/** Writes the description the agent reads into the shared AutoRAG config; blank clears it. */
	sourcesSetDescription(id: string, description: string): Promise<DataSourcesSnapshot>;

	/** The provider/model the shared AutoRAG config resolves for the agent right now. */
	modelsResolve(): Promise<ConfiguredModelSnapshot>;
	configGet(): Promise<AutoRagConfigSnapshot>;
	configSet(path: readonly string[], value: JsonValue): Promise<AutoRagConfigSnapshot>;
	configRemove(path: readonly string[]): Promise<AutoRagConfigSnapshot>;
	/** All-or-nothing batch of leaf sets/removals, applied to the freshest config in one write. */
	configPatch(updates: readonly AutoRagConfigUpdate[]): Promise<AutoRagConfigSnapshot>;
	/** Move the value at `from` to `to` in one write (fails if `from` is absent). */
	configRename(from: readonly string[], to: readonly string[]): Promise<AutoRagConfigSnapshot>;
	modelsCatalog(): Promise<ModelCatalogSnapshot>;
	/** Runs an AutoRAGLite index refresh (parsed/minsync by default) and reports its diagnostics. */
	configRefresh(methods?: readonly string[]): Promise<ConfigRefreshResult>;

	/** Status for the requested env vars, unioned with every stored credential. */
	credentialsList(envNames?: readonly string[]): Promise<readonly ProviderCredentialStatus[]>;
	/** Encrypts and persists a provider key under `envName`; never returns the secret. */
	credentialsSet(envName: string, secret: string): Promise<readonly ProviderCredentialStatus[]>;
	credentialsRemove(envName: string): Promise<readonly ProviderCredentialStatus[]>;
}
