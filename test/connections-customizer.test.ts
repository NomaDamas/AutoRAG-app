import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { createProfileSession } from "@autorag/librarian/profiles";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createConnectionsCustomizerToolkit, connectionsCustomizerProfile } from "../src/main/agents/profiles/connections-customizer";
import type { RunPrompter } from "../src/main/agents/customizer-prompter";
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
	readonly credentialsSet: Mock;
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
	const credentialsSet = vi.fn(async () => []);
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
		credentials: { list: vi.fn(async () => []), set: credentialsSet, remove: vi.fn() } as never,
		mcp,
		refreshScheduler: { status: vi.fn(), reconcile, remove: vi.fn() } as never,
	} satisfies Parameters<typeof createSettingsService>[0] as never);
	return { settings, rows, setEnabled, setDescription, reconcile, credentialsSet };
}

interface FakePrompter extends RunPrompter {
	readonly order: string[];
	readonly secretCalls: Array<{ readonly title: string; readonly detail: string; readonly hint?: string }>;
	readonly confirmCalls: Array<{ readonly title: string; readonly lines: readonly string[] }>;
}

/** A scripted RunPrompter: `confirms`/`secrets` are consumed in order; `undefined` answers as cancelled. */
function fakePrompter(options: { readonly confirms?: readonly (boolean | undefined)[]; readonly secrets?: readonly (string | undefined)[] } = {}): FakePrompter {
	const confirms = [...(options.confirms ?? [])];
	const secrets = [...(options.secrets ?? [])];
	const order: string[] = [];
	const secretCalls: FakePrompter["secretCalls"] = [];
	const confirmCalls: FakePrompter["confirmCalls"] = [];
	return {
		order,
		secretCalls,
		confirmCalls,
		async askSecret(input) {
			order.push("secret");
			secretCalls.push(input as { readonly title: string; readonly detail: string; readonly hint?: string });
			const next = secrets.shift();
			return next === undefined ? { kind: "cancelled" } : { kind: "secret", value: next };
		},
		async askConfirm(input) {
			order.push("confirm");
			confirmCalls.push(input);
			const next = confirms.shift();
			return next === undefined ? { kind: "cancelled" } : { kind: "confirm", confirmed: next };
		},
	};
}

interface ToolkitOptions {
	readonly language?: "ko" | "en";
	readonly prompter?: RunPrompter;
	readonly known?: Set<string>;
	readonly fetch?: typeof globalThis.fetch;
}

function toolkitOf(settings: SettingsBridge, options: ToolkitOptions = {}) {
	const known = options.known ?? new Set<string>();
	const secrets = options.prompter === undefined ? undefined : { prompter: () => options.prompter, known };
	const kit = createConnectionsCustomizerToolkit({
		settings,
		language: () => options.language ?? "ko",
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
		...(secrets === undefined ? {} : { secrets }),
	});
	return { kit, known };
}

function toolOf(settings: SettingsBridge, name: string, options: ToolkitOptions = {}) {
	const { kit, known } = toolkitOf(settings, options);
	const tool = kit.tools.find((entry) => entry.name === name);
	if (tool === undefined) throw new Error(`missing tool ${name}`);
	return { kit, known, tool };
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

/** The registry shape the live endpoint returns (see the route): `servers[].server` with remotes and packages. */
const REGISTRY_BODY = {
	servers: [
		{
			server: {
				name: "io.github.acme/notes-server",
				description: "Notes over MCP",
				version: "0.1.5",
				repository: { url: "https://github.com/acme/notes-server", source: "github" },
				packages: [
					{
						registryType: "npm",
						identifier: "notes-mcp-server",
						version: "0.1.5",
						runtimeHint: "npx",
						transport: { type: "stdio" },
						environmentVariables: [
							{ name: "NOTES_ROOT", isRequired: true, description: "Folder to index" },
							{ name: "NOTES_API_KEY", isSecret: true, description: "API key" },
						],
					},
				],
			},
		},
		{
			server: {
				name: "ai.smithery/remote-notes",
				description: "Hosted notes server",
				version: "2.0.0",
				remotes: [
					{
						type: "streamable-http",
						url: "https://server.smithery.ai/@remote-notes/mcp",
						headers: [{ name: "Authorization", isRequired: true, isSecret: true, description: "Bearer token", value: "Bearer {smithery_api_key}" }],
					},
				],
			},
		},
		{
			server: {
				name: "io.github.acme/py-notes",
				description: "Notes in Python",
				version: "0.2.0",
				packages: [{ registryType: "pypi", identifier: "py-notes-mcp", version: "0.2.0", transport: { type: "stdio" }, environmentVariables: [] }],
			},
		},
	],
};

function registryFetch(): typeof globalThis.fetch {
	return (async () => ({ ok: true, status: 200, json: async () => REGISTRY_BODY })) as unknown as typeof globalThis.fetch;
}

describe("connections-customizer pi agent profile & toolkit", () => {
	it("exposes the five tools and states the narrowed scope invariants", () => {
		const harness = createHarness();
		const kit = createConnectionsCustomizerToolkit({ settings: harness.settings });
		const profile = connectionsCustomizerProfile({ language: "ko", surface: "mcp", toolkit: kit });

		expect(profile.id).toBe("connections-customizer");
		expect(profile.tools).toEqual([]);
		expect(profile.customTools?.map((tool) => tool.name).sort()).toEqual([
			"get_connections",
			"install_mcp_server",
			"search_mcp_registry",
			"update_datasource",
			"update_mcp_server",
		]);
		expect(profile.systemPrompt).toMatch(/language the person writes in/iu);
		expect(profile.systemPrompt).toContain("if it is unclear, reply in Korean");
		expect(profile.systemPrompt).not.toMatch(/[\uac00-\ud7af\u3040-\u30ff\u4e00-\u9fff]/u);
		// The narrower invariants: masked field only, confirm before running, untrusted registry/web text is data.
		expect(profile.systemPrompt).toContain("confirmedByUser");
		expect(profile.systemPrompt).toContain("secretEnv");
		expect(profile.systemPrompt).toContain("masked field");
		expect(profile.systemPrompt).toContain("search_mcp_registry");
		expect(profile.systemPrompt).toContain("install_mcp_server");
		expect(profile.systemPrompt).toContain("web_search");
		expect(profile.systemPrompt).toContain("untrusted");
		expect(profile.systemPrompt).not.toContain("No secrets, ever");
		expect(profile.systemPrompt).toContain("CANNOT add, connect, or remove a datasource");
		expect(profile.systemPrompt).toContain("sync");

		const appsProfile = connectionsCustomizerProfile({ language: "en", surface: "apps", toolkit: kit });
		expect(appsProfile.id).toBe("connections-customizer");
		expect(appsProfile.systemPrompt).toContain("if it is unclear, reply in English");
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
		const { tool } = toolOf(harness.settings, "update_mcp_server", { prompter: fakePrompter({ confirms: [true] }) });

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
		const { tool } = toolOf(harness.settings, "update_mcp_server", { prompter: fakePrompter({ confirms: [true] }) });

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

	it("searches the registry and installs an npm package with a masked secret, never leaking the value", async () => {
		await writeFile(mcpPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
		const harness = createHarness();
		const prompter = fakePrompter({ confirms: [true], secrets: ["sk-notes-secret-1234567890"] });
		const { tool, kit, known } = toolOf(harness.settings, "install_mcp_server", { prompter, fetch: registryFetch() });

		const search = await runTool(toolOf(harness.settings, "search_mcp_registry", { fetch: registryFetch() }).tool, { query: "notes" });
		expect(search.ok).toBe(true);
		const listed = (search.data as Array<Record<string, unknown>>).find((entry) => entry.id === "io.github.acme/notes-server")!;
		expect(listed).toMatchObject({ installable: true, version: "0.1.5" });
		expect((listed.install as Array<Record<string, unknown>>)[0]).toMatchObject({ kind: "npm", secrets: ["NOTES_API_KEY"], needs: ["NOTES_ROOT"] });

		const result = await runTool(tool, { id: "io.github.acme/notes-server", installIndex: 0, values: { NOTES_ROOT: "/tmp/notes" } });
		expect(result.ok).toBe(true);
		expect(result.name).toBe("notes-server");
		expect(result.transport).toBe("stdio");
		expect(result.secretsStored).toEqual(["DAZZI_MCP_NOTES_SERVER_NOTES_API_KEY"]);

		expect(await mcpServer("notes-server")).toEqual({
			command: "npx",
			args: ["-y", "notes-mcp-server@0.1.5"],
			description: "Notes over MCP",
			env: { NOTES_ROOT: "/tmp/notes", NOTES_API_KEY: "${DAZZI_MCP_NOTES_SERVER_NOTES_API_KEY}" },
		});
		expect(harness.credentialsSet).toHaveBeenCalledWith("DAZZI_MCP_NOTES_SERVER_NOTES_API_KEY", "sk-notes-secret-1234567890");
		expect(known.has("sk-notes-secret-1234567890")).toBe(true);

		// The value reaches neither the file, the model-visible result, nor the recorded change.
		expect(await readFile(mcpPath, "utf8")).not.toContain("sk-notes-secret");
		expect(JSON.stringify(result)).not.toContain("sk-notes-secret");
		expect(JSON.stringify(kit.takeChanges())).not.toContain("sk-notes-secret");
		// Secrets are collected only after the confirm.
		expect(prompter.order).toEqual(["confirm", "secret"]);
		expect(kit.peekChanges()).toHaveLength(0);
	});

	it("installs a remote with a bearer header using the registry's value template", async () => {
		await writeFile(mcpPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
		const harness = createHarness();
		const prompter = fakePrompter({ confirms: [true], secrets: ["tok-abcdefghijklmnop"] });
		const { tool } = toolOf(harness.settings, "install_mcp_server", { prompter, fetch: registryFetch() });

		const result = await runTool(tool, { id: "ai.smithery/remote-notes" });
		expect(result.ok).toBe(true);
		expect(result.transport).toBe("http");
		expect(await mcpServer("remote-notes")).toEqual({
			url: "https://server.smithery.ai/@remote-notes/mcp",
			description: "Hosted notes server",
			headers: { Authorization: "Bearer ${DAZZI_MCP_REMOTE_NOTES_AUTHORIZATION}" },
		});
		expect(harness.credentialsSet).toHaveBeenCalledWith("DAZZI_MCP_REMOTE_NOTES_AUTHORIZATION", "tok-abcdefghijklmnop");
		expect(await readFile(mcpPath, "utf8")).not.toContain("tok-abcdefghijklmnop");
	});

	it("installs a pypi package with uvx and no secrets", async () => {
		await writeFile(mcpPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
		const harness = createHarness();
		const prompter = fakePrompter({ confirms: [true] });
		const { tool } = toolOf(harness.settings, "install_mcp_server", { prompter, fetch: registryFetch() });

		const result = await runTool(tool, { id: "io.github.acme/py-notes" });
		expect(result.ok).toBe(true);
		expect(result.secretsStored).toEqual([]);
		expect(await mcpServer("py-notes")).toEqual({ command: "uvx", args: ["py-notes-mcp==0.2.0"], description: "Notes in Python" });
		expect(harness.credentialsSet).not.toHaveBeenCalled();
	});

	it("writes and stores nothing when the install confirmation is declined", async () => {
		await writeFile(mcpPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
		const harness = createHarness();
		const prompter = fakePrompter({ confirms: [false], secrets: ["sk-should-not-be-stored"] });
		const { tool, kit } = toolOf(harness.settings, "install_mcp_server", { prompter, fetch: registryFetch() });

		const result = await runTool(tool, { id: "io.github.acme/notes-server", values: { NOTES_ROOT: "/tmp/notes" } });
		expect(result.ok).toBe(false);
		expect(await mcpServer("notes-server")).toBeUndefined();
		expect(harness.credentialsSet).not.toHaveBeenCalled();
		expect(prompter.order).toEqual(["confirm"]);
		expect(kit.peekChanges()).toHaveLength(0);
	});

	it("writes and stores nothing when the secret prompt is cancelled", async () => {
		await writeFile(mcpPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
		const harness = createHarness();
		const prompter = fakePrompter({ confirms: [true], secrets: [undefined] });
		const { tool } = toolOf(harness.settings, "install_mcp_server", { prompter, fetch: registryFetch() });

		const result = await runTool(tool, { id: "io.github.acme/notes-server", values: { NOTES_ROOT: "/tmp/notes" } });
		expect(result.ok).toBe(false);
		expect(await mcpServer("notes-server")).toBeUndefined();
		expect(harness.credentialsSet).not.toHaveBeenCalled();
		expect(prompter.order).toEqual(["confirm", "secret"]);
	});

	it("returns needs and does not prompt when a required non-secret value is missing", async () => {
		await writeFile(mcpPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
		const harness = createHarness();
		const prompter = fakePrompter({ confirms: [true] });
		const { tool } = toolOf(harness.settings, "install_mcp_server", { prompter, fetch: registryFetch() });

		const result = await runTool(tool, { id: "io.github.acme/notes-server" });
		expect(result.ok).toBe(false);
		expect(result.needs).toEqual(["NOTES_ROOT"]);
		expect(prompter.order).toEqual([]);
		expect(await mcpServer("notes-server")).toBeUndefined();
		expect(harness.credentialsSet).not.toHaveBeenCalled();
	});

	it("refuses a name clash unless an explicit name is given", async () => {
		await writeFile(mcpPath, `${JSON.stringify({ mcpServers: { "notes-server": { url: "https://keep.example.com/mcp" } } }, null, 2)}\n`);
		const harness = createHarness();
		const prompter = fakePrompter({ confirms: [true], secrets: ["sk-alt-secret-1234567890"] });
		const { tool } = toolOf(harness.settings, "install_mcp_server", { prompter, fetch: registryFetch() });

		const clash = await runTool(tool, { id: "io.github.acme/notes-server", values: { NOTES_ROOT: "/tmp/notes" } });
		expect(clash.ok).toBe(false);
		expect(String(clash.error)).toMatch(/already exists/);
		expect(await mcpServer("notes-server")).toEqual({ url: "https://keep.example.com/mcp" });
		expect(harness.credentialsSet).not.toHaveBeenCalled();

		const named = await runTool(tool, { id: "io.github.acme/notes-server", name: "notes-alt", values: { NOTES_ROOT: "/tmp/notes" } });
		expect(named.ok).toBe(true);
		expect((await mcpServer("notes-alt")).env).toEqual({ NOTES_ROOT: "/tmp/notes", NOTES_API_KEY: "${DAZZI_MCP_NOTES_ALT_NOTES_API_KEY}" });
	});

	it("refuses an install with no panel and refuses an unknown registry id", async () => {
		await writeFile(mcpPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
		const harness = createHarness();
		const { tool } = toolOf(harness.settings, "install_mcp_server", { fetch: registryFetch() });
		const noPanel = await runTool(tool, { id: "io.github.acme/notes-server", values: { NOTES_ROOT: "/tmp/notes" } });
		expect(noPanel.ok).toBe(false);
		expect(String(noPanel.error)).toMatch(/panel/);

		const { tool: withPrompter } = toolOf(harness.settings, "install_mcp_server", { prompter: fakePrompter({ confirms: [true] }), fetch: registryFetch() });
		const unknown = await runTool(withPrompter, { id: "no/such-server" });
		expect(unknown.ok).toBe(false);
		expect(String(unknown.error)).toContain("no/such-server");
	});

	it("refuses a command upsert without a prompter and accepts it after the confirmation", async () => {
		await writeFile(mcpPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
		const harness = createHarness();

		const without = toolOf(harness.settings, "update_mcp_server").tool;
		const refused = await runTool(without, { name: "local", action: "upsert", command: "npx", args: ["-y", "srv"] });
		expect(refused.ok).toBe(false);
		expect(String(refused.error)).toMatch(/panel/);
		expect(await mcpServer("local")).toBeUndefined();

		const prompter = fakePrompter({ confirms: [true] });
		const withPanel = toolOf(harness.settings, "update_mcp_server", { prompter }).tool;
		const accepted = await runTool(withPanel, { name: "local", action: "upsert", command: "npx", args: ["-y", "srv"] });
		expect(accepted.ok).toBe(true);
		expect(await mcpServer("local")).toEqual({ command: "npx", args: ["-y", "srv"] });
		expect(prompter.confirmCalls[0]?.lines[0]).toContain("npx -y srv");

		const declined = fakePrompter({ confirms: [false] });
		const declinedTool = toolOf(harness.settings, "update_mcp_server", { prompter: declined }).tool;
		const cancelled = await runTool(declinedTool, { name: "local2", action: "upsert", command: "uvx", args: ["srv2"] });
		expect(cancelled.ok).toBe(false);
		expect(await mcpServer("local2")).toBeUndefined();

		// A `url` remote needs no confirmation at all.
		const urlUpsert = await runTool(withPanel, { name: "remote", action: "upsert", url: "https://remote.example.com/mcp" });
		expect(urlUpsert.ok).toBe(true);
		expect(prompter.confirmCalls).toHaveLength(1);
	});

	it("refuses a plaintext secret in env or headers and points at the masked-field params", async () => {
		await writeFile(mcpPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
		const harness = createHarness();
		const { tool } = toolOf(harness.settings, "update_mcp_server", { prompter: fakePrompter({ confirms: [true] }) });

		const envRefused = await runTool(tool, { name: "local", action: "upsert", command: "npx", args: ["-y", "srv"], env: { API_TOKEN: "plain-value-here" } });
		expect(envRefused.ok).toBe(false);
		expect(String(envRefused.error)).toMatch(/secretEnv/);
		expect(await mcpServer("local")).toBeUndefined();

		const headerRefused = await runTool(tool, { name: "remote", action: "upsert", url: "https://x.example.com/mcp", headers: { Authorization: "Bearer abcdefghijklmnopqrstuvwxyz" } });
		expect(headerRefused.ok).toBe(false);
		expect(String(headerRefused.error)).toMatch(/secretHeaders/);
		expect(await mcpServer("remote")).toBeUndefined();
	});

	it("collects a secretEnv through the masked field and references it as ${REF}", async () => {
		await writeFile(mcpPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
		const harness = createHarness();
		const prompter = fakePrompter({ confirms: [true], secrets: ["sk-local-secret-1234567890"] });
		const { tool } = toolOf(harness.settings, "update_mcp_server", { prompter });

		const result = await runTool(tool, { name: "local2", action: "upsert", command: "npx", args: ["-y", "srv2"], secretEnv: ["API_KEY"] });
		expect(result.ok).toBe(true);
		expect(await mcpServer("local2")).toEqual({ command: "npx", args: ["-y", "srv2"], env: { API_KEY: "${DAZZI_MCP_LOCAL2_API_KEY}" } });
		expect(harness.credentialsSet).toHaveBeenCalledWith("DAZZI_MCP_LOCAL2_API_KEY", "sk-local-secret-1234567890");
		expect(await readFile(mcpPath, "utf8")).not.toContain("sk-local-secret");
		expect(JSON.stringify(result)).not.toContain("sk-local-secret");
	});

	it("collects a secretHeaders with a bearer template", async () => {
		await writeFile(mcpPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
		const harness = createHarness();
		const prompter = fakePrompter({ confirms: [true], secrets: ["tok-abcdefghijklmnop"] });
		const { tool } = toolOf(harness.settings, "update_mcp_server", { prompter });

		const result = await runTool(tool, { name: "remote2", action: "upsert", url: "https://x.example.com/mcp", secretHeaders: [{ name: "Authorization", template: "Bearer {value}" }] });
		expect(result.ok).toBe(true);
		expect(await mcpServer("remote2")).toEqual({ url: "https://x.example.com/mcp", headers: { Authorization: "Bearer ${DAZZI_MCP_REMOTE2_AUTHORIZATION}" } });
		expect(harness.credentialsSet).toHaveBeenCalledWith("DAZZI_MCP_REMOTE2_AUTHORIZATION", "tok-abcdefghijklmnop");

		// A template with no `{value}` placeholder still references the secret rather than dropping it.
		const noPlaceholder = fakePrompter({ confirms: [true], secrets: ["tok-abcdefghijklmnop"] });
		const { tool: plainTemplate } = toolOf(harness.settings, "update_mcp_server", { prompter: noPlaceholder });
		await runTool(plainTemplate, { name: "remote3", action: "upsert", url: "https://y.example.com/mcp", secretHeaders: [{ name: "Authorization", template: "Bearer" }] });
		expect((await mcpServer("remote3")).headers).toEqual({ Authorization: "${DAZZI_MCP_REMOTE3_AUTHORIZATION}" });
	});

	it("asks a confirmation card before removing when a prompter exists", async () => {
		await writeFile(mcpPath, `${JSON.stringify({ mcpServers: { docs: { url: "https://example.com/mcp" } } }, null, 2)}\n`);
		const harness = createHarness();
		const prompter = fakePrompter({ confirms: [false, true] });
		const { tool } = toolOf(harness.settings, "update_mcp_server", { prompter });

		const declined = await runTool(tool, { name: "docs", action: "remove", confirmedByUser: true });
		expect(declined.ok).toBe(false);
		expect(await mcpServer("docs")).toBeDefined();

		const removed = await runTool(tool, { name: "docs", action: "remove", confirmedByUser: true });
		expect(removed.ok).toBe(true);
		expect(await mcpServer("docs")).toBeUndefined();
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

	it("installs through a scripted faux model end to end, storing the secret and referencing it", async () => {
		await writeFile(mcpPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
		const registration = register();
		const harness = createHarness();
		const prompter = fakePrompter({ confirms: [true], secrets: ["sk-faux-secret-1234567890"] });
		const kit = createConnectionsCustomizerToolkit({
			settings: harness.settings,
			language: () => "ko",
			fetch: registryFetch(),
			secrets: { prompter: () => prompter, known: new Set() },
		});
		const profile = connectionsCustomizerProfile({ language: "ko", surface: "mcp", toolkit: kit });
		const session = await createProfileSession({ profile, cwd: root, agentDir, env: {}, model: { model: registration.getModel() } });
		cleanups.push(() => session.dispose());

		registration.setResponses([
			fauxAssistantMessage([fauxToolCall("install_mcp_server", { i: "MCP 서버를 설치하는 중", id: "io.github.acme/notes-server", installIndex: 0, values: { NOTES_ROOT: "/tmp/notes" } })]),
			fauxAssistantMessage("notes 서버를 설치했습니다."),
		]);

		await session.prompt("notes 서버 설치해줘");

		expect((await mcpServer("notes-server")).env).toEqual({ NOTES_ROOT: "/tmp/notes", NOTES_API_KEY: "${DAZZI_MCP_NOTES_SERVER_NOTES_API_KEY}" });
		expect(harness.credentialsSet).toHaveBeenCalledWith("DAZZI_MCP_NOTES_SERVER_NOTES_API_KEY", "sk-faux-secret-1234567890");
		expect(await readFile(mcpPath, "utf8")).not.toContain("sk-faux-secret");
		expect(kit.takeChanges()).toHaveLength(1);
	});
});
