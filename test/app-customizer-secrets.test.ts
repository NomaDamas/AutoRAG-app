import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWebTools } from "@autorag/librarian/profiles";
import { configProfileInput, createAppCustomizerService } from "../src/main/app-customizer-service";
import { createAutoRagConfigService } from "../src/main/autorag-config-service";
import { createMcpSettingsService } from "../src/main/mcp-settings-service";
import { createProviderCredentialService } from "../src/main/provider-credentials";
import { createSettingsService } from "../src/main/settings-service";
import type { AppCustomizerEvent, AppCustomizerSurface } from "../src/shared/app-customizer-contract";

const SECRET = "sk-ant-api03-TopSecretValue0123456789abcdef";
const cleanups: Array<() => Promise<void> | void> = [];
let root: string;
let agentDir: string;
let events: AppCustomizerEvent[];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "cfg-secrets-"));
	agentDir = join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	events = [];
	cleanups.push(() => rm(root, { recursive: true, force: true }));
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function register(): FauxProviderRegistration {
	const registration = registerFauxProvider({ api: `faux-sec-${Math.random().toString(36).slice(2)}`, provider: "faux-sec", models: [{ id: "sec", reasoning: true }] });
	cleanups.push(() => registration.unregister());
	return registration;
}

function build(env: NodeJS.ProcessEnv) {
	const configPath = join(root, "config.json");
	const credentials = createProviderCredentialService({
		filePath: join(root, "credentials.enc.json"),
		safeStorage: { isEncryptionAvailable: () => true, encryptString: (text) => Buffer.from(`enc:${text}`), decryptString: (buf) => buf.toString().slice(4) },
		env,
	});
	const settings = createSettingsService({
		directory: join(root, "settings"),
		dataSources: { list: async () => ({ sources: [] }), setEnabled: async () => undefined, setDescription: async () => undefined, sync: async () => undefined } as never,
		models: { resolve: async () => ({}), catalog: async () => ({}) } as never,
		config: createAutoRagConfigService({ env: { HOME: root, AUTORAG_CONFIG: configPath }, cwd: root }),
		refreshConfig: (async () => ({})) as never,
		credentials,
		providers: {
			list: async () => [{ id: "anthropic", name: "Anthropic", baseUrl: null, kind: "runtime", authKinds: ["api_key"], subscription: false, authConfigured: false, authSource: "none", apiKeyEnv: "ANTHROPIC_API_KEY", models: [] }],
		} as never,
		mcp: createMcpSettingsService({ agentDir: () => agentDir }),
	});
	return { settings, credentials, configPath };
}

async function writeBase(configPath: string): Promise<void> {
	await writeFile(configPath, `${JSON.stringify({ searchPaths: [root], workspacePath: root, memoryPath: join(root, "memory.json") })}\n`);
}

describe("an assistant stores a key the person types without the model seeing it", () => {
	it("connect_provider_key: masked prompt -> encrypted store; the model's context, the events and the reply never contain the key", async () => {
		const env: NodeJS.ProcessEnv = {};
		const { settings, credentials, configPath } = build(env);
		await writeBase(configPath);
		const registration = register();
		const seenByModel: string[] = [];
		const service = createAppCustomizerService({
			send: (event) => {
				events.push(event);
				if (event.type === "prompt" && event.prompt.kind === "secret") {
					void service.answerPrompt(event.prompt.id, { kind: "secret", value: SECRET });
				}
			},
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
			(context: unknown) => {
				seenByModel.push(JSON.stringify(context));
				return fauxAssistantMessage([fauxToolCall("connect_provider_key", { i: "Asking for the key", provider: "anthropic" })]);
			},
			(context: unknown) => {
				seenByModel.push(JSON.stringify(context));
				// A model that tries to echo what it knows must be redacted on the way out.
				return fauxAssistantMessage(`Saved. For the record your key is ${SECRET}.`);
			},
		] as never);

		await service.send("run-key", { sessionId: "s-key", surface: "ai", message: "connect anthropic" });

		expect(await credentials.list(["ANTHROPIC_API_KEY"])).toEqual([{ envName: "ANTHROPIC_API_KEY", stored: true, source: "stored" }]);
		expect(env.ANTHROPIC_API_KEY).toBe(SECRET);
		expect(await readFile(join(root, "credentials.enc.json"), "utf8")).not.toContain(SECRET);
		expect(seenByModel.join("\n")).not.toContain("TopSecretValue");
		expect(seenByModel.join("\n")).toContain("0123456789abcdef".slice(-4));
		expect(JSON.stringify(events)).not.toContain("TopSecretValue");
		const done = events.find((event) => event.type === "turn-done");
		expect(done?.type === "turn-done" && done.changes[0]?.kind).toBe("ai");
		expect(done?.type === "turn-done" && done.messages.join(" ")).not.toContain("TopSecretValue");
		service.dispose();
	});

	it("a cancelled prompt stores nothing and tells the model so", async () => {
		const env: NodeJS.ProcessEnv = {};
		const { settings, credentials, configPath } = build(env);
		await writeBase(configPath);
		const registration = register();
		const toolResults: string[] = [];
		const service = createAppCustomizerService({
			send: (event) => {
				events.push(event);
				if (event.type === "prompt") void service.answerPrompt(event.prompt.id, { kind: "cancelled" });
			},
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
			fauxAssistantMessage([fauxToolCall("connect_provider_key", { i: "Asking", provider: "anthropic" })]),
			(context: { messages: Array<{ role: string; content: unknown }> }) => {
				toolResults.push(JSON.stringify(context.messages.filter((message) => message.role === "toolResult")));
				return fauxAssistantMessage("Okay, nothing saved.");
			},
		] as never);
		await service.send("run-cancel", { sessionId: "s-cancel", surface: "ai", message: "connect anthropic" });
		expect(await credentials.list(["ANTHROPIC_API_KEY"])).toEqual([{ envName: "ANTHROPIC_API_KEY", stored: false, source: "none" }]);
		expect(toolResults.join("")).toMatch(/cancel/i);
		service.dispose();
	});

	it("pasting a key into the chat box never reaches the model and the person is told to use the key field", async () => {
		const env: NodeJS.ProcessEnv = {};
		const { settings, credentials, configPath } = build(env);
		await writeBase(configPath);
		const registration = register();
		const seen: string[] = [];
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
		registration.setResponses([(context: unknown) => { seen.push(JSON.stringify(context)); return fauxAssistantMessage("ok"); }] as never);
		await service.send("run-paste", { sessionId: "s-paste", surface: "ai", message: `use this key ${SECRET} for anthropic` });
		expect(seen.join("")).not.toContain("TopSecretValue");
		service.dispose();
	});
});

describe("web tools for the assistants that research (MCP, apps, AI models)", () => {
	const toolkitOf = (...names: string[]) => ({
		tools: names.map((name) => ({ name, label: name, description: name, parameters: {} as never, execute: async () => ({ content: [], details: undefined }) })) as never,
		takeChanges: () => [],
		peekChanges: () => [],
	});
	const web = createWebTools();
	const namesFor = (surface: AppCustomizerSurface): string[] =>
		configProfileInput("en", surface, toolkitOf("own_tool"), new Set(), web).toolkit.tools.map((tool) => tool.name);

	it("the librarian's web_search and web_fetch exist", () => {
		expect(web.map((tool) => tool.name)).toEqual(["web_search", "web_fetch"]);
	});

	it("MCP, apps and AI models get them next to their own tools", () => {
		for (const surface of ["mcp", "apps", "ai"] as const) expect(namesFor(surface), surface).toEqual(["own_tool", "web_search", "web_fetch"]);
	});

	it("the page-only assistants never get the web", () => {
		for (const surface of ["general", "web", "indexing", "reading", "duplicates"] as const) expect(namesFor(surface), surface).toEqual(["own_tool"]);
	});
});

describe("the AI-model assistant's shell", () => {
	it("is offered only when the app knows the home folder, and as a guarded tool", async () => {
		const { settings, configPath } = build({});
		await writeBase(configPath);
		const registration = register();
		let called = "";
		const service = createAppCustomizerService({
			send: (event) => events.push(event),
			resolveModel: async () => ({ model: registration.getModel()! }),
			agentDir,
			env: {},
			cwd: root,
			homeDir: root,
			language: () => "en",
			settings,
			listLocations: async () => [],
			listTags: async () => [],
		});
		registration.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { i: "Looking for coding agents", command: "echo $ANTHROPIC_API_KEY" })]),
			(context: { messages: Array<{ role: string }> }) => {
				called = JSON.stringify(context.messages.filter((message) => message.role === "toolResult"));
				return fauxAssistantMessage("done");
			},
		] as never);
		await service.send("run-bash", { sessionId: "s-bash", surface: "ai", message: "what agents do I have" });
		expect(called).toMatch(/refus/i);
		service.dispose();
	});
});

describe("which home folder the AI-model assistant looks in", () => {
	it("follows $HOME (where other coding agents keep their config), not the OS user database", async () => {
		const realHome = await mkdtemp(join(tmpdir(), "os-home-"));
		const envHome = await mkdtemp(join(tmpdir(), "env-home-"));
		cleanups.push(() => rm(realHome, { recursive: true, force: true }), () => rm(envHome, { recursive: true, force: true }));
		await mkdir(join(envHome, ".codex"), { recursive: true });
		await writeFile(join(envHome, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-proj-HomeFixtureKey0123456789ABCDEF" }));
		const { settings, configPath } = build({});
		await writeBase(configPath);
		const registration = register();
		let result = "";
		const service = createAppCustomizerService({
			send: (event) => events.push(event),
			resolveModel: async () => ({ model: registration.getModel()! }),
			agentDir,
			env: { HOME: envHome, PATH: "" },
			cwd: root,
			homeDir: realHome,
			language: () => "en",
			settings,
			listLocations: async () => [],
			listTags: async () => [],
		});
		registration.setResponses([
			fauxAssistantMessage([fauxToolCall("scan_coding_agents", { i: "Looking" })]),
			(context: { messages: Array<{ role: string; content: unknown }> }) => {
				result = JSON.stringify(context.messages.filter((message) => message.role === "toolResult"));
				return fauxAssistantMessage("done");
			},
		] as never);
		await service.send("run-home", { sessionId: "s-home", surface: "ai", message: "scan" });
		expect(result).toContain("codex-file");
		expect(result).not.toContain("HomeFixtureKey");
		service.dispose();
	});
});
