import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppCustomizerService } from "../src/main/app-customizer-service";
import { createAutoRagConfigService } from "../src/main/autorag-config-service";
import { createMcpSettingsService } from "../src/main/mcp-settings-service";
import { createSettingsService } from "../src/main/settings-service";
import { APP_CUSTOMIZER_SURFACES, isAppCustomizerRequest, type AppCustomizerEvent, type AppCustomizerSurface } from "../src/shared/app-customizer-contract";

const cleanups: Array<() => Promise<void> | void> = [];
let root: string;
let agentDir: string;
let configPath: string;
let events: AppCustomizerEvent[];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "cfg-surfaces-"));
	agentDir = join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(root, "existing"));
	configPath = join(root, "config.json");
	await writeFile(configPath, `${JSON.stringify({ searchPaths: [join(root, "existing")], workspacePath: root, memoryPath: join(root, "memory.json") }, null, 2)}\n`);
	events = [];
	cleanups.push(() => rm(root, { recursive: true, force: true }));
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function register(): FauxProviderRegistration {
	const registration = registerFauxProvider({
		api: `faux-config-surfaces-${Math.random().toString(36).slice(2)}`,
		provider: "faux-config-surfaces",
		models: [{ id: "config-surfaces", reasoning: true }],
	});
	cleanups.push(() => registration.unregister());
	return registration;
}

function realSettings() {
	const env = { HOME: root, AUTORAG_CONFIG: configPath };
	return createSettingsService({
		directory: join(root, "settings"),
		dataSources: { list: async () => ({ sources: [] }), setEnabled: async () => undefined, setDescription: async () => undefined, sync: async () => undefined } as never,
		models: { resolve: async () => ({}), catalog: async () => ({}) } as never,
		config: createAutoRagConfigService({ env, cwd: root }),
		refreshConfig: (async () => ({})) as never,
		credentials: { list: async () => [], set: async () => [], remove: async () => [] } as never,
		providers: { list: async () => [] } as never,
		mcp: createMcpSettingsService({ agentDir: () => agentDir }),
	});
}

async function run(surface: AppCustomizerSurface, toolCalls: ReadonlyArray<readonly [string, Record<string, unknown>]>, message: string): Promise<void> {
	const registration = register();
	const settings = realSettings();
	const service = createAppCustomizerService({
		send: (event) => events.push(event),
		resolveModel: async () => ({ model: registration.getModel()! }),
		agentDir,
		env: {},
		cwd: root,
		language: () => "en",
		settings,
		listLocations: async () => [],
		listTags: async () => [],
	});
	registration.setResponses([...toolCalls.map(([name, args]) => fauxAssistantMessage([fauxToolCall(name, { i: "Working", ...args })])), fauxAssistantMessage("Done.")]);
	await service.send(`run-${surface}`, { sessionId: `sess-${surface}`, surface, message });
	service.dispose();
}

describe("the app customizer service routes each Settings section to its own pi agent profile", () => {
	it("accepts every surface in a request and rejects an unknown one", () => {
		for (const surface of APP_CUSTOMIZER_SURFACES) expect(isAppCustomizerRequest({ sessionId: "s", message: "hi", surface })).toBe(true);
		expect(isAppCustomizerRequest({ sessionId: "s", message: "hi", surface: "source", sourceAlias: "slack" })).toBe(true);
		expect(isAppCustomizerRequest({ sessionId: "s", message: "hi", surface: "source", sourceAlias: "" })).toBe(false);
		expect(isAppCustomizerRequest({ sessionId: "s", message: "hi", surface: "billing" })).toBe(false);
	});

	it("general: writes the app preference into settings-state.json and reports a general change", async () => {
		await run("general", [["update_general_settings", { appearance: "dark" }]], "dark mode please");
		const done = events.find((event) => event.type === "turn-done");
		expect(done?.type === "turn-done" && done.changes[0]?.kind).toBe("general");
		expect(done?.type === "turn-done" && done.settings.appearance).toBe("dark");
		expect(JSON.parse(await readFile(join(root, "settings", "settings-state.json"), "utf8")).settings.appearance).toBe("dark");
	});

	it("web: writes the shared AutoRAG config.json the Web page would write", async () => {
		await run("web", [["update_web_search", { provider: "duckduckgo" }]], "use duckduckgo");
		const done = events.find((event) => event.type === "turn-done");
		expect(done?.type === "turn-done" && done.changes[0]?.kind).toBe("ai");
		expect(JSON.parse(await readFile(configPath, "utf8")).webSearch.provider).toBe("duckduckgo");
	});

	it("indexing: adds a real folder to searchPaths and refuses one that does not exist", async () => {
		const docs = join(root, "Docs");
		await mkdir(docs);
		await run("indexing", [["update_index_scope", { addFolders: [docs, join(root, "nope")] }]], "add docs");
		const config = JSON.parse(await readFile(configPath, "utf8"));
		expect(config.searchPaths).toContain(docs);
		expect(config.searchPaths).not.toContain(join(root, "nope"));
	});

	it("mcp: adds a server to the agent's mcp.json", async () => {
		await run("mcp", [["update_mcp_server", { name: "docs", action: "upsert", url: "https://example.com/mcp" }]], "add docs server");
		const mcp = JSON.parse(await readFile(join(agentDir, "mcp.json"), "utf8"));
		expect(mcp.mcpServers.docs.url).toBe("https://example.com/mcp");
	});

	it("apps: routes to the dedicated datasource connections profile and connects a datasource", async () => {
		await run("apps", [["add_datasource", { type: "obsidian", alias: "notes", connector: { vaultPath: join(root, "existing") } }]], "connect obsidian");
		const config = JSON.parse(await readFile(configPath, "utf8"));
		expect(config.datasources.notes).toMatchObject({ type: "obsidian", connector: { vaultPath: join(root, "existing") } });
	});

	it("source: forwards sourceAlias context to the datasource connections profile", async () => {
		const registration = register();
		const settings = realSettings();
		let seenPrompt = "";
		const service = createAppCustomizerService({
			send: (event) => events.push(event),
			resolveModel: async () => ({ model: registration.getModel()! }),
			agentDir,
			env: {},
			cwd: root,
			language: () => "en",
			settings,
			listLocations: async () => [],
			listTags: async () => [],
		});
		registration.setResponses([
			(context: { messages?: Array<{ role?: string; content?: Array<{ text?: string }> }> }) => {
				const user = context.messages?.find((m) => m.role === "user");
				seenPrompt = (user?.content ?? []).map((c) => c.text ?? "").join("");
				return fauxAssistantMessage("Checked.");
			},
		] as never);
		await service.send("run-source", { sessionId: "sess-source", surface: "source", sourceAlias: "work-notes", message: "update this connection" });
		service.dispose();
		expect(seenPrompt).toContain('[Active Settings datasource page: "work-notes"]');
	});

	it("ltr / account / plan / remote: unified settings profile edits settings across domains from any tab", async () => {
		await run(
			"remote",
			[
				["update_general_settings", { appearance: "dark" }],
				["update_ltr_settings", { rankingLog: false }],
				["update_shortcuts", { preset: "windowsExplorer" }],
			],
			"switch to dark mode, disable ranking log, and use windows shortcuts",
		);
		const appSettings = JSON.parse(await readFile(join(root, "settings", "settings-state.json"), "utf8")).settings;
		const config = JSON.parse(await readFile(configPath, "utf8"));
		expect(appSettings.appearance).toBe("dark");
		expect(appSettings.shortcuts.overrides.rename).toBe("F2");
		expect(config.rankingLog).toBe(false);
	});
});
