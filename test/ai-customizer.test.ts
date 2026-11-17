import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { createProfileSession } from "@autorag/librarian/profiles";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAiCustomizerToolkit, aiCustomizerProfile } from "../src/main/agents/profiles/ai-customizer";
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

function makeSettings(providers: readonly ProviderSummary[]) {
	return createSettingsService({
		directory: join(root, "settings"),
		dataSources: { list: () => Promise.resolve({}), setEnabled: () => Promise.resolve({}), setDescription: () => Promise.resolve({}), sync: () => Promise.resolve({}) } as never,
		models: { resolve: () => Promise.resolve(null), catalog: () => Promise.resolve(null) } as never,
		config: createAutoRagConfigService({ env, cwd: root }),
		refreshConfig: (() => Promise.resolve({})) as never,
		credentials: { list: () => Promise.resolve([]), set: () => Promise.resolve([]), remove: () => Promise.resolve([]) } as never,
		providers: { list: () => Promise.resolve(providers) } as never,
	});
}

function toolkitFor(providers: readonly ProviderSummary[] = [OPENROUTER, DAZZI, ANTHROPIC]) {
	const settings = makeSettings(providers);
	const kit = createAiCustomizerToolkit({ settings, language: () => "ko" });
	const tools = new Map(kit.tools.map((tool) => [tool.name, tool]));
	return { settings, kit, tools };
}

const readConfig = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;

type ToolLike = { execute: (id: string, params: Record<string, unknown>, ...rest: unknown[]) => Promise<{ content: { type: string; text: string }[] }> };

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

describe("ai-customizer pi agent profile & toolkit", () => {
	it("exposes exactly the four AI/web tools and states the credential, embedding and catalog invariants", () => {
		const { kit } = toolkitFor();
		const profile = aiCustomizerProfile({ language: "ko", surface: "ai", toolkit: kit });

		expect(profile.id).toBe("ai-customizer");
		expect(profile.tools).toEqual([]);
		expect(profile.customTools?.map((tool) => tool.name).sort()).toEqual([
			"get_ai_settings",
			"set_model_role",
			"set_thinking_level",
			"update_web_search",
		]);
		expect(profile.systemPrompt).toContain("Korean");
		expect(profile.systemPrompt).toMatch(/connect/i);
		expect(profile.systemPrompt).toMatch(/API key/i);
		expect(profile.systemPrompt).toMatch(/embedding/i);
	});

	it("answers the web surface with the same tools and web-search wording", () => {
		const { kit } = toolkitFor();
		const profile = aiCustomizerProfile({ language: "en", surface: "web", toolkit: kit });

		expect(profile.customTools?.map((tool) => tool.name).sort()).toEqual([
			"get_ai_settings",
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
		const profile = aiCustomizerProfile({ language: "ko", surface: "ai", toolkit: kit });

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
});
