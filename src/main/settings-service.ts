import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppSettings, Permission, ResolvedPermission, SettingsBridge } from "../shared/settings-contract";
import { DEFAULT_SETTINGS } from "../shared/settings-contract";
import type { DataSourceStatusService } from "./datasource-status";
import type { ModelStatusService } from "./model-status";

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
	/** Fired after every successful set() so live services can adopt the change. */
	readonly onSettingsChanged?: (settings: AppSettings) => void;
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
		return {
			settings: { ...DEFAULT_SETTINGS, ...(state.settings ?? {}) },
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
			const state = await mutate((current) => {
				current.settings = { ...current.settings, ...patch };
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
	};
}
