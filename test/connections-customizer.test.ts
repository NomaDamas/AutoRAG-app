import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { createProfileSession } from "@autorag/librarian/profiles";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createConnectionsCustomizerToolkit, connectionsCustomizerProfile } from "../src/main/agents/profiles/connections-customizer";
import { subscribeProfileProgress } from "../src/main/agents/profile-progress";
import { createAutoRagConfigService } from "../src/main/autorag-config-service";
import { createMcpSettingsService } from "../src/main/mcp-settings-service";
import { createSettingsService } from "../src/main/settings-service";
import type { DataSourceInstallState, DataSourceRow, DataSourcesSnapshot, SettingsBridge } from "../src/shared/settings-contract";

const cleanups: Array<() => Promise<void> | void> = [];
let root: string;
let agentDir: string;
let settingsDir: string;
let configPath: string;
let mcpPath: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "connections-customizer-root-"));
	agentDir = await mkdtemp(join(tmpdir(), "connections-customizer-agent-"));
	settingsDir = join(root, "settings");
	configPath = join(root, "config.json");
	mcpPath = join(agentDir, "mcp.json");
	await writeFile(configPath, `${JSON.stringify({ searchPaths: [root], workspacePath: root, memoryPath: join(root, "memory.json"), datasources: { slack: { type: "slack" } } }, null, 2)}\n`);
	cleanups.push(
		() => rm(root, { recursive: true, force: true }),
		() => rm(agentDir, { recursive: true, force: true }),
	);
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const readJson = async (path: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(path, "utf8"));

function row(id: string, install: DataSourceInstallState, extra: Partial<DataSourceRow> = {}): DataSourceRow {
	return {
		id,
		type: id,
		description: "",
		enabled: true,
		status: "ready",
		install: { state: install, binary: null, path: null, detail: `${id} detail`, app: { required: false, installed: null, name: "" } },
		agent: { state: install === "unsupported" ? "unsupported" : "connected", skillName: null, tags: [], detail: "" },
		index: { state: "indexed", chunkCount: 3, unit: "message", indexedAt: null, detail: "" },
		...extra,
	};
}

interface Harness {
	readonly settings: SettingsBridge;
	readonly rows: DataSourceRow[];
	readonly setEnabled: Mock;
	readonly setDescription: Mock;
	readonly reconcile: Mock;
}

function createHarness(options: { readonly rows?: DataSourceRow[]; readonly scheduleFails?: boolean } = {}): Harness {
	const rows = options.rows ?? [row("slack", "installed")];
	const config = createAutoRagConfigService({ env: { HOME: root, AUTORAG_CONFIG: configPath }, cwd: root });
	const mcp = createMcpSettingsService({ agentDir: () => agentDir });
	const setEnabled = vi.fn(async (id: string, enabled: boolean) => {
		await config.patch([{ path: ["datasources", id, "enabled"], value: enabled }]);
	});
	const setDescription = vi.fn(async (id: string, description: string) => {
		const text = description.trim();
		await config.patch([
			text.length === 0 ? { path: ["datasources", id, "description"], remove: true } : { path: ["datasources", id, "description"], value: text },
		]);
	});
	const reconcile = options.scheduleFails === true
		? vi.fn(async () => {
				throw new Error("launchd is unavailable");
			})
		: vi.fn(async () => ({ mechanism: null, installed: false, wanted: false, intervalMs: null, sources: {} }));
	const snapshot = (): DataSourcesSnapshot => ({
		configPath,
		configExists: true,
		error: null,
		refresh: { state: "idle", phase: null, finishedAt: null },
		local: { documentCount: 0, updatedAt: null },
		sources: rows,
	});
	const settings = createSettingsService({
		directory: settingsDir,
		dataSources: { list: vi.fn(async () => snapshot()), setEnabled, setDescription, sync: vi.fn() } as never,
		models: { resolve: vi.fn(), catalog: vi.fn() } as never,
		config,
		refreshConfig: vi.fn() as never,
		credentials: { list: vi.fn(), set: vi.fn(), remove: vi.fn() } as never,
		mcp,
		refreshScheduler: { status: vi.fn(), reconcile, remove: vi.fn() } as never,
	} satisfies Parameters<typeof createSettingsService>[0] as never);
	return { settings, rows, setEnabled, setDescription, reconcile };
}

function toolOf(settings: SettingsBridge, name: string, language: "ko" | "en" = "ko") {
	const kit = createConnectionsCustomizerToolkit({ settings, language: () => language });
	const tool = kit.tools.find((entry) => entry.name === name);
	if (tool === undefined) throw new Error(`missing tool ${name}`);
	return { kit, tool };
}

async function runTool(tool: { execute: unknown }, args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const execute = tool.execute as (callId: string, params: unknown) => Promise<{ content: [{ type: "text"; text: string }] }>;
	const result = await execute("call", args);
	return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

/** The stored `mcpServers.<name>` entry, so assertions do not fight the index signature. */
async function mcpServer(name: string): Promise<Record<string, unknown>> {
	const servers = ((await readJson(mcpPath)).mcpServers ?? {}) as Record<string, Record<string, unknown>>;
	return servers[name]!;
}

function register(): FauxProviderRegistration {
	const registration = registerFauxProvider({
		api: `faux-connections-customizer-${Math.random().toString(36).slice(2)}`,
		provider: "faux-connections-customizer",
		models: [{ id: "connections-customizer", reasoning: true }],
	});
	cleanups.push(() => registration.unregister());
	return registration;
}

describe("connections-customizer pi agent profile & toolkit", () => {
	it("exposes only get_connections, update_datasource and update_mcp_server and states the closed scope invariants", () => {
		const harness = createHarness();
		const kit = createConnectionsCustomizerToolkit({ settings: harness.settings });
		const profile = connectionsCustomizerProfile({ language: "ko", surface: "mcp", toolkit: kit });

		expect(profile.id).toBe("connections-customizer");
		expect(profile.tools).toEqual([]);
		expect(profile.customTools?.map((tool) => tool.name).sort()).toEqual(["get_connections", "update_datasource", "update_mcp_server"]);
		expect(profile.systemPrompt).toContain("Korean");
		expect(profile.systemPrompt).toContain("confirmedByUser");
		expect(profile.systemPrompt).toContain("credential");
		expect(profile.systemPrompt).toContain("sync");

		const appsProfile = connectionsCustomizerProfile({ language: "en", surface: "apps", toolkit: kit });
		expect(appsProfile.id).toBe("connections-customizer");
		expect(appsProfile.systemPrompt).toContain("English");
	});

	it("lists MCP servers and datasources with key names only and never leaks env or header values", async () => {
		await writeFile(
			mcpPath,
			`${JSON.stringify(
				{
					mcpServers: {
						"secret-stdio": { command: "npx", args: ["-y", "server"], env: { API_TOKEN: "super-secret-token" } },
						"secret-http": { url: "https://example.com/mcp", headers: { Authorization: "Bearer super-secret-token" } },
					},
				},
				null,
				2,
			)}\n`,
		);
		const harness = createHarness({ rows: [row("slack", "installed")] });
		const { tool } = toolOf(harness.settings, "get_connections");

		const result = await runTool(tool, {});
		const text = JSON.stringify(result);

		expect(text).not.toContain("super-secret-token");
		expect(text).toContain("API_TOKEN");
		expect(text).toContain("Authorization");
		expect(text).toContain("https://example.com/mcp");
		expect(text).toContain("npx");

		const mcp = result.mcp as { servers: Array<Record<string, unknown>> };
		const stdio = mcp.servers.find((server) => server.name === "secret-stdio")!;
		expect(stdio.transport).toBe("stdio");
		expect(stdio.command).toBe("npx");
		expect(stdio.envKeys).toEqual(["API_TOKEN"]);

		const datasources = result.datasources as Array<Record<string, unknown>>;
		expect(datasources[0]).toMatchObject({ id: "slack", installState: "installed", pollingIntervalMs: 0 });
	});

	it("applies enable, disable and exposure shapes exactly like the McpPage switches", async () => {
		await writeFile(
			mcpPath,
			`${JSON.stringify({ mcpServers: { docs: { url: "https://example.com/mcp", exposure: "direct", oauth: { token: "x" } } } }, null, 2)}\n`,
		);
		const harness = createHarness();
		const { tool } = toolOf(harness.settings, "update_mcp_server");

		await runTool(tool, { name: "docs", action: "disable" });
		expect((await readJson(mcpPath)).mcpServers).toMatchObject({ docs: { enabled: false } });

		await runTool(tool, { name: "docs", action: "enable" });
		const enabled = await mcpServer("docs");
		expect(enabled.enabled).toBeUndefined();
		expect(enabled.oauth).toEqual({ token: "x" });

		await runTool(tool, { name: "docs", action: "set_exposure", exposure: "deferred" });
		expect((await mcpServer("docs")).exposure).toBe("deferred");

		await runTool(tool, { name: "docs", action: "set_exposure", exposure: "codemode" });
		expect((await mcpServer("docs")).exposure).toBeUndefined();
	});

	it("upserts http and stdio entries, keeps unmanaged keys, and refuses a bad url with the service message", async () => {
		await writeFile(
			mcpPath,
			`${JSON.stringify({ mcpServers: { managed: { url: "https://old.example.com", oauth: { token: "keep" }, toolExposure: { read: "direct" } } } }, null, 2)}\n`,
		);
		const harness = createHarness();
		const { tool } = toolOf(harness.settings, "update_mcp_server");

		await runTool(tool, { name: "remote", action: "upsert", url: "https://remote.example.com/mcp", headers: { "X-Team": "core" } });
		await runTool(tool, { name: "local", action: "upsert", command: "npx", args: ["-y", "server"], env: { KEY: "value" } });
		expect(await mcpServer("remote")).toEqual({ url: "https://remote.example.com/mcp", headers: { "X-Team": "core" } });
		expect(await mcpServer("local")).toEqual({ command: "npx", args: ["-y", "server"], env: { KEY: "value" } });

		await runTool(tool, { name: "managed", action: "upsert", replaces: "managed", url: "https://new.example.com", description: "updated" });
		const managed = await mcpServer("managed");
		expect(managed.oauth).toEqual({ token: "keep" });
		expect(managed.toolExposure).toEqual({ read: "direct" });
		expect(managed.url).toBe("https://new.example.com");
		expect(managed.description).toBe("updated");

		const bad = await runTool(tool, { name: "bad", action: "upsert", url: "ftp://example.com" });
		expect(bad.ok).toBe(false);
		expect(String(bad.error)).toMatch(/http/i);
	});

	it("keeps environment and header values out of every tool output, including an edit of the entry that holds them", async () => {
		await writeFile(
			mcpPath,
			`${JSON.stringify({ mcpServers: { vault: { command: "vault", args: ["serve"], env: { VAULT_TOKEN: "hunter2-secret" } } } }, null, 2)}\n`,
		);
		const harness = createHarness();
		const { tool } = toolOf(harness.settings, "update_mcp_server");

		const inspected = await runTool(toolOf(harness.settings, "get_connections").tool, {});
		const edited = await runTool(tool, { name: "vault", action: "upsert", replaces: "vault", command: "vault", args: ["serve", "--port", "1"] });
		expect(JSON.stringify(inspected)).not.toContain("hunter2-secret");
		expect(JSON.stringify(edited)).not.toContain("hunter2-secret");
		expect((await mcpServer("vault")).env).toEqual({ VAULT_TOKEN: "hunter2-secret" });
	});

	it("removes an MCP server only when the person confirmed it", async () => {
		await writeFile(mcpPath, `${JSON.stringify({ mcpServers: { docs: { url: "https://example.com/mcp" } } }, null, 2)}\n`);
		const harness = createHarness();
		const { tool } = toolOf(harness.settings, "update_mcp_server");

		const refused = await runTool(tool, { name: "docs", action: "remove" });
		expect(refused.ok).toBe(false);
		expect(String(refused.error)).toMatch(/confirmedByUser/);
		expect(await mcpServer("docs")).toBeDefined();

		const removed = await runTool(tool, { name: "docs", action: "remove", confirmedByUser: true });
		expect(removed.ok).toBe(true);
		expect(await mcpServer("docs")).toBeUndefined();
	});

	it("refuses a bad mcp url through the service and returns {ok:false,error}", async () => {
		await writeFile(mcpPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
		const harness = createHarness();
		const { tool } = toolOf(harness.settings, "update_mcp_server");

		const result = await runTool(tool, { name: "bad", action: "upsert", url: "not a url" });
		expect(result.ok).toBe(false);
		expect(typeof result.error).toBe("string");
		expect(await mcpServer("bad")).toBeUndefined();
	});

	it("enables, describes and re-times a datasource, refuses non-installable rows, and turns a schedule failure into a warning", async () => {
		const harness = createHarness({
			rows: [row("slack", "installed"), row("kakao", "unsupported"), row("lark", "missing"), row("discord", "credential-missing")],
		});
		const { tool } = toolOf(harness.settings, "update_datasource");

		const enabled = await runTool(tool, { id: "slack", enabled: true });
		expect(enabled.ok).toBe(true);
		expect(harness.setEnabled).toHaveBeenCalledWith("slack", true);
		expect((await readJson(configPath)).datasources).toMatchObject({ slack: { enabled: true } });

		for (const id of ["kakao", "lark", "discord"]) {
			const refused = await runTool(tool, { id, enabled: true });
			expect(refused.ok).toBe(true);
			expect((refused.warnings as string[]).length).toBeGreaterThan(0);
		}
		expect(harness.setEnabled).toHaveBeenCalledTimes(1);

		await runTool(tool, { id: "slack", description: "Team chat" });
		expect((await readJson(configPath)).datasources).toMatchObject({ slack: { description: "Team chat" } });
		await runTool(tool, { id: "slack", description: "   " });
		expect(((await readJson(configPath)).datasources as Record<string, Record<string, unknown>>).slack!.description).toBeUndefined();

		await runTool(tool, { id: "slack", pollingIntervalMs: 900_000 });
		expect((await readJson(configPath)).datasources).toMatchObject({ slack: { pollingIntervalMs: 900_000 } });
		expect(harness.reconcile).toHaveBeenCalled();

		const badInterval = await runTool(tool, { id: "slack", pollingIntervalMs: 1234 });
		expect((badInterval.warnings as string[]).length).toBeGreaterThan(0);
		expect(((await readJson(configPath)).datasources as Record<string, Record<string, unknown>>).slack!.pollingIntervalMs).toBe(900_000);

		const failing = createHarness({ scheduleFails: true });
		const { tool: failingTool } = toolOf(failing.settings, "update_datasource");
		const warned = await runTool(failingTool, { id: "slack", pollingIntervalMs: 900_000 });
		expect(warned.ok).toBe(true);
		expect((warned.warnings as string[]).join(" ")).toMatch(/launchd is unavailable/);
	});

	it("refuses an unknown datasource id and names the valid ids", async () => {
		const harness = createHarness({ rows: [row("slack", "installed"), row("kakao", "unsupported")] });
		const { tool } = toolOf(harness.settings, "update_datasource");

		const refused = await runTool(tool, { id: "nope", enabled: true });
		expect(refused.ok).toBe(false);
		expect(String(refused.error)).toContain("slack");
		expect(String(refused.error)).toContain("kakao");
		expect(harness.setEnabled).not.toHaveBeenCalled();
	});

	it("runs the profile on a scripted faux model, accepts the i intent field, and applies the change", async () => {
		await writeFile(mcpPath, `${JSON.stringify({ mcpServers: { docs: { url: "https://example.com/mcp" } } }, null, 2)}\n`);
		const registration = register();
		const harness = createHarness();
		const kit = createConnectionsCustomizerToolkit({ settings: harness.settings, language: () => "ko" });
		const profile = connectionsCustomizerProfile({ language: "ko", surface: "mcp", toolkit: kit });
		const session = await createProfileSession({
			profile,
			cwd: root,
			agentDir,
			env: {},
			model: { model: registration.getModel() },
		});
		cleanups.push(() => session.dispose());

		const progress: string[] = [];
		subscribeProfileProgress(session, (text) => progress.push(text));

		registration.setResponses([
			fauxAssistantMessage([fauxToolCall("update_mcp_server", { i: "MCP 서버를 비활성화하는 중", name: "docs", action: "disable" })]),
			fauxAssistantMessage("docs 서버를 비활성화했습니다."),
		]);

		await session.prompt("docs 서버 꺼줘");

		expect(progress).toContain("MCP 서버를 비활성화하는 중");
		expect((await mcpServer("docs")).enabled).toBe(false);

		const changes = kit.takeChanges();
		expect(changes).toHaveLength(1);
		expect(changes[0]?.kind).toBe("connections");
		expect(changes[0]?.fields.length).toBeGreaterThan(0);
		expect(changes[0]?.summary.length).toBeGreaterThan(0);
	});
});
