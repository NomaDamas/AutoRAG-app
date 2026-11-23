import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfirmPromptInput, RunPrompter, SecretPromptInput } from "../src/main/agents/customizer-prompter";
import { createAiCustomizerToolkit } from "../src/main/agents/profiles/ai-customizer";
import type { CustomProviderImport } from "../src/main/provider-auth-service";
import type { ProviderSummary, SettingsBridge } from "../src/shared/settings-contract";

const MYPROXY_KEY = "mp-live-OmpMyProxyKey0123456789";
const LITERAL_KEY = "lit-OmpLiteralKey0123456789ab";
const DB_KEY = "sk-or-v1-OmpDbOpenRouterKey0123456789";

let home: string;
const cleanups: Array<() => Promise<void>> = [];

const MODELS_YML = `providers:
  myproxy:
    baseUrl: https://proxy.example.test/v1
    api: openai-responses
    apiKey: MYPROXY_API_KEY
    auth: apiKey
    models:
      - id: gpt-x
        name: GPT X
        reasoning: true
        input: [text, image]
        contextWindow: 272000
        maxTokens: 128000
      - id: kimi-x
        name: Kimi X
        contextWindow: 200000
        maxTokens: 32000
  apitopia:
    baseUrl: https://apitopia.example.test/v1
    api: openai-completions
    apiKey: ${LITERAL_KEY}
    auth: apiKey
    models:
      - id: topia-1
        name: Topia 1
  weird:
    baseUrl: https://weird.example.test/v1
    api: some-unknown-protocol
    apiKey: WEIRD_KEY
    models:
      - id: w1
        name: W1
  viacommand:
    baseUrl: https://cmd.example.test/v1
    api: openai-completions
    apiKey: "!pass show cmd-key"
    models:
      - id: c1
        name: C1
`;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "omp-ai-"));
	cleanups.push(() => rm(home, { recursive: true, force: true }));
	await mkdir(join(home, ".omp", "agent"), { recursive: true });
	await writeFile(join(home, ".omp", "agent", "models.yml"), MODELS_YML);
	await writeFile(join(home, ".zshrc"), `export MYPROXY_API_KEY=${MYPROXY_KEY}\n`);
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const PROVIDERS: readonly ProviderSummary[] = [];

function fakePrompter(answers: { confirm?: boolean }): { prompter: RunPrompter; confirms: ConfirmPromptInput[]; secrets: SecretPromptInput[] } {
	const confirms: ConfirmPromptInput[] = [];
	const secrets: SecretPromptInput[] = [];
	return {
		confirms,
		secrets,
		prompter: {
			askSecret: async (input) => (secrets.push(input), { kind: "cancelled" }),
			askConfirm: async (input) => (confirms.push(input), answers.confirm === true ? { kind: "confirm", confirmed: true } : { kind: "cancelled" }),
		},
	};
}

function setup(options: { confirm?: boolean; importCustom?: boolean } = {}) {
	const imported: CustomProviderImport[] = [];
	const stored: Array<{ envName: string; value: string }> = [];
	const known = new Set<string>();
	const { prompter, confirms } = fakePrompter({ confirm: options.confirm ?? true });
	const settings = {
		providersList: async () => PROVIDERS,
		credentialsList: async () => [],
		credentialsSet: async (envName: string, value: string) => (stored.push({ envName, value }), []),
		configGet: async () => ({ configPath: "", configExists: false, error: null, config: {} }),
	} as unknown as SettingsBridge;
	const kit = createAiCustomizerToolkit({
		settings,
		language: () => "en",
		secrets: { known, prompter: () => prompter },
		shell: { homeDir: home, cwd: home, env: {} },
		...(options.importCustom === false
			? {}
			: { importCustomProvider: async (input: CustomProviderImport) => (imported.push(input), { id: `custom-${input.label}`, providers: [] }) }),
	});
	const tools = new Map(kit.tools.map((tool) => [tool.name, tool]));
	return { tools, imported, stored, known, confirms, kit };
}

type ToolLike = { execute: (id: string, params: Record<string, unknown>, ...rest: unknown[]) => Promise<{ content: { type: string; text: string }[] }> };
async function run(tool: unknown, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
	const result = await (tool as ToolLike).execute("call", params, undefined, undefined, undefined as never);
	return JSON.parse(result.content.map((block) => (block.type === "text" ? block.text : "")).join("")) as Record<string, unknown>;
}

describe("scan_coding_agents sees omp", () => {
	it("reports omp's custom providers with their models and key state, and never a key", async () => {
		const { tools } = setup();
		const result = await run(tools.get("scan_coding_agents"));
		const text = JSON.stringify(result);
		for (const secret of [MYPROXY_KEY, LITERAL_KEY]) expect(text).not.toContain(secret);
		const omp = (result.agents as Array<Record<string, unknown>>).find((agent) => agent.id === "omp");
		expect(omp).toMatchObject({ installed: true });
		const providers = omp?.providers as Array<Record<string, unknown>>;
		expect(providers.map((provider) => provider.name).sort()).toEqual(["apitopia", "myproxy", "viacommand", "weird"]);
		const myproxy = providers.find((provider) => provider.name === "myproxy");
		expect(myproxy).toMatchObject({ api: "openai-responses", baseUrl: "https://proxy.example.test/v1", modelCount: 2, keyAvailable: true, importable: true, source: "omp:myproxy" });
		expect(providers.find((provider) => provider.name === "weird")).toMatchObject({ importable: false });
		expect(providers.find((provider) => provider.name === "viacommand")).toMatchObject({ keyAvailable: false });
	});

	it("is not installed when there is no ~/.omp", async () => {
		await rm(join(home, ".omp"), { recursive: true, force: true });
		const { tools } = setup();
		const omp = ((await run(tools.get("scan_coding_agents"))).agents as Array<Record<string, unknown>>).find((agent) => agent.id === "omp");
		expect(omp).toMatchObject({ installed: false });
	});
});

describe("import_omp_provider", () => {
	it("has no parameter that can carry a key or a url", () => {
		const { tools } = setup();
		const properties = Object.keys(((tools.get("import_omp_provider")?.parameters as { properties?: Record<string, unknown> }) ?? {}).properties ?? {}).sort();
		expect(properties).toEqual(["provider"]);
	});

	it("after the confirm card, imports the definition with its models and stores the key the app read, not the model", async () => {
		const { tools, imported, stored, known, confirms } = setup();
		const result = await run(tools.get("import_omp_provider"), { provider: "myproxy" });
		expect(result).toMatchObject({ ok: true, provider: "custom-myproxy", models: 2, keyStored: true });
		expect(JSON.stringify(result)).not.toContain(MYPROXY_KEY);
		expect(imported).toHaveLength(1);
		expect(imported[0]).toMatchObject({ label: "myproxy", api: "openai-responses", baseUrl: "https://proxy.example.test/v1", apiKeyEnvName: "MYPROXY_API_KEY", apiKeyValue: MYPROXY_KEY });
		expect(imported[0]?.models.map((model) => model.id)).toEqual(["gpt-x", "kimi-x"]);
		expect(imported[0]?.models[0]).toMatchObject({ reasoning: true, contextWindow: 272000, maxTokens: 128000, input: ["text", "image"] });
		expect(known.has(MYPROXY_KEY)).toBe(true);
		expect(stored).toEqual([]);
		const card = confirms[0];
		expect(card?.lines.join("\n")).toContain("https://proxy.example.test/v1");
		expect(card?.lines.join("\n")).toContain("2");
		expect(JSON.stringify(card)).not.toContain(MYPROXY_KEY);
	});

	it("imports a literal key too: omp has no variable name for it, so it is stored under one derived from the provider", async () => {
		const { tools, imported, known } = setup();
		const result = await run(tools.get("import_omp_provider"), { provider: "apitopia" });
		expect(result).toMatchObject({ ok: true, keyStored: true });
		expect(imported[0]).toMatchObject({ label: "apitopia", apiKeyEnvName: "APITOPIA_API_KEY", apiKeyValue: LITERAL_KEY });
		expect(known.has(LITERAL_KEY)).toBe(true);
		expect(JSON.stringify(result)).not.toContain(LITERAL_KEY);
	});

	it("derives a valid variable name from any provider name", async () => {
		await writeFile(join(home, ".omp", "agent", "models.yml"), `providers:\n  my-proxy.v2:\n    baseUrl: https://p.example.test/v1\n    api: openai-completions\n    apiKey: lit-weird-name-key-0123456789\n    models:\n      - id: m\n        name: M\n`);
		const { tools, imported } = setup();
		await run(tools.get("import_omp_provider"), { provider: "my-proxy.v2" });
		expect(imported[0]?.apiKeyEnvName).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/u);
		expect(imported[0]?.apiKeyEnvName).toBe("MY_PROXY_V2_API_KEY");
	});

	it("writes nothing when the person declines", async () => {
		const { tools, imported } = setup({ confirm: false });
		expect(await run(tools.get("import_omp_provider"), { provider: "myproxy" })).toEqual({ ok: false, cancelled: true });
		expect(imported).toEqual([]);
	});

	it("refuses a protocol Dazzi cannot speak, a command-backed key, an unknown name, and a window with no confirm card", async () => {
		const { tools, imported } = setup();
		expect(await run(tools.get("import_omp_provider"), { provider: "weird" })).toMatchObject({ ok: false, error: expect.stringMatching(/some-unknown-protocol/u) });
		expect(await run(tools.get("import_omp_provider"), { provider: "viacommand" })).toMatchObject({ ok: false });
		const unknown = await run(tools.get("import_omp_provider"), { provider: "nope" });
		expect(unknown).toMatchObject({ ok: false });
		expect(unknown.choices).toEqual(expect.arrayContaining(["myproxy", "apitopia"]));
		expect(imported).toEqual([]);

		const noCard = createAiCustomizerToolkit({ settings: {} as never, language: () => "en", shell: { homeDir: home, cwd: home, env: {} }, importCustomProvider: async () => ({ id: "x", providers: [] }) });
		const refused = await run(noCard.tools.find((tool) => tool.name === "import_omp_provider"), { provider: "myproxy" });
		expect(refused.ok).toBe(false);
	});

	it("keeps the definition but says the key could not be found when the env var is not set anywhere", async () => {
		await writeFile(join(home, ".zshrc"), "alias a=b\n");
		const { tools, imported } = setup();
		const result = await run(tools.get("import_omp_provider"), { provider: "myproxy" });
		expect(result).toMatchObject({ ok: true, keyStored: false });
		expect(String(result.note)).toMatch(/MYPROXY_API_KEY/u);
		expect(imported[0]?.apiKeyValue).toBeUndefined();
		expect(imported[0]?.apiKeyEnvName).toBe("MYPROXY_API_KEY");
	});

	it("is not offered when the app cannot import a custom provider", () => {
		const { tools } = setup({ importCustom: false });
		expect(tools.has("import_omp_provider")).toBe(false);
	});
});
