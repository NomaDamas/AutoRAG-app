import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { createProfileSession } from "@autorag/librarian/profiles";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createSettingsCustomizerToolkit,
	settingsCustomizerProfile,
} from "../src/main/agents/profiles/settings-customizer";
import { createAutoRagConfigService } from "../src/main/autorag-config-service";
import { createMcpSettingsService } from "../src/main/mcp-settings-service";
import { createProviderCredentialService } from "../src/main/provider-credentials";
import { createSettingsService } from "../src/main/settings-service";
import type { DataSourcesSnapshot, SettingsBridge } from "../src/shared/settings-contract";

const cleanups: Array<() => Promise<void> | void> = [];
let root: string;
let agentDir: string;
let settingsDir: string;
let configPath: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "settings-customizer-root-"));
	agentDir = await mkdtemp(join(tmpdir(), "settings-customizer-agent-"));
	settingsDir = join(root, "settings");
	configPath = join(root, "config.json");
	env = { HOME: root, AUTORAG_CONFIG: configPath };
	await mkdir(join(root, "Docs"), { recursive: true });
	await writeFile(
		configPath,
		`${JSON.stringify(
			{
				searchPaths: [join(root, "Docs")],
				workspacePath: root,
				memoryPath: join(root, "memory.json"),
				datasources: {},
			},
			null,
			2,
		)}\n`,
	);
	cleanups.push(
		() => rm(root, { recursive: true, force: true }),
		() => rm(agentDir, { recursive: true, force: true }),
	);
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const readConfig = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(configPath, "utf8"));

function createHarness(): { readonly settings: SettingsBridge; readonly reconcile: ReturnType<typeof vi.fn> } {
	const config = createAutoRagConfigService({ env, cwd: root });
	const credentials = createProviderCredentialService({
		filePath: join(root, "credentials.enc.json"),
		safeStorage: { isEncryptionAvailable: () => true, encryptString: (text) => Buffer.from(`enc:${text}`), decryptString: (buf) => buf.toString().slice(4) },
		env: {},
	});
	const mcp = createMcpSettingsService({ agentDir: () => agentDir });
	const reconcile = vi.fn(async () => ({ supported: true, mechanism: "launchd", installed: true, wanted: true, intervalMs: 3600000, lastTickAt: null, local: null, sources: {}, paused: null, conflicts: [], error: null }));
	const snapshot = async (): Promise<DataSourcesSnapshot> => {
		const cfg = await config.get();
		const ds = (cfg.config.datasources ?? {}) as Record<string, Record<string, unknown>>;
		return {
			configPath,
			configExists: true,
			error: null,
			refresh: { state: "idle", phase: null, finishedAt: null },
			local: { documentCount: 0, updatedAt: null },
			sources: Object.entries(ds).map(([id, raw]) => ({
				id,
				type: typeof raw?.type === "string" ? raw.type : id,
				description: typeof raw?.description === "string" ? raw.description : "",
				enabled: raw?.enabled !== false,
				status: "ready",
				install: { state: "builtin", binary: null, path: null, detail: "", app: { required: false, installed: null, name: "" } },
				agent: { state: "connected", skillName: null, tags: [], detail: "" },
				index: { state: "not-indexed", chunkCount: null, unit: null, indexedAt: null, detail: "" },
			})),
		};
	};
	const settings = createSettingsService({
		directory: settingsDir,
		dataSources: {
			list: snapshot,
			setEnabled: vi.fn(async (id: string, enabled: boolean) => {
				await config.patch([{ path: ["datasources", id, "enabled"], value: enabled }]);
			}),
			setDescription: vi.fn(async (id: string, description: string) => {
				await config.patch([{ path: ["datasources", id, "description"], value: description }]);
			}),
			sync: vi.fn(),
		} as never,
		models: { resolve: vi.fn(), catalog: vi.fn() } as never,
		config,
		refreshConfig: vi.fn() as never,
		credentials,
		providers: { list: vi.fn(async () => []) } as never,
		mcp,
		refreshScheduler: { status: vi.fn(), reconcile, remove: vi.fn() } as never,
	});
	return { settings, reconcile };
}

async function callTool(kit: ReturnType<typeof createSettingsCustomizerToolkit>, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const tool = kit.tools.find((t) => t.name === name);
	if (tool === undefined) throw new Error(`tool ${name} not found`);
	const res = await tool.execute("call-1", args as never, undefined, undefined, undefined as never);
	const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
	return JSON.parse(text) as Record<string, unknown>;
}

describe("settings-customizer unified profile & toolkit", () => {
	it("combines tools across all settings domains without duplicate tool names and uses an English prompt", () => {
		const { settings } = createHarness();
		const kit = createSettingsCustomizerToolkit({
			settings,
			listLocations: async () => [],
			listTags: async () => [],
			homeDir: root,
			platform: "darwin",
			language: () => "ko",
		});

		const names = kit.tools.map((t) => t.name);
		expect(new Set(names).size).toBe(names.length);

		// General, Sidebar/Context Menu, Shortcuts, AI/Web, Search/Indexing/Schedule/Duplicates, LTR, MCP, Datasources
		for (const expected of [
			"get_general_settings",
			"update_general_settings",
			"update_reading",
			"get_app_settings",
			"update_sidebar",
			"update_context_menu",
			"upsert_magic_action",
			"delete_magic_action",
			"get_shortcuts",
			"update_shortcuts",
			"get_ai_settings",
			"set_model_role",
			"set_thinking_level",
			"update_web_search",
			"get_search_settings",
			"update_index_scope",
			"update_index_options",
			"update_duplicates",
			"update_refresh_schedule",
			"get_ltr_settings",
			"update_ltr_settings",
			"get_connections",
			"update_mcp_server",
			"search_mcp_registry",
			"install_mcp_server",
			"get_datasources",
			"add_datasource",
			"update_datasource",
			"update_datasource_connector",
			"remove_datasource",
		]) {
			expect(names, `missing tool ${expected}`).toContain(expected);
		}

		const profile = settingsCustomizerProfile({ language: "ko", surface: "ltr", toolkit: kit, platform: "darwin" });
		expect(profile.id).toBe("settings-customizer");
		expect(profile.tools).toEqual([]);
		expect(profile.systemPrompt).toMatch(/language the person writes in/iu);
		expect(profile.systemPrompt).toContain("if it is unclear, reply in Korean");
		expect(profile.systemPrompt).not.toMatch(/[가-힯぀-ヿ一-鿿]/u);
	});

	it("updates LTR settings (rankingLog, ltr.enabled, autoTrain) and refresh schedule conditions", async () => {
		const { settings } = createHarness();
		const kit = createSettingsCustomizerToolkit({
			settings,
			listLocations: async () => [],
			listTags: async () => [],
			homeDir: root,
			platform: "darwin",
			language: () => "en",
		});

		const ltrBefore = await callTool(kit, "get_ltr_settings", {});
		expect(ltrBefore.ok).toBe(true);
		expect(ltrBefore.rankingLog).toBe(true);

		const ltrRes = await callTool(kit, "update_ltr_settings", {
			rankingLog: false,
			enabled: true,
			autoTrainEnabled: true,
			autoTrainMinNewRuns: 150,
		});
		expect(ltrRes.ok).toBe(true);

		let cfg = await readConfig();
		expect(cfg.rankingLog).toBe(false);
		expect(cfg.ltr).toMatchObject({
			enabled: true,
			autoTrain: { enabled: true, minNewRuns: 150 },
		});

		const schedRes = await callTool(kit, "update_refresh_schedule", {
			acOnly: true,
			windowEnabled: true,
			start: "23:00",
			end: "06:00",
		});
		expect(schedRes.ok).toBe(true);
		cfg = await readConfig();
		expect((cfg.refresh as Record<string, unknown>).schedule).toEqual({
			power: "ac",
			windows: ["23:00-06:00"],
		});

		const changes = kit.takeChanges();
		expect(changes.length).toBeGreaterThanOrEqual(2);
	});

	it("aggregates changes across general, shortcuts, sidebar, web search, and datasources in one session", async () => {
		const { settings } = createHarness();
		const kit = createSettingsCustomizerToolkit({
			settings,
			listLocations: async () => [],
			listTags: async () => [],
			homeDir: root,
			platform: "darwin",
			language: () => "en",
		});

		await callTool(kit, "update_general_settings", { appearance: "dark" });
		await callTool(kit, "update_shortcuts", { preset: "windowsExplorer" });
		await callTool(kit, "update_web_search", { provider: "duckduckgo" });
		await callTool(kit, "add_datasource", { type: "obsidian", alias: "vault", connector: { vaultPath: join(root, "Docs") } });

		const changes = kit.takeChanges();
		expect(changes.map((c) => c.kind)).toEqual(["general", "shortcuts", "ai", "connections"]);

		const appState = await settings.get();
		expect(appState.appearance).toBe("dark");
		expect(appState.shortcuts.overrides.rename).toBe("F2");
		const cfg = await readConfig();
		expect((cfg.webSearch as Record<string, unknown>).provider).toBe("duckduckgo");
		expect((cfg.datasources as Record<string, unknown>).vault).toBeDefined();
	});

	it("runs end-to-end through createProfileSession and edits settings from any tab surface", async () => {
		const registration: FauxProviderRegistration = registerFauxProvider({
			api: `faux-settings-all-${Math.random().toString(36).slice(2)}`,
			provider: "faux-settings-all",
			models: [{ id: "settings-all", reasoning: true }],
		});
		cleanups.push(() => registration.unregister());

		const { settings } = createHarness();
		const kit = createSettingsCustomizerToolkit({
			settings,
			listLocations: async () => [],
			listTags: async () => [],
			homeDir: root,
			platform: "darwin",
			language: () => "en",
		});
		const profile = settingsCustomizerProfile({ language: "en", surface: "about", toolkit: kit, platform: "darwin" });
		const session = await createProfileSession({
			profile,
			cwd: root,
			agentDir,
			env,
			model: { model: registration.getModel()! },
		});
		cleanups.push(() => session.dispose());

		registration.setResponses([
			fauxAssistantMessage([
				fauxToolCall("update_general_settings", { i: "Switching to dark mode", appearance: "dark" }),
				fauxToolCall("update_ltr_settings", { i: "Updating ranking log", rankingLog: false }),
			]),
			fauxAssistantMessage("Switched to dark mode and turned off ranking log."),
		]);

		await session.prompt("Turn on dark mode and disable ranking log");
		expect((await settings.get()).appearance).toBe("dark");
		expect((await readConfig()).rankingLog).toBe(false);
	});
});
