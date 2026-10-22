import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	AppSettings,
	ConfigRefreshResult,
	EmbeddingChangeRequest,
	EmbeddingChangeResult,
	EmbeddingSettingsSnapshot,
	Permission,
	ProviderAuthKind,
	ProviderDiscoveryResult,
	ProviderLoginEvent,
	ProviderServerInput,
	ResolvedPermission,
	SettingsBridge,
} from "../shared/settings-contract";
import { DEFAULT_SETTINGS } from "../shared/settings-contract";
import type { AutoRagConfigService } from "./autorag-config-service";
import type { DataSourceStatusService } from "./datasource-status";
import type { ModelStatusService } from "./model-status";
import type { ProviderCredentialService } from "./provider-credentials";
import type { RefreshScheduler } from "./refresh-scheduler";
import type { ProviderAuthService } from "./provider-auth-service";

interface SettingsState {
	settings: AppSettings;
	permissions: Record<string, Permission>;
}

/** The embedding settings surface the renderer drives (implemented by the embedding service). */
export interface EmbeddingSettingsService {
	/** Current global embedder plus the profile catalog and per-source compatibility. */
	get(): Promise<EmbeddingSettingsSnapshot>;
	/** Dry run: what a change would write and which sources could not follow. */
	plan(request: EmbeddingChangeRequest): Promise<EmbeddingSettingsSnapshot>;
	/** Validate, write `minSync.embedder` + reachable per-CLI overrides, then rebuild. */
	apply(request: EmbeddingChangeRequest): Promise<EmbeddingChangeResult>;
	/** Push derived child-process env (qmd model) from the current config; call at startup. */
	applyProcessEnv(): void;
}

export interface SettingsServiceDeps {
	readonly directory: string;
	readonly dataSources: DataSourceStatusService;
	readonly models: ModelStatusService;
	readonly config: AutoRagConfigService;
	readonly refreshConfig: (methods?: readonly string[]) => Promise<ConfigRefreshResult>;
	readonly credentials: ProviderCredentialService;
	readonly providers?: ProviderAuthService;
	readonly embedding?: EmbeddingSettingsService;
	readonly refreshScheduler?: RefreshScheduler;
	readonly onProviderLoginEvent?: (event: ProviderLoginEvent) => void;
	readonly onSettingsChanged?: (settings: AppSettings) => void;
	/** The interface language a profile without a stored choice starts in (the OS language); Korean when omitted. */
	readonly systemLanguage?: AppSettings["language"];
	/** Installs or removes the OS file-menu entries for a settings change; throwing rejects the change. */
	readonly applyOsMenu?: (next: AppSettings, previous: AppSettings) => Promise<void>;
}

async function loadState(path: string, defaults: AppSettings): Promise<SettingsState> {
	const emptyState = (): SettingsState => ({ settings: defaults, permissions: {} });
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return emptyState();
		const state = parsed as Partial<SettingsState>;
		const persisted: Partial<AppSettings> = state.settings ?? {};
		return {
			settings: { ...defaults, ...persisted, appearance: persisted.appearance === "dark" ? "dark" : "light" },
			permissions: state.permissions ?? {},
		};
	} catch {
		return emptyState();
	}
}

export function createSettingsService(deps: SettingsServiceDeps): SettingsBridge {
	const path = join(deps.directory, "settings-state.json");
	let statePromise = loadState(path, deps.systemLanguage === undefined ? DEFAULT_SETTINGS : { ...DEFAULT_SETTINGS, language: deps.systemLanguage });
	const persist = async (): Promise<void> => {
		const state = await statePromise;
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	};
	const mutate = async (update: (state: SettingsState) => void): Promise<SettingsState> => {
		const state = await statePromise;
		update(state);
		statePromise = Promise.resolve(state);
		await persist();
		return state;
	};
	const resolvedPermission = (state: SettingsState, pathName: string): ResolvedPermission => {
		const candidates = Object.entries(state.permissions)
			.filter(([source]) => pathName === source || pathName.startsWith(`${source}/`))
			.sort(([a], [b]) => b.length - a.length);
		const [sourcePath, value] = candidates[0] ?? [];
		const explicitDescendants = Object.keys(state.permissions).some((source) => source !== pathName && source.startsWith(`${pathName}/`));
		return {
			value: value ?? "ask",
			origin: sourcePath === undefined ? "default" : sourcePath === pathName ? "explicit" : "inherited",
			sourcePath: sourcePath ?? null,
			mixed: explicitDescendants,
		};
	};
	const providerListeners = new Set<(event: ProviderLoginEvent) => void>();
	deps.onProviderLoginEvent && providerListeners.add(deps.onProviderLoginEvent);
	const requireProviders = (): ProviderAuthService => {
		if (deps.providers === undefined) throw new Error("Provider authentication is unavailable");
		return deps.providers;
	};
	const requireEmbedding = (): EmbeddingSettingsService => {
		if (deps.embedding === undefined) throw new Error("Embedding settings are unavailable");
		return deps.embedding;
	};
	const requireScheduler = (): RefreshScheduler => {
		if (deps.refreshScheduler === undefined) throw new Error("Background refresh scheduling is unavailable");
		return deps.refreshScheduler;
	};

	return {
		get: async () => (await statePromise).settings,
		set: async (patch) => {
			if (deps.applyOsMenu !== undefined) {
				// Before the write: a failed install rejects the toggle rather than saving "on" with no menu entries.
				const previous = (await statePromise).settings;
				await deps.applyOsMenu({ ...previous, ...patch }, previous);
			}
			const state = await mutate((current) => {
				const appearance = patch.appearance === "dark" || patch.appearance === "light" ? patch.appearance : current.settings.appearance;
				current.settings = { ...current.settings, ...patch, appearance };
			});
			deps.onSettingsChanged?.(state.settings);
			return state.settings;
		},
		clearHistory: async () => undefined,
		permGet: async (pathName) => resolvedPermission(await statePromise, pathName),
		permSet: async (pathName, value, cascade) => {
			await mutate((current) => {
				current.permissions[pathName] = value;
				if (cascade === "apply-all") for (const child of Object.keys(current.permissions)) if (child.startsWith(`${pathName}/`)) current.permissions[child] = value;
			});
		},
		permClear: async (pathName) => {
			await mutate((current) => {
				delete current.permissions[pathName];
			});
		},
		permExplicitUnder: async (pathName) => {
			const state = await statePromise;
			return Object.entries(state.permissions)
				.filter(([source]) => source === pathName || source.startsWith(`${pathName}/`))
				.map(([source, value]) => ({ path: source, value }));
		},
		sourcesList: () => deps.dataSources.list(),
		sourcesSetEnabled: async (id, enabled) => {
			await deps.dataSources.setEnabled(id, enabled);
			return deps.dataSources.list();
		},
		sourcesSetDescription: async (id, description) => {
			await deps.dataSources.setDescription(id, description);
			return deps.dataSources.list();
		},
		sourcesSync: (id) => deps.dataSources.sync(id),
		refreshScheduleGet: () => requireScheduler().status(),
		refreshScheduleApply: () => requireScheduler().reconcile(),
		modelsResolve: () => deps.models.resolve(),
		configGet: () => deps.config.get(),
		configSet: (configPath, value) => deps.config.set(configPath, value),
		configRemove: (configPath) => deps.config.remove(configPath),
		configPatch: (updates) => deps.config.patch(updates),
		configRename: (from, to) => deps.config.rename(from, to),
		modelsCatalog: () => deps.config.modelsCatalog(),
		configRefresh: (methods) => deps.refreshConfig(methods),
		credentialsList: async (envNames) => deps.credentials.list(envNames),
		credentialsSet: async (envName, secret) => deps.credentials.set(envName, secret),
		credentialsRemove: async (envName) => deps.credentials.remove(envName),
		providersList: async () => deps.providers?.list() ?? [],
		providerLoginStart: async (providerId, authType: ProviderAuthKind) => requireProviders().start(providerId, authType),
		providerLoginRespond: async (sessionId, value) => requireProviders().respond(sessionId, value),
		providerLoginCancel: async (sessionId) => {
			await deps.providers?.cancel(sessionId);
		},
		providerLogout: async (providerId) => {
			await requireProviders().logout(providerId);
		},
		onProviderLoginEvent: (listener) => {
			providerListeners.add(listener);
			return () => providerListeners.delete(listener);
		},
		providersDiscover: (input: ProviderServerInput): Promise<ProviderDiscoveryResult> => requireProviders().discover(input),
		providersUpsert: (input: ProviderServerInput) => requireProviders().upsert(input),
		providersRemove: (id: string) => requireProviders().remove(id),
		providersTest: (id: string) => requireProviders().test(id),
		embeddingGet: () => requireEmbedding().get(),
		embeddingPlan: (request: EmbeddingChangeRequest) => requireEmbedding().plan(request),
		embeddingApply: (request: EmbeddingChangeRequest) => requireEmbedding().apply(request),
	};
}
