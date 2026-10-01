import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DataSourceStatusService } from "../src/main/datasource-status";
import type { ModelStatusService } from "../src/main/model-status";
import { createSettingsService } from "../src/main/settings-service";
import type { AssistantSurface, ConfiguredModelSnapshot, DataSourcesSnapshot } from "../src/shared/settings-contract";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function createFakeSession(surface: AssistantSurface, events: unknown[]): {
	readonly agent: { subscribe(listener: (event: unknown) => void): () => void };
	prompt(text: string): Promise<void>;
	dispose(): void;
} {
	const listeners = new Set<(event: unknown) => void>();
	return {
		agent: {
			subscribe(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		async prompt(text) {
			expect(surface).toBe("models");
			expect(text).toBe("Which model is active?");
			for (const event of events) for (const listener of listeners) listener(event);
		},
		dispose() {
			listeners.clear();
		},
	};
}

const EMPTY_SNAPSHOT: DataSourcesSnapshot = {
	configPath: "/autorag/config.json",
	configExists: true,
	error: null,
	accessTags: [],
	refresh: { state: "idle", phase: null, finishedAt: null },
	sources: [],
};

const noDataSources: DataSourceStatusService = {
	list: async () => EMPTY_SNAPSHOT,
	setEnabled: async () => undefined,
	setDescription: async () => undefined,
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

describe("createSettingsService", () => {
	it("persists settings, permissions, and contacts", async () => {
		const directory = await mkdtemp(join(tmpdir(), "autorag-settings-"));
		directories.push(directory);
		const service = createSettingsService({
			directory,
			dataSources: noDataSources,
			models: noModels,
			createChatSession: () => createFakeSession("models", []),
			send: () => undefined,
		});

		await service.set({ telemetry: true });
		await service.permSet("/tmp/docs", "allow", "apply-all");
		expect((await service.permGet("/tmp/docs/readme.md")).value).toBe("allow");
		expect((await service.contactsAdd({ id: "alice", name: "Alice", role: "Reviewer", description: "Reviews docs" })).ok).toBe(true);
		expect((await service.contactsList()).map((contact) => contact.id)).toEqual(["alice"]);

		const reloaded = createSettingsService({
			directory,
			dataSources: noDataSources,
			models: noModels,
			createChatSession: () => createFakeSession("models", []),
			send: () => undefined,
		});
		expect((await reloaded.get()).telemetry).toBe(true);
		expect((await reloaded.contactsList()).map((contact) => contact.id)).toEqual(["alice"]);
	});

	it("drives the settings assistant through the supplied chat session", async () => {
		const directory = await mkdtemp(join(tmpdir(), "autorag-settings-chat-"));
		directories.push(directory);
		const events: unknown[] = [];
		const service = createSettingsService({
			directory,
			dataSources: noDataSources,
			models: noModels,
			createChatSession: (surface) =>
				createFakeSession(surface, [
					{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Use the active model." } },
				]),
			send: (_channel, event) => events.push(event),
		});

		await service.assistantSend("models", "Which model is active?");

		expect(events).toEqual([
			{ type: "text", surface: "models", delta: "Use the active model." },
			{ type: "done", surface: "models" },
		]);
	});

	it("defaults showHiddenFiles off and persists the toggle", async () => {
		const directory = await mkdtemp(join(tmpdir(), "autorag-settings-hidden-"));
		directories.push(directory);
		const service = createSettingsService({
			directory,
			dataSources: noDataSources,
			models: noModels,
			createChatSession: () => createFakeSession("models", []),
			send: () => undefined,
		});

		expect((await service.get()).showHiddenFiles).toBe(false);

		await service.set({ showHiddenFiles: true });
		const reloaded = createSettingsService({
			directory,
			dataSources: noDataSources,
			models: noModels,
			createChatSession: () => createFakeSession("models", []),
			send: () => undefined,
		});
		expect((await reloaded.get()).showHiddenFiles).toBe(true);
	});

	it("defaults the dupey scan interval to 60 minutes and notifies listeners on change", async () => {
		const directory = await mkdtemp(join(tmpdir(), "autorag-settings-dupey-"));
		directories.push(directory);
		const seen: number[] = [];
		const service = createSettingsService({
			directory,
			dataSources: noDataSources,
			models: noModels,
			createChatSession: () => createFakeSession("models", []),
			send: () => undefined,
			onSettingsChanged: (settings) => seen.push(settings.dupeyScanIntervalMinutes),
		});

		expect((await service.get()).dupeyScanIntervalMinutes).toBe(60);

		await service.set({ dupeyScanIntervalMinutes: 15 });
		expect(seen).toEqual([15]);
		const reloaded = createSettingsService({
			directory,
			dataSources: noDataSources,
			models: noModels,
			createChatSession: () => createFakeSession("models", []),
			send: () => undefined,
		});
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
			},
			models: noModels,
			createChatSession: () => createFakeSession("models", []),
			send: () => undefined,
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
			createChatSession: () => createFakeSession("models", []),
			send: () => undefined,
		});

		const first = await service.modelsResolve();
		expect(first.configPath).toBe("/autorag/config-1.json");
		expect(first.model?.provider).toBe("openrouter");
		expect(first.model?.modelId).toBe("deepseek/deepseek-v4.1-flash");
		expect((await service.modelsResolve()).configPath).toBe("/autorag/config-2.json");
	});
});
