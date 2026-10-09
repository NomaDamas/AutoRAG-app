import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AutoRagConfigService } from "../src/main/autorag-config-service";
import type { DataSourceStatusService } from "../src/main/datasource-status";
import type { ModelStatusService } from "../src/main/model-status";
import type { ProviderCredentialService } from "../src/main/provider-credentials";
import { createSettingsService } from "../src/main/settings-service";
import type {
	AutoRagConfigSnapshot,
	ConfigRefreshResult,
	ConfiguredModelSnapshot,
	DataSourcesSnapshot,
	DataSourceSyncResult,
	ProviderCredentialStatus,
} from "../src/shared/settings-contract";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const EMPTY_SNAPSHOT: DataSourcesSnapshot = {
	configPath: "/autorag/config.json",
	configExists: true,
	error: null,
	refresh: { state: "idle", phase: null, finishedAt: null },
	local: { documentCount: null, updatedAt: null },
	sources: [],
};

const EMPTY_SYNC: DataSourceSyncResult = {
	id: "team-slack",
	ok: true,
	state: "indexed",
	chunkCount: 0,
	indexedAt: null,
	durationMs: 0,
	diagnostics: [],
	error: null,
};

const noDataSources: DataSourceStatusService = {
	list: async () => EMPTY_SNAPSHOT,
	setEnabled: async () => undefined,
	setDescription: async () => undefined,
	sync: async () => EMPTY_SYNC,
};

const EMPTY_MODEL: ConfiguredModelSnapshot = {
	configPath: "/autorag/config.json",
	configExists: true,
	error: null,
	model: null,
};

const noModels: ModelStatusService = {
	resolve: async () => EMPTY_MODEL,
};

const EMPTY_CONFIG: AutoRagConfigSnapshot = { configPath: "/autorag/config.json", configExists: true, error: null, config: {} };

const noConfig: AutoRagConfigService = {
	get: async () => EMPTY_CONFIG,
	set: async () => EMPTY_CONFIG,
	remove: async () => EMPTY_CONFIG,
	patch: async () => EMPTY_CONFIG,
	rename: async () => EMPTY_CONFIG,
	modelsCatalog: async () => ({ error: null, providers: [] }),
};

const noRefresh = async (): Promise<ConfigRefreshResult> => ({
	ok: true,
	methods: [],
	scanned: 0,
	written: 0,
	deleted: 0,
	skipped: 0,
	diagnostics: [],
	error: null,
});

const noCredentials: ProviderCredentialService = {
	list: async (): Promise<readonly ProviderCredentialStatus[]> => [],
	set: async (): Promise<readonly ProviderCredentialStatus[]> => [],
	remove: async (): Promise<readonly ProviderCredentialStatus[]> => [],
	load: async (): Promise<readonly string[]> => [],
};

const baseDeps = { config: noConfig, refreshConfig: noRefresh, credentials: noCredentials };

describe("createSettingsService", () => {
	it("persists settings and permissions", async () => {
		const directory = await mkdtemp(join(tmpdir(), "autorag-settings-"));
		directories.push(directory);
		const service = createSettingsService({ directory, dataSources: noDataSources, models: noModels, ...baseDeps });

		await service.set({ telemetry: true });
		await service.permSet("/tmp/docs", "allow", "apply-all");
		expect((await service.permGet("/tmp/docs/readme.md")).value).toBe("allow");

		const reloaded = createSettingsService({ directory, dataSources: noDataSources, models: noModels, ...baseDeps });
		expect((await reloaded.get()).telemetry).toBe(true);
		expect((await reloaded.permGet("/tmp/docs/readme.md")).value).toBe("allow");
	});

	it("defaults showHiddenFiles off and persists the toggle", async () => {
		const directory = await mkdtemp(join(tmpdir(), "autorag-settings-hidden-"));
		directories.push(directory);
		const service = createSettingsService({ directory, dataSources: noDataSources, models: noModels, ...baseDeps });

		expect((await service.get()).showHiddenFiles).toBe(false);

		await service.set({ showHiddenFiles: true });
		const reloaded = createSettingsService({ directory, dataSources: noDataSources, models: noModels, ...baseDeps });
		expect((await reloaded.get()).showHiddenFiles).toBe(true);
	});

	it("defaults to light appearance and persists the global dark choice", async () => {
		const directory = await mkdtemp(join(tmpdir(), "autorag-settings-appearance-"));
		directories.push(directory);
		const service = createSettingsService({ directory, dataSources: noDataSources, models: noModels, ...baseDeps });

		expect((await service.get()).appearance).toBe("light");
		await service.set({ appearance: "dark" });
		const reloaded = createSettingsService({ directory, dataSources: noDataSources, models: noModels, ...baseDeps });
		expect((await reloaded.get()).appearance).toBe("dark");
	});

	it("notifies the host when appearance changes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "autorag-settings-appearance-change-"));
		directories.push(directory);
		const seen: string[] = [];
		const service = createSettingsService({
			directory,
			dataSources: noDataSources,
			models: noModels,
			...baseDeps,
			onSettingsChanged: (settings) => seen.push(settings.appearance),
		});

		await service.set({ appearance: "dark" });
		expect(seen).toEqual(["dark"]);
	});

	it("defaults the dupey scan interval to 60 minutes and notifies listeners on change", async () => {
		const directory = await mkdtemp(join(tmpdir(), "autorag-settings-dupey-"));
		directories.push(directory);
		const seen: number[] = [];
		const service = createSettingsService({
			directory,
			dataSources: noDataSources,
			models: noModels,
			...baseDeps,
			onSettingsChanged: (settings) => seen.push(settings.dupeyScanIntervalMinutes),
		});

		expect((await service.get()).dupeyScanIntervalMinutes).toBe(60);

		await service.set({ dupeyScanIntervalMinutes: 15 });
		expect(seen).toEqual([15]);
		const reloaded = createSettingsService({ directory, dataSources: noDataSources, models: noModels, ...baseDeps });
		expect((await reloaded.get()).dupeyScanIntervalMinutes).toBe(15);
	});

	it("serves datasources live from the shared config instead of a persisted copy", async () => {
		const directory = await mkdtemp(join(tmpdir(), "autorag-settings-sources-"));
		directories.push(directory);
		const toggles: Array<{ id: string; enabled: boolean }> = [];
		let listed = 0;
		const service = createSettingsService({
			directory,
			dataSources: {
				list: async () => ({ ...EMPTY_SNAPSHOT, configPath: `/autorag/config-${++listed}.json` }),
				setEnabled: async (id, enabled) => {
					toggles.push({ id, enabled });
				},
				setDescription: async () => undefined,
				sync: async () => EMPTY_SYNC,
			},
			models: noModels,
			...baseDeps,
		});

		expect((await service.sourcesList()).configPath).toBe("/autorag/config-1.json");
		expect((await service.sourcesSetEnabled("team-slack", false)).configPath).toBe("/autorag/config-2.json");
		expect((await service.sourcesList()).configPath).toBe("/autorag/config-3.json");
		expect(toggles).toEqual([{ id: "team-slack", enabled: false }]);
	});

	it("resolves the active model live from the shared config instead of a persisted copy", async () => {
		const directory = await mkdtemp(join(tmpdir(), "autorag-settings-models-"));
		directories.push(directory);
		let resolved = 0;
		const service = createSettingsService({
			directory,
			dataSources: noDataSources,
			models: {
				resolve: async () => ({
					...EMPTY_MODEL,
					configPath: `/autorag/config-${++resolved}.json`,
					model: {
						provider: "openrouter",
						modelId: "deepseek/deepseek-v4.1-flash",
						displayName: "deepseek/deepseek-v4.1-flash",
						api: "openai-completions",
						baseUrl: "https://openrouter.ai/api/v1",
						resolutionSource: "config",
						auth: { present: true, source: "env", envName: "OPENROUTER_API_KEY" },
					},
				}),
			},
			...baseDeps,
		});

		const first = await service.modelsResolve();
		expect(first.configPath).toBe("/autorag/config-1.json");
		expect(first.model?.provider).toBe("openrouter");
		expect(first.model?.modelId).toBe("deepseek/deepseek-v4.1-flash");
		expect((await service.modelsResolve()).configPath).toBe("/autorag/config-2.json");
	});
});
