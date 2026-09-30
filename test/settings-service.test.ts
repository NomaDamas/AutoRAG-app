import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DataSourceStatusService } from "../src/main/datasource-status";
import { createSettingsService } from "../src/main/settings-service";
import type { AssistantSurface, DataSourcesSnapshot } from "../src/shared/settings-contract";

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

describe("createSettingsService", () => {
	it("persists settings, permissions, and contacts", async () => {
		const directory = await mkdtemp(join(tmpdir(), "autorag-settings-"));
		directories.push(directory);
		const service = createSettingsService({
			directory,
			dataSources: noDataSources,
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
			createChatSession: () => createFakeSession("models", []),
			send: () => undefined,
		});

		expect((await service.get()).showHiddenFiles).toBe(false);

		await service.set({ showHiddenFiles: true });
		const reloaded = createSettingsService({
			directory,
			dataSources: noDataSources,
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
			createChatSession: () => createFakeSession("models", []),
			send: () => undefined,
		});

		expect((await service.sourcesList()).configPath).toBe("/autorag/config-1.json");
		expect((await service.sourcesSetEnabled("team-slack", false)).configPath).toBe("/autorag/config-2.json");
		expect((await service.sourcesList()).configPath).toBe("/autorag/config-3.json");
		expect(toggles).toEqual([{ id: "team-slack", enabled: false }]);
	});
});
