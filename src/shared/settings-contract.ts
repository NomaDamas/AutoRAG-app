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
		readonly source: "env" | "local_runtime" | "catalog" | "none" | "unknown";
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
}
