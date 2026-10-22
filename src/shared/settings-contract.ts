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
	providersList: "providers:list",
	providerLoginStart: "provider:loginStart",
	providerLoginRespond: "provider:loginRespond",
	providerLoginCancel: "provider:loginCancel",
	providerLogout: "provider:logout",
	providerLoginEvent: "provider:loginEvent",
	providersDiscover: "providers:discover",
	providersUpsert: "providers:upsert",
	providersRemove: "providers:remove",
	providersTest: "providers:test",
	embeddingGet: "embedding:get",
	embeddingPlan: "embedding:plan",
	embeddingApply: "embedding:apply",
	sourcesSync: "sources:sync",
	refreshScheduleGet: "refreshSchedule:get",
	refreshScheduleApply: "refreshSchedule:apply",
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
	/** Crash and indexing-failure reports go to the maintainers (no file paths, names or document text). Off by default: opt-in, asked on the first onboarding step. */
	readonly errorReporting: boolean;
	/**
	 * Anonymous product-usage statistics (which features are used, never what is in them) go to the maintainers.
	 * Off by default: it is opt-in, and independent of `errorReporting`.
	 */
	readonly usageAnalytics: boolean;
	/** Off: dot-prefixed files never appear. On: they appear, rendered dimmed. */
	readonly showHiddenFiles: boolean;
	/** How often the app re-runs the dupey version-family scan, in minutes. */
	readonly dupeyScanIntervalMinutes: number;
	/** The OS file-menu entries ("Ask AutoRAG", "Show in AutoRAG") are installed: macOS Quick Actions, Windows Explorer verbs. */
	readonly osMenuIntegration: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
	appearance: "light",
	language: "ko",
	launchAtLogin: false,
	showInMenuBar: true,
	autoInstallUpdates: true,
	errorReporting: false,
	usageAnalytics: false,
	showHiddenFiles: false,
	dupeyScanIntervalMinutes: 60,
	osMenuIntegration: false,
};

/** Whether the backend a datasource needs is present on this machine. */
export type DataSourceInstallState = "installed" | "missing" | "builtin" | "credential-missing" | "unsupported";

/** Whether the desktop source app a datasource reads from is present. Detected separately from the CLI. */
export interface DataSourceAppRequirement {
	/** True when this datasource reads from a desktop app (Slack, Discord, KakaoTalk, …). */
	readonly required: boolean;
	/** App bundle present. `null` = cannot detect on this platform. */
	readonly installed: boolean | null;
	readonly name: string;
}

/** How the AutoRAG agent sees the datasource, per the shared config. */
export type DataSourceAgentState = "connected" | "disabled" | "unsupported";

/**
 * `live` means the backend answers on demand and keeps no countable index the
 * app can read (Lark); every other state is judged from a count the backend
 * or AutoRAG's own chunk store reports.
 */
export type DataSourceIndexState = "indexed" | "empty" | "not-indexed" | "live";

/** What `index.chunkCount` counts, so the UI can say "메시지 3,536개" instead of a bare number. */
export type DataSourceIndexUnit = "message" | "document" | "image";

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
		/** Desktop source app presence, detected separately from the CLI binary. */
		readonly app: DataSourceAppRequirement;
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
		/** Items the backend reports (messages, documents, images). `null` when it cannot be read. */
		readonly chunkCount: number | null;
		readonly unit: DataSourceIndexUnit | null;
		/** Last sync time as the backend itself reports it. */
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
	readonly refresh: {
		readonly state: "idle" | "running" | "success" | "failed";
		readonly phase: string | null;
		readonly finishedAt: string | null;
	};
	/** The local-folder index: documents the last refresh parsed into the shared workspace. */
	readonly local: {
		readonly documentCount: number | null;
		/** Newest parse time recorded in the index. */
		readonly updatedAt: string | null;
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

/** Directories that are almost never corpus, only code/dependency noise: excluded from indexing by default. */
export const DEFAULT_CODE_FOLDER_NAMES: readonly string[] = [
	".git",
	"node_modules",
	".venv",
	"venv",
	"target",
	"dist",
	"build",
	"coverage",
	"__pycache__",
];

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
	/** OpenAI-compatible base URL for this model's provider, when one is configured. */
	readonly baseUrl: string | null;
	/** Env var holding this provider's API key, when one is known (never the secret). */
	readonly apiKeyEnv: string | null;
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

export type ProviderAuthKind = "api_key" | "oauth";

/** How a provider connects: Pi runtime provider, loopback local server, or user-added OpenAI-compatible server. */
export type ProviderKind = "runtime" | "local" | "custom";

export interface ProviderSummary {
	readonly id: string;
	readonly name: string;
	readonly baseUrl: string | null;
	readonly kind: ProviderKind;
	readonly authKinds: readonly ProviderAuthKind[];
	readonly subscription: boolean;
	readonly authConfigured: boolean;
	readonly authSource: "stored" | "environment" | "none" | "runtime";
	readonly apiKeyEnv: string | null;
	readonly models: readonly ModelCatalogEntry[];
}

/** A local loopback or custom OpenAI-compatible server the renderer adds/edits. */
export interface ProviderServerInput {
	/** Present when editing an existing local/custom provider. */
	readonly id?: string;
	/** `local` is loopback-only; `custom` accepts any http(s) OpenAI-compatible server. */
	readonly kind: "local" | "custom";
	readonly label: string;
	readonly baseUrl: string;
	/** Optional API key; stored encrypted, never written to models.json in plaintext. */
	readonly apiKey?: string;
}

export interface DiscoveredModel {
	readonly id: string;
	readonly name: string;
	readonly api: string;
}

export interface ProviderDiscoveryResult {
	readonly ok: boolean;
	readonly error: string | null;
	/** Which discovery endpoint answered: OpenAI `/v1/models` or Ollama `/api/tags`. */
	readonly protocol: "openai" | "ollama" | null;
	readonly models: readonly DiscoveredModel[];
}

/** Connection check outcome: the UI shows pass/fail only; the Pi runtime owns the reason. */
export interface ProviderConnectionResult {
	readonly ok: boolean;
}

export type ProviderLoginPrompt =
	| { readonly type: "text" | "secret" | "manual_code"; readonly message: string; readonly placeholder?: string }
	| { readonly type: "select"; readonly message: string; readonly options: readonly { readonly id: string; readonly label: string; readonly description?: string }[] };
export type ProviderLoginEvent =
	| { readonly type: "prompt"; readonly sessionId: string; readonly prompt: ProviderLoginPrompt }
	| { readonly type: "info" | "progress"; readonly sessionId: string; readonly message: string; readonly links?: readonly { readonly url: string; readonly label?: string }[] }
	| { readonly type: "auth_url"; readonly sessionId: string; readonly url: string; readonly instructions?: string }
	| { readonly type: "device_code"; readonly sessionId: string; readonly userCode: string; readonly verificationUri: string; readonly intervalSeconds?: number; readonly expiresInSeconds?: number }
	| { readonly type: "done"; readonly sessionId: string }
	| { readonly type: "error"; readonly sessionId: string; readonly message: string };
export interface ProviderLoginStartResult { readonly sessionId: string; }

/** One encrypted credential the app stores for a provider API-key env var. */
export interface ProviderCredentialStatus {
	readonly envName: string;
	/** True when the app holds an encrypted value for this variable. */
	readonly stored: boolean;
	/** The value the agent will use: stored > env > none. */
	readonly source: "stored" | "env" | "none";
}

/** keyword-only, the local MinSync server, the Dazzi cloud, or the user's own server. */
export type EmbeddingProfileKind = "none" | "local" | "dazzi" | "byok";

/** One selectable embedding runtime profile, in the order the settings screen offers them. */
export interface EmbeddingProfile {
	readonly id: string;
	readonly kind: EmbeddingProfileKind;
	readonly label: string;
	readonly description: string;
	readonly model: string;
	readonly dimension: number;
	readonly queryPrefix: string;
	readonly passagePrefix: string;
	readonly baseUrl: string | null;
	/** Why this machine cannot use the profile (already translated), or null when it can. */
	readonly unavailable: string | null;
}

/** How one configured datasource adopts the selected global embedding profile. */
export type EmbeddingAdoption = "native" | "propagated" | "incompatible" | "not-applicable" | "not-configured";

export interface EmbeddingSourceStatus {
	readonly id: string;
	readonly type: string;
	readonly adoption: EmbeddingAdoption;
	readonly reason: string;
	readonly action: string | null;
}

export interface EmbeddingSettingsSnapshot {
	readonly configPath: string;
	readonly configExists: boolean;
	readonly error: string | null;
	readonly current: {
		readonly profileId: string | null;
		readonly embedder: JsonObject;
	};
	readonly profiles: readonly EmbeddingProfile[];
	readonly sources: readonly EmbeddingSourceStatus[];
}

/**
 * The user's own embedding server for the `byok` profile. The model is fixed (Qwen3-Embedding-0.6B, 1024
 * dimensions), so there is no model or dimension here: the server is probed for real vectors of that size.
 */
export interface ByokEmbeddingServer {
	readonly baseUrl: string;
	readonly protocol: "openai" | "tei";
	/** Stored in the OS keyring, never in the config. Optional for a loopback server and when a key is already stored. */
	readonly apiKey?: string;
}

export interface EmbeddingChangeRequest {
	readonly profileId: string;
	readonly byok?: ByokEmbeddingServer;
	readonly acknowledgeIncompatible?: boolean;
	/** The user agreed that document text is sent to a server off this computer (`dazzi`, `byok`). */
	readonly acknowledgeRemote?: boolean;
}

export interface EmbeddingChangeResult {
	readonly ok: boolean;
	readonly applied: boolean;
	readonly profileId: string;
	readonly plan: readonly EmbeddingSourceStatus[];
	readonly incompatibilities: readonly EmbeddingSourceStatus[];
	readonly written: readonly (readonly string[])[];
	readonly rebuilds: readonly DataSourceSyncResult[];
	readonly error: string | null;
}

/** Outcome of syncing one datasource against its own index. */
export interface DataSourceSyncResult {
	readonly id: string;
	readonly ok: boolean;
	readonly state: "indexed" | "empty" | "unsupported" | "unavailable" | "not-configured" | "failed";
	readonly chunkCount: number | null;
	readonly indexedAt: string | null;
	readonly durationMs: number;
	readonly diagnostics: readonly ConfigRefreshDiagnostic[];
	readonly error: string | null;
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

/** Outcome of the newest scheduled run of one unit of work (the local folders or one datasource). */
export interface ScheduledRunRecord {
	readonly at: string;
	readonly ok: boolean;
	readonly error: string | null;
	readonly durationMs: number;
	/** One short human line, e.g. "문서 12개 기록" (scanned/written counts) or the datasource state. */
	readonly detail: string | null;
}

/**
 * The OS-level background job that refreshes the index on a schedule, derived
 * from the shared config (`appIndexing.refreshIntervalMs`, each datasource's
 * `pollingIntervalMs`). `intervalMs` is how often the job wakes up; what is
 * actually due is decided per item each time it wakes.
 */
export interface RefreshScheduleStatus {
	/** False on platforms with no supported scheduler. */
	readonly supported: boolean;
	readonly mechanism: "launchd" | "cron" | "schtasks" | null;
	/** A job is registered with the OS right now. */
	readonly installed: boolean;
	/** The config asks for at least one automatic refresh. */
	readonly wanted: boolean;
	readonly intervalMs: number | null;
	readonly lastTickAt: string | null;
	readonly local: ScheduledRunRecord | null;
	readonly sources: Readonly<Record<string, ScheduledRunRecord>>;
	/** Other scheduled jobs on this machine that also refresh AutoRAG (a hand-made cron line, another launch agent). */
	readonly conflicts: readonly string[];
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
	providersList(): Promise<readonly ProviderSummary[]>;
	providerLoginStart(providerId: string, authType: ProviderAuthKind): Promise<ProviderLoginStartResult>;
	providerLoginRespond(sessionId: string, value: string): Promise<void>;
	providerLoginCancel(sessionId: string): Promise<void>;
	providerLogout(providerId: string): Promise<void>;
	onProviderLoginEvent(listener: (event: ProviderLoginEvent) => void): () => void;

	/** Probes a local/custom OpenAI-compatible server (or Ollama) and returns only the models it actually reports. */
	providersDiscover(input: ProviderServerInput): Promise<ProviderDiscoveryResult>;
	/** Adds or edits a local/custom provider in models.json (key encrypted in the credential store) and returns the fresh list. */
	providersUpsert(input: ProviderServerInput): Promise<readonly ProviderSummary[]>;
	/** Removes a local/custom provider and its stored key; returns the fresh list. */
	providersRemove(id: string): Promise<readonly ProviderSummary[]>;
	/** Re-probes a saved provider's server for a connection check. */
	providersTest(id: string): Promise<ProviderConnectionResult>;

	/** Current embedding profile plus how each configured datasource adopts it. */
	embeddingGet(): Promise<EmbeddingSettingsSnapshot>;
	/** Dry-run the adoption plan for a profile change (no writes, no reindex). */
	embeddingPlan(request: EmbeddingChangeRequest): Promise<EmbeddingSettingsSnapshot>;
	/** Applies a profile change to the shared config, then syncs/reindexes affected sources. */
	embeddingApply(request: EmbeddingChangeRequest): Promise<EmbeddingChangeResult>;

	/** Syncs one datasource against its own index. */
	sourcesSync(id: string): Promise<DataSourceSyncResult>;
	/** The background refresh job as the OS sees it, plus the newest result of each scheduled item. */
	refreshScheduleGet(): Promise<RefreshScheduleStatus>;
	/** Make the OS job match the config (install, re-time, or remove) and return the fresh status. */
	refreshScheduleApply(): Promise<RefreshScheduleStatus>;
 }
