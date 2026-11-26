import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { createProfileSession } from "@autorag/librarian/profiles";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAiCustomizerToolkit } from "../src/main/agents/profiles/ai-customizer";
import { settingsCustomizerProfile } from "../src/main/agents/profiles/settings-customizer";
import type { ConfirmPromptInput, RunPrompter, SecretPromptInput } from "../src/main/agents/customizer-prompter";
import { subscribeProfileProgress } from "../src/main/agents/profile-progress";
import { createAutoRagConfigService } from "../src/main/autorag-config-service";
import { createSettingsService } from "../src/main/settings-service";
import { AUTORAG_PROVIDER_ID } from "../src/shared/account-contract";
import { jevModelsFor, rerankModelsFor } from "../src/shared/ai-roles";
import { decompositionConfigUpdates, jevConfigUpdates, jevSllmConfigUpdates, modelConfigUpdates, rerankConfigUpdates } from "../src/shared/model-config";
import type { ProviderSummary } from "../src/shared/settings-contract";

const cleanups: Array<() => Promise<void> | void> = [];
let root: string;
let agentDir: string;
let configPath: string;
let env: NodeJS.ProcessEnv;
let initial: Record<string, unknown>;

const OPENROUTER_MODEL = {
	provider: "openrouter",
	id: "deepseek/deepseek-v4.1-flash",
	name: "DeepSeek v4.1 Flash",
	api: "openai-completions",
	available: true,
	baseUrl: null,
	apiKeyEnv: "OPENROUTER_API_KEY",
} as const;

const OPENROUTER: ProviderSummary = {
	id: "openrouter",
	name: "OpenRouter",
	baseUrl: null,
	kind: "runtime",
	authKinds: ["api_key"],
	subscription: false,
	authConfigured: true,
	authSource: "stored",
	apiKeyEnv: "OPENROUTER_API_KEY",
	models: [OPENROUTER_MODEL],
};

const DAZZI: ProviderSummary = {
	id: AUTORAG_PROVIDER_ID,
	name: "AutoRAG",
	baseUrl: null,
	kind: "runtime",
	authKinds: ["oauth"],
	subscription: true,
	authConfigured: true,
	authSource: "runtime",
	apiKeyEnv: null,
	models: [],
};

const ANTHROPIC: ProviderSummary = {
	id: "anthropic",
	name: "Anthropic",
	baseUrl: null,
	kind: "runtime",
	authKinds: ["api_key"],
	subscription: false,
	authConfigured: false,
	authSource: "none",
	apiKeyEnv: "ANTHROPIC_API_KEY",
	models: [],
};

const OPENAI: ProviderSummary = {
	id: "openai",
	name: "OpenAI",
	baseUrl: null,
	kind: "runtime",
	authKinds: ["api_key"],
	subscription: false,
	authConfigured: false,
	authSource: "none",
	apiKeyEnv: "OPENAI_API_KEY",
	models: [],
};

const GROQ: ProviderSummary = {
	id: "groq",
	name: "Groq",
	baseUrl: null,
	kind: "runtime",
	authKinds: ["api_key"],
	subscription: false,
	authConfigured: false,
	authSource: "none",
	apiKeyEnv: "GROQ_API_KEY",
	models: [],
};

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ai-customizer-root-"));
	agentDir = await mkdtemp(join(tmpdir(), "ai-customizer-agent-"));
	configPath = join(root, "config.json");
	env = { HOME: root, AUTORAG_CONFIG: configPath };
	initial = {
		searchPaths: [root],
		workspacePath: root,
		memoryPath: join(root, "memory.json"),
		parserOptions: { apiKey: "SUPER-SECRET-KEY" },
	};
	await writeFile(configPath, `${JSON.stringify(initial, null, 2)}\n`);
	cleanups.push(
		() => rm(root, { recursive: true, force: true }),
		() => rm(agentDir, { recursive: true, force: true }),
	);
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function makeSettings(providers: readonly ProviderSummary[], record: Array<{ envName: string; value: string }> = [], stored: readonly { envName: string; stored: boolean; source: "stored" | "env" | "none" }[] = []) {
	return createSettingsService({
		directory: join(root, "settings"),
		dataSources: { list: () => Promise.resolve({}), setEnabled: () => Promise.resolve({}), setDescription: () => Promise.resolve({}), sync: () => Promise.resolve({}) } as never,
		models: { resolve: () => Promise.resolve(null), catalog: () => Promise.resolve(null) } as never,
		config: createAutoRagConfigService({ env, cwd: root }),
		refreshConfig: (() => Promise.resolve({})) as never,
		credentials: {
			list: () => Promise.resolve(stored),
			set: (envName: string, secret: string) => {
				record.push({ envName, value: secret });
				return Promise.resolve([]);
			},
			remove: () => Promise.resolve([]),
		} as never,
		providers: { list: () => Promise.resolve(providers) } as never,
	});
}

interface ToolkitOptions {
	readonly providers?: readonly ProviderSummary[];
	/** What the credential store already holds: Dazzi's own saved keys, which the scan must not offer back. */
	readonly stored?: readonly { envName: string; stored: boolean; source: "stored" | "env" | "none" }[];
	readonly prompter?: RunPrompter;
	readonly shell?: { homeDir: string; cwd: string; env: NodeJS.ProcessEnv };
	/** Pass `false` for a window that cannot show a prompt (secret tools must then refuse). */
	readonly secrets?: boolean;
}

function toolkitFor(options: ToolkitOptions = {}) {
	const providers = options.providers ?? [OPENROUTER, DAZZI, ANTHROPIC];
	const record: Array<{ envName: string; value: string }> = [];
	const settings = makeSettings(providers, record, options.stored);
	const known = new Set<string>();
	const secrets = options.secrets === false ? undefined : { known, prompter: () => options.prompter };
	const kit = createAiCustomizerToolkit({
		settings,
		language: () => "ko",
		...(secrets === undefined ? {} : { secrets }),
		...(options.shell === undefined ? {} : { shell: options.shell }),
	});
	const tools = new Map(kit.tools.map((tool) => [tool.name, tool]));
	return { settings, kit, tools, record, known };
}

function fakePrompter(answers: { secret?: string; confirm?: boolean }): { prompter: RunPrompter; calls: { secrets: SecretPromptInput[]; confirms: ConfirmPromptInput[] } } {
	const calls = { secrets: [] as SecretPromptInput[], confirms: [] as ConfirmPromptInput[] };
	return {
		calls,
		prompter: {
			askSecret: async (input) => {
				calls.secrets.push(input);
				return answers.secret === undefined ? { kind: "cancelled" } : { kind: "secret", value: answers.secret };
			},
			askConfirm: async (input) => {
				calls.confirms.push(input);
				return answers.confirm === true ? { kind: "confirm", confirmed: true } : { kind: "cancelled" };
			},
		},
	};
}

const readConfig = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;

type ToolLike = { execute: (id: string, params: Record<string, unknown>, ...rest: unknown[]) => Promise<{ content: { type: string; text: string }[] }> };

/** The declared property names of a tool's JSON schema, or an empty list when it declares none. */
function schemaProperties(schema: unknown): Record<string, unknown> {
	if (schema === null || typeof schema !== "object" || !("properties" in schema)) return {};
	const props = schema.properties;
	return props !== null && typeof props === "object" ? (props as Record<string, unknown>) : {};
}

interface ScannedAgent {
	readonly id: string;
	readonly credentials: ReadonlyArray<Record<string, unknown>>;
}
interface ScanResult {
	readonly ok: boolean;
	readonly agents: readonly ScannedAgent[];
}

async function run(tool: ToolLike, params: Record<string, unknown>): Promise<{ ok: boolean; error?: string; choices?: string[]; warnings?: string[] } & Record<string, unknown>> {
	const res = await tool.execute("call", params, undefined, undefined, undefined as never);
	return JSON.parse(res.content.map((block) => (block.type === "text" ? block.text : "")).join("")) as never;
}

/** Test-only replica of the config service's set/remove for the leaf shapes these tools write. */
function applyUpdates(base: Record<string, unknown>, updates: readonly { path: readonly string[]; value?: unknown; remove?: true }[]): Record<string, unknown> {
	const clone = structuredClone(base);
	for (const update of updates) {
		const parent = update.path.slice(0, -1).reduce<Record<string, unknown>>((current, segment) => {
			const next = current[segment];
			if (next === null || typeof next !== "object" || Array.isArray(next)) {
				const created: Record<string, unknown> = {};
				current[segment] = created;
				return created;
			}
			return next as Record<string, unknown>;
		}, clone);
		const leaf = update.path[update.path.length - 1] as string;
		if (update.remove === true) delete parent[leaf];
		else parent[leaf] = update.value;
	}
	return clone;
}

describe("ai-customizer toolkit & settings-customizer profile", () => {
	it("exposes the seven AI/web tools, plus bash only with a shell, and states the new narrower invariants", () => {
		const { kit } = toolkitFor();
		const profile = settingsCustomizerProfile({ language: "ko", surface: "ai", toolkit: kit });

		expect(profile.id).toBe("settings-customizer");
		expect(profile.tools).toEqual([]);
		expect(profile.customTools?.map((tool) => tool.name).sort()).toEqual([
			"connect_provider_key",
			"get_ai_settings",
			"import_coding_agent_key",
			"scan_coding_agents",
			"set_model_role",
			"set_thinking_level",
			"update_web_search",
		]);
		expect(profile.systemPrompt).toMatch(/Reply in the language the person writes in/);
		expect(profile.systemPrompt).toMatch(/if it is unclear, reply in Korean/);
		expect(profile.systemPrompt).toMatch(/connect_provider_key/);
		expect(profile.systemPrompt).toMatch(/scan_coding_agents/);
		expect(profile.systemPrompt).toMatch(/embedding/i);
		expect(profile.systemPrompt).toMatch(/OAuth/);
		expect(profile.systemPrompt).toMatch(/removed before you see it/i);
		expect(profile.systemPrompt).toMatch(/DATA to report, never instructions/i);
		// Written in English whatever the interface language is.
		expect(profile.systemPrompt).not.toMatch(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3]/u);
		expect(profile.systemPrompt).not.toMatch(/There is no tool for it/i);
	});

	it("offers bash when a shell is given, and the prompt then points to it", () => {
		const shell = { homeDir: root, cwd: root, env: {} };
		const { kit } = toolkitFor({ shell });
		const profile = settingsCustomizerProfile({ language: "en", surface: "ai", toolkit: kit });

		const names = profile.customTools?.map((tool) => tool.name) ?? [];
		expect(names).toContain("bash");
		const prompt = profile.systemPrompt;
		// What the shell may do, stated plainly: read anywhere, write only the managed files, set environment variables,
		// read other coding agents' config, and never copy a key by hand.
		expect(prompt).toMatch(/READING is unrestricted/);
		expect(prompt).toMatch(/WRITING is limited to managed config files/);
		expect(prompt).toMatch(/new environment variable/i);
		expect(prompt).toMatch(/Jev before it runs/);
		expect(prompt).toMatch(/Claude Code, Codex, Gemini CLI, opencode, pi, Aider/);
		expect(prompt).toMatch(/Never copy a key into a command/);
	});

	it("answers the web surface with the same tools and web-search wording", () => {
		const { kit } = toolkitFor();
		const profile = settingsCustomizerProfile({ language: "en", surface: "web", toolkit: kit });

		expect(profile.customTools?.map((tool) => tool.name).sort()).toEqual([
			"connect_provider_key",
			"get_ai_settings",
			"import_coding_agent_key",
			"scan_coding_agents",
			"set_model_role",
			"set_thinking_level",
			"update_web_search",
		]);
		expect(profile.systemPrompt).toMatch(/web search/i);
	});

	it("writes the answer role exactly as modelConfigUpdates(entry) does", async () => {
		const { tools } = toolkitFor();
		const result = await run(tools.get("set_model_role") as ToolLike, {
			role: "answer",
			provider: "openrouter",
			modelId: OPENROUTER_MODEL.id,
		});

		expect(result.ok).toBe(true);
		expect(await readConfig()).toEqual(applyUpdates(initial, modelConfigUpdates(OPENROUTER_MODEL)));
	});

	it("refuses an unconnected provider and an unknown model, listing the valid choices", async () => {
		const { tools } = toolkitFor();
		const setRole = tools.get("set_model_role") as ToolLike;

		const unconnected = await run(setRole, { role: "answer", provider: "anthropic", modelId: "claude-sonnet" });
		expect(unconnected.ok).toBe(false);
		expect(unconnected.error).toMatch(/anthropic/);
		expect(unconnected.choices).toContain("openrouter:deepseek/deepseek-v4.1-flash");
		expect((await readConfig()).model).toBeUndefined();

		const unknownModel = await run(setRole, { role: "answer", provider: "openrouter", modelId: "nope/unknown" });
		expect(unknownModel.ok).toBe(false);
		expect(unknownModel.choices).toContain("openrouter:deepseek/deepseek-v4.1-flash");
		expect((await readConfig()).model).toBeUndefined();
	});

	it("reports current roles, thinking level and web-search state without any secret", async () => {
		await writeFile(
			configPath,
			`${JSON.stringify(
				{
					...initial,
					model: { provider: "openrouter", id: OPENROUTER_MODEL.id },
					thinking: { final: "medium" },
					webSearch: { enabled: false, provider: "gemini", fetch: { enabled: false } },
				},
				null,
				2,
			)}\n`,
		);
		const { tools } = toolkitFor();
		const result = (await run(tools.get("get_ai_settings") as ToolLike, {})) as {
			ok: boolean;
			providers: { id: string; models: { id: string; name: string }[] }[];
			roles: { answer: { current: unknown }; rerank: { specials: string[] } };
			thinking: { current: string };
			webSearch: { enabled: boolean; provider: string; fetchEnabled: boolean };
		};

		expect(result.ok).toBe(true);
		expect(result.providers[0]?.models[0]).toEqual({ id: OPENROUTER_MODEL.id, name: OPENROUTER_MODEL.name });
		expect(result.roles.answer.current).toEqual({ kind: "model", provider: "openrouter", modelId: OPENROUTER_MODEL.id });
		expect(result.roles.rerank.specials).toEqual(["off"]);
		expect(result.thinking.current).toBe("medium");
		expect(result.webSearch).toMatchObject({ enabled: false, provider: "gemini", fetchEnabled: false });
	});

	it("applies the valid model and warns when a special does not fit the role", async () => {
		const { tools } = toolkitFor();
		const setRole = tools.get("set_model_role") as ToolLike;

		const refused = await run(setRole, { role: "answer", special: "sllm" });
		expect(refused.ok).toBe(false);
		expect(refused.error).toMatch(/sllm/);

		const applied = await run(setRole, { role: "answer", special: "off", provider: "openrouter", modelId: OPENROUTER_MODEL.id });
		expect(applied.ok).toBe(true);
		expect(applied.warnings?.[0]).toMatch(/off/);
		expect((await readConfig()).model).toMatchObject({ provider: "openrouter", id: OPENROUTER_MODEL.id });
	});

	it("sets decomposition specials (same -> false, default -> removed) and jev sllm", async () => {
		const { tools } = toolkitFor();
		const setRole = tools.get("set_model_role") as ToolLike;

		await run(setRole, { role: "decomposition", special: "same" });
		expect((await readConfig()).queryDecomposition).toBe(false);

		const model = await run(setRole, { role: "decomposition", provider: "openrouter", modelId: OPENROUTER_MODEL.id });
		expect(model.ok).toBe(true);
		expect(await readConfig()).toEqual(applyUpdates({ ...initial, queryDecomposition: false }, decompositionConfigUpdates(OPENROUTER_MODEL)));

		await run(setRole, { role: "decomposition", special: "default" });
		expect((await readConfig()).queryDecomposition).toBeUndefined();

		await run(setRole, { role: "jev", special: "sllm" });
		expect(await readConfig()).toEqual(applyUpdates(initial, jevSllmConfigUpdates()));
	});

	it("sets a valid jev model and refuses one the backend does not serve", async () => {
		const { tools } = toolkitFor();
		const setRole = tools.get("set_model_role") as ToolLike;
		const jevId = jevModelsFor("openrouter")[0]!.id;

		const ok = await run(setRole, { role: "jev", provider: "openrouter", modelId: jevId });
		expect(ok.ok).toBe(true);
		expect(await readConfig()).toEqual(applyUpdates(initial, jevConfigUpdates({ provider: "openrouter", id: jevId, name: jevId, api: "", available: true, baseUrl: null, apiKeyEnv: "OPENROUTER_API_KEY" })));

		const bad = await run(setRole, { role: "jev", provider: "openrouter", modelId: "gpt-4o" });
		expect(bad.ok).toBe(false);
		expect(bad.choices).toContain(`openrouter:${jevId}`);
	});

	it("turns rerank off and picks a valid reranker", async () => {
		const { tools } = toolkitFor();
		const setRole = tools.get("set_model_role") as ToolLike;

		await run(setRole, { role: "rerank", special: "off" });
		expect((await readConfig()).rerank).toBe(false);

		const rerankId = rerankModelsFor("openrouter")[0]!.id;
		const ok = await run(setRole, { role: "rerank", provider: "openrouter", modelId: rerankId });
		expect(ok.ok).toBe(true);
		expect(await readConfig()).toEqual(applyUpdates(initial, rerankConfigUpdates({ provider: "openrouter", id: rerankId, name: rerankId, api: "", available: true, baseUrl: null, apiKeyEnv: "OPENROUTER_API_KEY" })));
	});

	it("validates the thinking level against the page's closed list", async () => {
		const { tools } = toolkitFor();
		const setThinking = tools.get("set_thinking_level") as ToolLike;

		const ok = await run(setThinking, { level: "high" });
		expect(ok.ok).toBe(true);
		expect((await readConfig()).thinking).toEqual({ final: "high" });

		const bad = await run(setThinking, { level: "extreme" });
		expect(bad.ok).toBe(false);
		expect(bad.choices).toContain("high");
		expect((await readConfig()).thinking).toEqual({ final: "high" });
	});

	it("writes web search exactly like the page: false -> object on enable, provider/auto, fetch block", async () => {
		await writeFile(configPath, `${JSON.stringify({ ...initial, webSearch: false }, null, 2)}\n`);
		const { tools } = toolkitFor();
		const web = tools.get("update_web_search") as ToolLike;

		await run(web, { enabled: true });
		expect((await readConfig()).webSearch).toEqual({ enabled: true });

		await run(web, { provider: "duckduckgo" });
		expect((await readConfig()).webSearch).toEqual({ enabled: true, provider: "duckduckgo" });

		await run(web, { enabled: false });
		expect((await readConfig()).webSearch).toEqual({ enabled: false, provider: "duckduckgo" });

		await run(web, { fetchEnabled: false });
		expect((await readConfig()).webSearch).toEqual({ enabled: false, provider: "duckduckgo", fetch: { enabled: false } });

		await run(web, { fetchEnabled: true });
		expect((await readConfig()).webSearch).toEqual({ enabled: false, provider: "duckduckgo", fetch: { enabled: true } });

		await run(web, { provider: "auto" });
		expect((await readConfig()).webSearch).toEqual({ enabled: false, fetch: { enabled: true } });
	});

	it("applies enable + provider + fetch in a single all-or-nothing patch", async () => {
		await writeFile(configPath, `${JSON.stringify({ ...initial, webSearch: false }, null, 2)}\n`);
		const { tools } = toolkitFor();
		const web = tools.get("update_web_search") as ToolLike;

		const result = await run(web, { enabled: true, provider: "duckduckgo", fetchEnabled: false });
		expect(result.ok).toBe(true);
		expect((await readConfig()).webSearch).toEqual({ enabled: true, provider: "duckduckgo", fetch: { enabled: false } });
	});

	it("refuses an unknown web-search provider with the closed list", async () => {
		const { tools } = toolkitFor();
		const web = tools.get("update_web_search") as ToolLike;

		const bad = await run(web, { provider: "not-a-provider" });
		expect(bad.ok).toBe(false);
		expect(bad.choices).toContain("duckduckgo");
		expect((await readConfig()).webSearch).toBeUndefined();
	});

	it("never leaks a secret present in the config through any tool result", async () => {
		await mkdir(join(root, "settings"), { recursive: true });
		const { tools } = toolkitFor();

		const results = await Promise.all([
			run(tools.get("get_ai_settings") as ToolLike, {}),
			run(tools.get("set_model_role") as ToolLike, { role: "answer", provider: "openrouter", modelId: OPENROUTER_MODEL.id }),
			run(tools.get("set_thinking_level") as ToolLike, { level: "low" }),
			run(tools.get("update_web_search") as ToolLike, { enabled: false }),
		]);
		for (const result of results) {
			expect(JSON.stringify(result)).not.toContain("SUPER-SECRET-KEY");
		}
	});

	it("gives no new tool a value or key parameter", () => {
		const { tools } = toolkitFor({ shell: { homeDir: root, cwd: root, env: {} } });
		const propsOf = (name: string): string[] => {
			const tool = tools.get(name);
			if (tool === undefined) throw new Error(`missing tool ${name}`);
			return Object.keys(schemaProperties(tool.parameters)).sort();
		};
		expect(propsOf("connect_provider_key")).toEqual(["provider"]);
		expect(propsOf("scan_coding_agents")).toEqual([]);
		expect(propsOf("import_coding_agent_key")).toEqual(["provider", "source"]);
		expect(propsOf("bash")).toEqual(["command", "timeout"]);
	});

	it("connect_provider_key stores the typed key, adds it to known, records a change, and returns only a masked tail", async () => {
		const secret = "sk-ant-api03-TypedSecret0123456789abcd";
		const { tools, record, known, kit } = toolkitFor({ prompter: fakePrompter({ secret }).prompter });
		const result = await run(tools.get("connect_provider_key") as ToolLike, { provider: "anthropic" });

		expect(result.ok).toBe(true);
		expect(result).toMatchObject({ provider: "anthropic", envName: "ANTHROPIC_API_KEY", masked: "••••abcd" });
		expect(record).toEqual([{ envName: "ANTHROPIC_API_KEY", value: secret }]);
		expect([...known]).toContain(secret);
		expect(JSON.stringify(result)).not.toContain(secret);
		expect(kit.peekChanges()).toMatchObject([{ kind: "ai", fields: ["credentials.ANTHROPIC_API_KEY"] }]);
		expect(kit.peekChanges()[0]?.summary).toMatch(/Anthropic/);
	});

	it("connect_provider_key via the page's own key name and the env default", async () => {
		const { tools, record } = toolkitFor({ providers: [OPENROUTER], prompter: fakePrompter({ secret: "sk-or-v1-abcdefghijklmnopqrst" }).prompter });
		const result = await run(tools.get("connect_provider_key") as ToolLike, { provider: "openrouter" });
		expect(result.envName).toBe("OPENROUTER_API_KEY");
		expect(record[0]?.envName).toBe("OPENROUTER_API_KEY");
	});

	it("connect_provider_key: a cancelled prompt stores nothing and tells the model so", async () => {
		const { tools, record, known } = toolkitFor({ prompter: fakePrompter({}).prompter });
		const result = await run(tools.get("connect_provider_key") as ToolLike, { provider: "anthropic" });
		expect(result).toEqual({ ok: false, cancelled: true });
		expect(record).toEqual([]);
		expect(known.size).toBe(0);
	});

	it("connect_provider_key refuses OAuth-only providers and subscriptions, pointing at the page", async () => {
		const { tools, record } = toolkitFor({ prompter: fakePrompter({ secret: "whatever-123456789" }).prompter });
		const dazzai = await run(tools.get("connect_provider_key") as ToolLike, { provider: AUTORAG_PROVIDER_ID });
		expect(dazzai.ok).toBe(false);
		expect(String(dazzai.error)).toMatch(/subscription|sign-in|sign in|connect button/i);
		expect(record).toEqual([]);

		const unknown = await run(tools.get("connect_provider_key") as ToolLike, { provider: "nope" });
		expect(unknown.ok).toBe(false);
		expect(unknown.choices).toContain("anthropic");
	});

	it("connect_provider_key refuses when no masked field is attached to the window", async () => {
		const { tools, record } = toolkitFor({ secrets: false });
		const result = await run(tools.get("connect_provider_key") as ToolLike, { provider: "anthropic" });
		expect(result.ok).toBe(false);
		expect(String(result.error)).toMatch(/connect/i);
		expect(record).toEqual([]);
	});

	it("scan_coding_agents reports where keys live and never a value", async () => {
		const home = await mkdtemp(join(tmpdir(), "ai-customizer-home-"));
		cleanups.push(() => rm(home, { recursive: true, force: true }));
		await mkdir(join(home, ".codex"), { recursive: true });
		const CODEX_KEY = "sk-proj-CodexFixtureKey0123456789abc";
		await writeFile(join(home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: CODEX_KEY, tokens: { access: "x" } }));
		const shell = { homeDir: home, cwd: root, env: { GROQ_API_KEY: "gsk_GroqFixtureKey0123456789" } };
		const { tools } = toolkitFor({ providers: [OPENAI, GROQ], shell });

		const result = await run(tools.get("scan_coding_agents") as ToolLike, {});
		expect(result.ok).toBe(true);
		const text = JSON.stringify(result);
		expect(text).not.toContain(CODEX_KEY);
		expect(text).not.toContain("gsk_GroqFixtureKey");
		const scanned = result as unknown as ScanResult;
		const agents = scanned.agents;
		const codex = agents.find((agent) => agent.id === "codex")!;
		expect(codex.credentials).toEqual([
			{ provider: "openai", kind: "api_key", envName: "OPENAI_API_KEY", source: "codex-file", from: join(home, ".codex", "auth.json"), importable: true, connected: false },
			{ provider: "openai", kind: "oauth", source: "codex-oauth", from: join(home, ".codex", "auth.json"), importable: false, connected: false },
		]);
		const envAgent = agents.find((agent) => agent.id === "env")!;
		expect(envAgent.credentials[0]).toMatchObject({ provider: "groq", kind: "api_key", source: "env:GROQ_API_KEY", importable: true });
	});

	it("scan_coding_agents does not offer Dazzi's own saved keys back as 'found in the environment'", async () => {
		// Dazzi loads the keys it stored into the process environment; they are not another program's keys.
		const home = await mkdtemp(join(tmpdir(), "ai-customizer-own-"));
		cleanups.push(() => rm(home, { recursive: true, force: true }));
		const shell = { homeDir: home, cwd: root, env: { ANTHROPIC_API_KEY: "sk-ant-api03-OwnStoredKey0123456789abcdef", GROQ_API_KEY: "gsk_AmbientGroqKey0123456789" } };
		const { tools } = toolkitFor({ providers: [ANTHROPIC, GROQ], shell, stored: [{ envName: "ANTHROPIC_API_KEY", stored: true, source: "stored" }] });
		const result = (await run(tools.get("scan_coding_agents") as ToolLike, {})) as unknown as ScanResult;
		const envAgent = result.agents.find((agent) => agent.id === "env")!;
		expect(envAgent.credentials.map((credential) => credential.source)).toEqual(["env:GROQ_API_KEY"]);
		const imported = await run(tools.get("import_coding_agent_key") as ToolLike, { source: "env:ANTHROPIC_API_KEY", provider: "anthropic" });
		expect(imported.ok).toBe(false);
	});

	it("import_coding_agent_key needs the confirmation, stores the right value under the right env name, and refuses unknown/oauth sources", async () => {
		const home = await mkdtemp(join(tmpdir(), "ai-customizer-import-"));
		cleanups.push(() => rm(home, { recursive: true, force: true }));
		await mkdir(join(home, ".codex"), { recursive: true });
		const CODEX_KEY = "sk-proj-ImportFixtureKey0123456789";
		await writeFile(join(home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: CODEX_KEY, tokens: { access: "x" } }));
		const shell = { homeDir: home, cwd: root, env: {} };

		const declined = toolkitFor({ providers: [OPENAI], shell, prompter: fakePrompter({}).prompter });
		const refused = await run(declined.tools.get("import_coding_agent_key") as ToolLike, { source: "codex-file", provider: "openai" });
		expect(refused).toEqual({ ok: false, cancelled: true });
		expect(declined.record).toEqual([]);

		const { prompter, calls } = fakePrompter({ confirm: true });
		const accepted = toolkitFor({ providers: [OPENAI], shell, prompter });
		const result = await run(accepted.tools.get("import_coding_agent_key") as ToolLike, { source: "codex-file", provider: "openai" });
		expect(result).toMatchObject({ ok: true, provider: "openai", envName: "OPENAI_API_KEY", masked: "••••6789" });
		expect(result.from).toBe(join(home, ".codex", "auth.json"));
		expect(accepted.record).toEqual([{ envName: "OPENAI_API_KEY", value: CODEX_KEY }]);
		expect([...accepted.known]).toContain(CODEX_KEY);
		expect(JSON.stringify(result)).not.toContain(CODEX_KEY);
		expect(calls.confirms[0]?.lines).toContain(`From: ${join(home, ".codex", "auth.json")}`);
		expect(calls.confirms[0]?.lines?.join(" ")).toMatch(/not shown to the AI/i);

		const unknown = await run(accepted.tools.get("import_coding_agent_key") as ToolLike, { source: "nope-file", provider: "openai" });
		expect(unknown.ok).toBe(false);
		expect(unknown.sources).toEqual(["codex-file"]);

		const oauth = await run(accepted.tools.get("import_coding_agent_key") as ToolLike, { source: "codex-oauth", provider: "openai" });
		expect(oauth.ok).toBe(false);
		expect(accepted.record).toHaveLength(1);
	});

	it("throws instead of writing when the run was cancelled", async () => {
		const settings = makeSettings([OPENROUTER]);
		let cancelled = false;
		const kit = createAiCustomizerToolkit({ settings, language: () => "ko", cancelled: () => cancelled });
		const setThinking = kit.tools.find((tool) => tool.name === "set_thinking_level") as ToolLike;
		cancelled = true;
		await expect(run(setThinking, { level: "low" })).rejects.toThrow();
		expect((await readConfig()).thinking).toBeUndefined();
	});
});

describe("ai-customizer pi profile on the faux model", () => {
	it("accepts the `i` intent field and applies the scripted tool call", async () => {
		const registration: FauxProviderRegistration = registerFauxProvider({
			api: `faux-ai-customizer-${Math.random().toString(36).slice(2)}`,
			provider: "faux-ai-customizer",
			models: [{ id: "ai-customizer", reasoning: true }],
		});
		cleanups.push(() => registration.unregister());
		const { kit } = toolkitFor();
		const profile = settingsCustomizerProfile({ language: "ko", surface: "ai", toolkit: kit });

		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("set_thinking_level", { i: "사고 깊이를 높음으로 바꾸는 중", level: "high" })),
			fauxAssistantMessage("사고 깊이를 높음으로 설정했습니다."),
		]);

		const session = await createProfileSession({
			profile,
			cwd: root,
			agentDir,
			env,
			model: { model: registration.getModel() },
		});
		const intents: string[] = [];
		const unsubscribe = subscribeProfileProgress(session, (text) => intents.push(text));
		try {
			await session.prompt("사고 깊이를 높음으로 바꿔줘");
		} finally {
			unsubscribe();
			session.dispose();
		}

		expect(intents).toContain("사고 깊이를 높음으로 바꾸는 중");
		expect((await readConfig()).thinking).toEqual({ final: "high" });
	});

	it("stores a key typed for connect_provider_key and keeps it out of the model's context", async () => {
		const registration: FauxProviderRegistration = registerFauxProvider({
			api: `faux-ai-customizer-${Math.random().toString(36).slice(2)}`,
			provider: "faux-ai-customizer",
			models: [{ id: "ai-customizer", reasoning: true }],
		});
		cleanups.push(() => registration.unregister());
		const secret = "sk-ant-api03-SessionSecret0123456789abcd";
		const { kit, record, known } = toolkitFor({ prompter: fakePrompter({ secret }).prompter });
		const profile = settingsCustomizerProfile({ language: "ko", surface: "ai", toolkit: kit });

		const seenByModel: string[] = [];
		registration.setResponses([
			(context: unknown) => {
				seenByModel.push(JSON.stringify(context));
				return fauxAssistantMessage(fauxToolCall("connect_provider_key", { i: "키를 저장하는 중", provider: "anthropic" }));
			},
			(context: unknown) => {
				seenByModel.push(JSON.stringify(context));
				// A model that echoes what it thinks it knows must still have seen only the mask.
				return fauxAssistantMessage(`저장했습니다. 참고로 키는 ${secret} 입니다.`);
			},
		] as never);

		const session = await createProfileSession({
			profile,
			cwd: root,
			agentDir,
			env,
			model: { model: registration.getModel() },
		});
		try {
			await session.prompt("anthropic API 키를 연결해줘");
		} finally {
			session.dispose();
		}

		expect(record).toEqual([{ envName: "ANTHROPIC_API_KEY", value: secret }]);
		expect([...known]).toContain(secret);
		expect(seenByModel.join("\n")).not.toContain("SessionSecret");
		expect(seenByModel.join("\n")).toContain("abcd");
	});
});
