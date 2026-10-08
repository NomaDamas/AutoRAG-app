import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppSettings, ConfigRefreshResult, Permission, ResolvedPermission, SettingsBridge } from "../shared/settings-contract";
import { DEFAULT_SETTINGS } from "../shared/settings-contract";
import type { AutoRagConfigService } from "./autorag-config-service";
import type { DataSourceStatusService } from "./datasource-status";
import type { ModelStatusService } from "./model-status";
import type { ProviderCredentialService } from "./provider-credentials";

interface SettingsState {
	settings: AppSettings;
	permissions: Record<string, Permission>;
}

export interface SettingsServiceDeps {
	readonly directory: string;
	/** Live view of the shared AutoRAG config's datasources; the app keeps no copy. */
	readonly dataSources: DataSourceStatusService;
	/** Live view of the shared AutoRAG config's resolved model; the app keeps no copy. */
	readonly models: ModelStatusService;
	/** Read/write surface for the shared AutoRAG config file itself. */
	readonly config: AutoRagConfigService;
	/** Runs an AutoRAGLite index refresh for the manual refresh action. */
	readonly refreshConfig: (methods?: readonly string[]) => Promise<ConfigRefreshResult>;
	/** Encrypted provider credentials, loaded into the environment at startup. */
	readonly credentials: ProviderCredentialService;
	/** Fired after every successful set() so live services can adopt the change. */
	readonly onSettingsChanged?: (settings: AppSettings) => void;
	/** Installs or removes the OS file-menu entries for a settings change; throwing rejects the change. */
	readonly applyOsMenu?: (next: AppSettings, previous: AppSettings) => Promise<void>;
}

const emptyState = (): SettingsState => ({
	settings: DEFAULT_SETTINGS,
	permissions: {},
});

async function loadState(path: string): Promise<SettingsState> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return emptyState();
		const state = parsed as Partial<SettingsState>;
		const persisted: Partial<AppSettings> = state.settings ?? {};
		return {
			settings: {
				...DEFAULT_SETTINGS,
				...persisted,
				appearance: persisted.appearance === "dark" ? "dark" : "light",
			},
			permissions: state.permissions ?? {},
		};
	} catch {
		return emptyState();
	}
}

export function createSettingsService(deps: SettingsServiceDeps): SettingsBridge {
	const path = join(deps.directory, "settings-state.json");
	let statePromise = loadState(path);
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
		const explicitDescendants = Object.keys(state.permissions).some(
			(source) => source !== pathName && source.startsWith(`${pathName}/`),
		);
		return {
			value: value ?? "ask",
			origin: sourcePath === undefined ? "default" : sourcePath === pathName ? "explicit" : "inherited",
			sourcePath: sourcePath ?? null,
			mixed: explicitDescendants,
		};
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
				if (cascade === "apply-all") {
					for (const child of Object.keys(current.permissions)) {
						if (child.startsWith(`${pathName}/`)) current.permissions[child] = value;
					}
				}
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
		modelsResolve: () => deps.models.resolve(),
		configGet: () => deps.config.get(),
		configSet: (path, value) => deps.config.set(path, value),
		configRemove: (path) => deps.config.remove(path),
		configPatch: (updates) => deps.config.patch(updates),
		configRename: (from, to) => deps.config.rename(from, to),
		modelsCatalog: () => deps.config.modelsCatalog(),
		configRefresh: (methods) => deps.refreshConfig(methods),
		credentialsList: async (envNames) => deps.credentials.list(envNames),
		credentialsSet: async (envName, secret) => deps.credentials.set(envName, secret),
		credentialsRemove: async (envName) => deps.credentials.remove(envName),
	};
}
