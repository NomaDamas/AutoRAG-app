import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppCustomizerService } from "../src/main/app-customizer-service";
import { createAutoRagConfigService } from "../src/main/autorag-config-service";
import { createProviderAuthService, type ProviderAuthService } from "../src/main/provider-auth-service";
import { createProviderCredentialService } from "../src/main/provider-credentials";
import { createSettingsService } from "../src/main/settings-service";
import type { AppCustomizerEvent } from "../src/shared/app-customizer-contract";

const OMP_KEY = "mp-live-OmpServiceKey0123456789ab";
const ENV_NAME = "OMPQA_PROXY_API_KEY";
const cleanups: Array<() => Promise<void> | void> = [];
let root: string;
let home: string;
let agentDir: string;
let events: AppCustomizerEvent[];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "omp-service-"));
	home = join(root, "home");
	agentDir = join(root, "agent");
	events = [];
	await mkdir(join(home, ".omp", "agent"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(home, ".omp", "agent", "models.yml"),
		`providers:\n  ompproxy:\n    baseUrl: https://proxy.example.test/v1\n    api: openai-responses\n    apiKey: ${ENV_NAME}\n    auth: apiKey\n    models:\n      - id: model-a\n        name: Model A\n        reasoning: true\n        input: [text, image]\n        contextWindow: 272000\n        maxTokens: 128000\n      - id: model-b\n        name: Model B\n`,
	);
	await writeFile(join(home, ".zshrc"), `export ${ENV_NAME}=${OMP_KEY}\n`);
	cleanups.push(() => rm(root, { recursive: true, force: true }));
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	delete process.env[ENV_NAME];
});

function register(): FauxProviderRegistration {
	const registration = registerFauxProvider({ api: `faux-omp-${Math.random().toString(36).slice(2)}`, provider: "faux-omp", models: [{ id: "omp-qa", reasoning: true }] });
	cleanups.push(() => registration.unregister());
	return registration;
}

describe("bringing omp's setup into Dazzi and connecting a model, end to end", () => {
	it("imports the provider, stores its key encrypted, and sets it as the answer model", async () => {
		const configPath = join(root, "config.json");
		await writeFile(configPath, `${JSON.stringify({ searchPaths: [root], workspacePath: root, memoryPath: join(root, "memory.json") })}\n`);
		const env: NodeJS.ProcessEnv = { HOME: home, PATH: process.env.PATH ?? "", PI_CODING_AGENT_DIR: agentDir, AUTORAG_CONFIG: configPath };
		const credentials = createProviderCredentialService({
			filePath: join(root, "credentials.enc.json"),
			safeStorage: { isEncryptionAvailable: () => true, encryptString: (text) => Buffer.from(`enc:${text}`), decryptString: (buffer) => buffer.toString().slice(4) },
			env: process.env,
		});
		const providers: ProviderAuthService = createProviderAuthService({ send: () => undefined, env: process.env, credentials, agentDir });
		cleanups.push(() => providers.dispose());
		const settings = createSettingsService({
			directory: join(root, "settings"),
			dataSources: { list: async () => ({ sources: [] }), setEnabled: async () => undefined, setDescription: async () => undefined, sync: async () => undefined } as never,
			models: { resolve: async () => ({}), catalog: async () => ({}) } as never,
			config: createAutoRagConfigService({ env, cwd: root }),
			refreshConfig: (async () => ({})) as never,
			credentials,
			providers,
		});
		const registration = register();
		let toolResults = "";
		const service = createAppCustomizerService({
			send: (event) => {
				events.push(event);
				if (event.type === "prompt" && event.prompt.kind === "confirm") void service.answerPrompt(event.prompt.id, { kind: "confirm", confirmed: true });
			},
			resolveModel: async () => ({ model: registration.getModel()! }),
			agentDir,
			env,
			cwd: root,
			homeDir: home,
			language: () => "en",
			settings,
			importCustomProvider: (input) => providers.importCustom(input),
			listLocations: async () => [],
			listTags: async () => [],
		});
		cleanups.push(() => service.dispose());
		registration.setResponses([
			fauxAssistantMessage([fauxToolCall("scan_coding_agents", { i: "Looking at other agents" })]),
			fauxAssistantMessage([fauxToolCall("import_omp_provider", { i: "Bringing the provider over", provider: "ompproxy" })]),
			(context: { messages: Array<{ role: string; content: unknown }> }) => {
				toolResults = JSON.stringify(context.messages.filter((message) => message.role === "toolResult"));
				const imported = JSON.parse(String((context.messages.filter((message) => message.role === "toolResult").at(-1)?.content as Array<{ text: string }>)[0]?.text));
				return fauxAssistantMessage([fauxToolCall("set_model_role", { i: "Choosing the model", role: "answer", provider: imported.provider, modelId: "model-a" })]);
			},
			fauxAssistantMessage("Connected."),
		] as never);

		await service.send("run-omp", { sessionId: "s-omp", surface: "ai", message: "bring my omp setup over and use its first model" });

		const done = events.find((event) => event.type === "turn-done");
		expect(done?.type === "turn-done" && done.changes.map((change) => change.kind)).toEqual(["ai", "ai"]);
		const list = await providers.list();
		const imported = list.find((provider) => provider.name === "ompproxy");
		expect(imported).toBeDefined();
		expect(imported?.authConfigured).toBe(true);
		expect(imported?.models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
		const saved = JSON.parse(await readFile(join(root, "config.json"), "utf8")) as { model?: { provider?: string; id?: string } };
		expect(saved.model).toMatchObject({ provider: imported?.id, id: "model-a" });
		expect(await readFile(join(agentDir, "models.json"), "utf8")).not.toContain(OMP_KEY);
		expect(await readFile(join(root, "credentials.enc.json"), "utf8")).not.toContain(OMP_KEY);
		expect(process.env[ENV_NAME]).toBe(OMP_KEY);
		expect(toolResults).not.toContain("OmpServiceKey");
		expect(JSON.stringify(events)).not.toContain("OmpServiceKey");
	});
});
