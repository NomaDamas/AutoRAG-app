import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProviderAuthService, type ProviderAuthService } from "../src/main/provider-auth-service";
import { createProviderCredentialService, type SafeStorageLike } from "../src/main/provider-credentials";
import type { CustomProviderImport } from "../src/main/provider-auth-service";

const directories: string[] = [];
const services: ProviderAuthService[] = [];
const envNames = new Set<string>();

afterEach(async () => {
	// The runtime keeps writing its model store/locks into the agent dir until disposed.
	await Promise.all(services.splice(0).map((service) => service.dispose()));
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 3 })));
	for (const name of envNames) delete process.env[name];
	envNames.clear();
});

/** Real encrypted store over a fake keyring, writing into the process env like the app does. */
function fakeSafeStorage(): SafeStorageLike {
	return {
		isEncryptionAvailable: () => true,
		encryptString: (plainText) => Buffer.from(`enc:${plainText}`),
		decryptString: (encrypted) => encrypted.toString("utf8").replace(/^enc:/u, ""),
	};
}

interface Fixture {
	readonly service: ProviderAuthService;
	readonly agentDir: string;
	readonly credentialsPath: string;
}

async function fixture(): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "autorag-provider-import-"));
	directories.push(root);
	const credentialsPath = join(root, "credentials.enc.json");
	const credentials = createProviderCredentialService({ filePath: credentialsPath, safeStorage: fakeSafeStorage(), env: process.env });
	const agentDir = join(root, "agent");
	// `env` is the live process env: Pi resolves `$NAME` models.json references from it,
	// exactly as it does in the app where the credential store populates it at save time.
	const service = createProviderAuthService({ send: () => undefined, env: process.env, credentials, agentDir });
	services.push(service);
	return { service, agentDir, credentialsPath };
}

/** A many-model omp-style definition: an env-ref provider with a full model list. */
const MODELS: CustomProviderImport["models"] = [
	{ id: "vendor/alpha", name: "Vendor Alpha", reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 8192 },
	{ id: "vendor/beta", name: "Vendor Beta" },
	{ id: "vendor/gamma", name: "Vendor Gamma", contextWindow: 8192, maxTokens: 1024 },
];

function readModels(path: string): Promise<{ providers: Record<string, Record<string, unknown>> }> {
	return readFile(path, "utf8").then((text) => JSON.parse(text) as { providers: Record<string, Record<string, unknown>> });
}

describe("importCustom", () => {
	it("writes the imported provider with its own api, model definitions and env reference, never the secret", async () => {
		const { service, agentDir } = await fixture();
		const envName = "AUTORAG_OMP_IMPORT_TEST_KEY";
		envNames.add(envName);
		const secret = "omp-import-env-secret";

		const result = await service.importCustom({
			label: "OMP Gateway",
			api: "openai-responses",
			baseUrl: "https://omp.example.com/v1/",
			apiKeyEnvName: envName,
			apiKeyValue: secret,
			models: MODELS,
		});

		expect(result.id).toBe("custom-omp-gateway");
		const raw = await readModels(join(agentDir, "models.json"));
		const entry = raw.providers[result.id];
		expect(entry).toMatchObject({ name: "OMP Gateway", baseUrl: "https://omp.example.com/v1", api: "openai-responses", apiKey: `$${envName}` });
		expect(entry?.models).toEqual([
			{ id: "vendor/alpha", name: "Vendor Alpha", reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 8192 },
			{ id: "vendor/beta", name: "Vendor Beta" },
			{ id: "vendor/gamma", name: "Vendor Gamma", contextWindow: 8192, maxTokens: 1024 },
		]);
		// The plaintext key never reaches models.json; it is stored encrypted and mirrored into the env.
		expect(JSON.stringify(raw)).not.toContain(secret);
		expect(process.env[envName]).toBe(secret);
		expect(await readFile(join(agentDir, "models.json"), "utf8")).not.toContain(secret);
	});

	it("loads the imported entry into the runtime: list() shows it with its models and connected when the env key is set", async () => {
		const { service } = await fixture();
		const envName = "AUTORAG_OMP_IMPORT_LIST_KEY";
		envNames.add(envName);

		const { id } = await service.importCustom({
			label: "OMP Gateway",
			api: "openai-responses",
			baseUrl: "https://omp.example.com/v1",
			apiKeyEnvName: envName,
			apiKeyValue: "omp-import-list-secret",
			models: MODELS,
		});

		const imported = (await service.list()).find((provider) => provider.id === id);
		expect(imported?.name).toBe("OMP Gateway");
		expect(imported?.kind).toBe("custom");
		expect(imported?.authConfigured).toBe(true);
		expect(imported?.apiKeyEnv).toBe(envName);
		expect(imported?.models.map((model) => model.id)).toEqual(["vendor/alpha", "vendor/beta", "vendor/gamma"]);
		expect(imported?.models[0]?.api).toBe("openai-responses");
		expect(imported?.models[1]?.name).toBe("Vendor Beta");
	});

	it("reports an env-reference provider as not connected until the variable is set", async () => {
		const { service } = await fixture();
		const envName = "AUTORAG_OMP_IMPORT_UNSET_KEY";
		envNames.add(envName);
		delete process.env[envName];

		const { id } = await service.importCustom({
			label: "OMP Late Key",
			api: "anthropic-messages",
			baseUrl: "https://omp.example.com/v1",
			apiKeyEnvName: envName,
			models: [{ id: "vendor/solo", name: "Vendor Solo" }],
		});

		expect((await service.list()).find((provider) => provider.id === id)?.authConfigured).toBe(false);
		process.env[envName] = "late-secret";
		expect((await service.list()).find((provider) => provider.id === id)?.authConfigured).toBe(true);
	});

	it("writes the no-key marker for a keyless import and lists it as connected", async () => {
		const { service, agentDir } = await fixture();

		const { id } = await service.importCustom({
			label: "OMP Keyless",
			api: "openai-completions",
			baseUrl: "https://keyless.example.com/v1",
			apiKeyEnvName: null,
			models: [{ id: "vendor/keyless", name: "Vendor Keyless" }],
		});

		const raw = await readModels(join(agentDir, "models.json"));
		expect(raw.providers[id]?.apiKey).toBe("no-key");
		const imported = (await service.list()).find((provider) => provider.id === id);
		expect(imported?.authConfigured).toBe(true);
		expect(imported?.models.map((model) => model.id)).toEqual(["vendor/keyless"]);
	});

	it("refuses an api the runtime does not accept, naming the accepted list", async () => {
		const { service } = await fixture();

		const attempt = service.importCustom({
			label: "OMP Bad Api",
			api: "made-up-wire-protocol",
			baseUrl: "https://omp.example.com/v1",
			apiKeyEnvName: null,
			models: [{ id: "vendor/solo", name: "Vendor Solo" }],
		});

		await expect(attempt).rejects.toThrow(/made-up-wire-protocol/u);
		await expect(
			service.importCustom({ label: "OMP Bad Api", api: "made-up-wire-protocol", baseUrl: "https://omp.example.com/v1", apiKeyEnvName: null, models: [{ id: "vendor/solo", name: "Vendor Solo" }] }),
		).rejects.toThrow(/openai-completions.*anthropic-messages/u);
	});

	it("refuses a base URL that is not http(s)", async () => {
		const { service } = await fixture();

		await expect(
			service.importCustom({ label: "OMP Bad Url", api: "openai-completions", baseUrl: "ftp://omp.example.com/v1", apiKeyEnvName: null, models: [{ id: "vendor/solo", name: "Vendor Solo" }] }),
		).rejects.toThrow(/http/u);
	});

	it("never overwrites an import that reuses an existing provider name", async () => {
		const { service, agentDir } = await fixture();
		const base: Omit<CustomProviderImport, "label" | "apiKeyEnvName"> = { api: "openai-completions", baseUrl: "https://omp.example.com/v1", models: [{ id: "vendor/solo", name: "Vendor Solo" }] };

		const first = await service.importCustom({ ...base, label: "OMP Duplicate", apiKeyEnvName: null });
		await expect(service.importCustom({ ...base, label: "OMP Duplicate", apiKeyEnvName: null })).rejects.toThrow(/already exists/u);

		const raw = await readModels(join(agentDir, "models.json"));
		expect(Object.values(raw.providers).filter((entry) => entry.name === "OMP Duplicate")).toHaveLength(1);
		expect(raw.providers[first.id]).toBeDefined();
	});

	it("rejects a key value without an environment variable to reference it", async () => {
		const { service } = await fixture();

		await expect(
			service.importCustom({ label: "OMP Dangling", api: "openai-completions", baseUrl: "https://omp.example.com/v1", apiKeyEnvName: null, apiKeyValue: "dangling", models: [{ id: "vendor/solo", name: "Vendor Solo" }] }),
		).rejects.toThrow(/environment variable/u);
	});

	it("removes an imported provider and its stored key like any custom one", async () => {
		const { service, agentDir } = await fixture();
		const envName = "AUTORAG_OMP_IMPORT_REMOVE_KEY";
		envNames.add(envName);

		const { id } = await service.importCustom({
			label: "OMP Temporary",
			api: "openai-responses",
			baseUrl: "https://omp.example.com/v1",
			apiKeyEnvName: envName,
			apiKeyValue: "omp-remove-secret",
			models: [{ id: "vendor/solo", name: "Vendor Solo" }],
		});
		expect(process.env[envName]).toBe("omp-remove-secret");

		const after = await service.remove(id);

		expect(after.some((provider) => provider.id === id)).toBe(false);
		expect(process.env[envName]).toBeUndefined();
		expect((await readModels(join(agentDir, "models.json"))).providers[id]).toBeUndefined();
	});
});
