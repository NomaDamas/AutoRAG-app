import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProviderAuthService, rankConnectionProbeModels, type ProviderAuthService } from "../src/main/provider-auth-service";
import type { ProviderCredentialService } from "../src/main/provider-credentials";
import type { ProviderCredentialStatus } from "../src/shared/settings-contract";

const directories: string[] = [];
const services: ProviderAuthService[] = [];

afterEach(async () => {
	// The runtime keeps writing its model store/locks into the agent dir until disposed.
	await Promise.all(services.splice(0).map((service) => service.dispose()));
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 3 })));
});

async function createAgentDir(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "autorag-providers-"));
	directories.push(root);
	return root;
}

/** In-memory stand-in for the encrypted store that also mirrors into the process env, like the real one. */
function fakeCredentials(env: NodeJS.ProcessEnv): ProviderCredentialService {
	const entries = new Map<string, string>();
	return {
		list: (envNames?: readonly string[]): readonly ProviderCredentialStatus[] =>
			[...(envNames ?? entries.keys())].map((envName) => ({ envName, stored: entries.has(envName), source: entries.has(envName) ? "stored" : "none" })),
		set: (envName, secret) => {
			entries.set(envName, secret);
			env[envName] = secret;
			return [{ envName, stored: true, source: "stored" }];
		},
		remove: (envName) => {
			entries.delete(envName);
			delete env[envName];
			return [{ envName, stored: false, source: "none" }];
		},
		load: () => [],
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** OpenAI-compatible `/v1/models` that serves two models; everything else 404s. */
const openAiFetch = (async (input: string | URL | Request): Promise<Response> => {
	const url = String(input);
	if (url.endsWith("/v1/models")) return jsonResponse({ data: [{ id: "llama3.1" }, { id: "qwen3" }] });
	return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;

/** Only Ollama `/api/tags` answers, to exercise the fallback path. */
const ollamaFetch = (async (input: string | URL | Request): Promise<Response> => {
	const url = String(input);
	if (url.endsWith("/api/tags")) return jsonResponse({ models: [{ name: "gemma3:latest" }] });
	return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;

interface Fixture {
	readonly service: ProviderAuthService;
	readonly agentDir: string;
	readonly env: NodeJS.ProcessEnv;
}

async function fixture(fetchImpl: typeof fetch): Promise<Fixture> {
	const agentDir = await createAgentDir();
	const env: NodeJS.ProcessEnv = {};
	const service = createProviderAuthService({
		send: () => undefined,
		env,
		credentials: fakeCredentials(env),
		agentDir,
		fetch: fetchImpl,
	});
	services.push(service);
	return { service, agentDir, env };
}

describe("createProviderAuthService", () => {
	it("lists runtime providers with auth kinds and OAuth subscription metadata", async () => {
		const { service } = await fixture(openAiFetch);

		const providers = await service.list();
		const openrouter = providers.find((provider) => provider.id === "openrouter");
		expect(openrouter?.kind).toBe("runtime");
		expect(openrouter?.authKinds).toContain("oauth");
		expect(openrouter?.authKinds).toContain("api_key");
		expect(typeof openrouter?.authConfigured).toBe("boolean");
		expect(providers.some((provider) => provider.subscription)).toBe(true);
	});

	it("rejects a local server that is not on this device", async () => {
		const { service } = await fixture(openAiFetch);

		const result = await service.discover({ kind: "local", label: "Remote", baseUrl: "https://api.example.com/v1" });

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/this device/);
	});

	it("discovers models from an OpenAI-compatible server", async () => {
		const { service } = await fixture(openAiFetch);

		const result = await service.discover({ kind: "local", label: "Local", baseUrl: "http://127.0.0.1:11434/v1" });

		expect(result).toMatchObject({ ok: true, protocol: "openai" });
		expect(result.models.map((model) => model.id)).toEqual(["llama3.1", "qwen3"]);
	});

	it("falls back to the Ollama tags endpoint", async () => {
		const { service } = await fixture(ollamaFetch);

		const result = await service.discover({ kind: "local", label: "Ollama", baseUrl: "http://127.0.0.1:11434" });

		expect(result).toMatchObject({ ok: true, protocol: "ollama" });
		expect(result.models.map((model) => model.id)).toEqual(["gemma3:latest"]);
	});

	it("persists a custom provider to models.json without the plaintext key", async () => {
		const { service, agentDir, env } = await fixture(openAiFetch);

		const providers = await service.upsert({
			kind: "custom",
			label: "My Gateway",
			baseUrl: "https://gw.example.com/v1",
			apiKey: "super-secret-key",
		});

		const custom = providers.find((provider) => provider.name === "My Gateway");
		expect(custom?.kind).toBe("custom");
		expect(custom?.apiKeyEnv).toBeTruthy();
		expect(custom?.models.map((model) => model.id)).toEqual(["llama3.1", "qwen3"]);

		const raw = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8")) as {
			providers: Record<string, { apiKey?: string }>;
		};
		expect(JSON.stringify(raw)).not.toContain("super-secret-key");
		expect(raw.providers[custom?.id ?? ""]?.apiKey).toBe(`$${custom?.apiKeyEnv ?? ""}`);
		expect(env[custom?.apiKeyEnv ?? ""]).toBe("super-secret-key");
	});

	it("removes a provider and its stored key", async () => {
		const { service, agentDir } = await fixture(openAiFetch);

		const providers = await service.upsert({ kind: "local", label: "Local", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "k" });
		const id = providers.find((provider) => provider.name === "Local")?.id ?? "";
		expect(id).not.toBe("");

		const after = await service.remove(id);

		expect(after.some((provider) => provider.id === id)).toBe(false);
		const raw = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8")) as { providers: Record<string, unknown> };
		expect(raw.providers[id]).toBeUndefined();
	});

	it("rejects login for an unknown provider and responding to an unknown session", async () => {
		const { service } = await fixture(openAiFetch);

		await expect(service.start("not-a-provider", "api_key")).rejects.toThrow(/Unknown provider/);
		await expect(service.respond("missing-session", "x")).rejects.toThrow(/not waiting for input/);
	});

	it("passes a local server only while it answers its model list", async () => {
		let up = true;
		const { service } = await fixture(((input: string | URL | Request) => (up ? openAiFetch(input) : Promise.reject(new Error("ECONNREFUSED")))) as unknown as typeof fetch);
		const providers = await service.upsert({ kind: "local", label: "Local", baseUrl: "http://127.0.0.1:11434/v1" });
		const id = providers.find((provider) => provider.name === "Local")?.id ?? "";

		expect(await service.test(id)).toEqual({ ok: true });
		up = false;
		expect(await service.test(id)).toEqual({ ok: false });
		expect(await service.test("not-a-provider")).toEqual({ ok: false });
	});

	it("fails a built-in provider with no credential without sending any request", async () => {
		const previous = process.env.OPENROUTER_API_KEY;
		const { service } = await fixture((async () => {
			throw new Error("no network expected");
		}) as unknown as typeof fetch);
		try {
			delete process.env.OPENROUTER_API_KEY;
			expect(await service.test("openrouter")).toEqual({ ok: false });
		} finally {
			if (previous !== undefined) process.env.OPENROUTER_API_KEY = previous;
		}
	});

	it("tries the cheapest paid models first and free or unpriced ones last", () => {
		const model = (id: string, input: number, output: number): { id: string; cost: { input: number; output: number } } => ({ id, cost: { input, output } });
		const ranked = rankConnectionProbeModels([
			model("free", 0, 0),
			model("pricey", 15, 75),
			model("nan", Number.NaN, 1),
			model("cheap", 0.05, 0.1),
			model("mid", 1, 3),
		]);

		expect(ranked.map((entry) => entry.id)).toEqual(["cheap", "mid", "pricey", "free", "nan"]);
	});
});
