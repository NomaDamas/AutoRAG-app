import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	listOmpOauth,
	readOmpApiKeys,
	readOmpProviders,
	resolveOmpProviderKey,
	type OmpInputs,
	type OmpProviderDefinition,
} from "../src/main/omp-config";

/**
 * Every secret in these fixtures is a recognisable fake. The tests prove the value never appears in a
 * `readOmpProviders` result and only comes back from the two functions that are allowed to return one.
 */
const SECRETS = {
	env: "sk-env-ENVREF-0001",
	zshrc: "sk-zshrc-ZSHRC-0002",
	dotenv: "sk-dotenv-DOTENV-0003",
	literal: "sk-literal-LITERAL-0004",
	braced: "sk-env-BRACED-0005",
	command: "sk-command-COMMAND-0006",
	db: "sk-db-DBKEY-0007",
	disabled: "sk-db-DISABLED-0008",
} as const;

const ENV_PROVIDER = "envref";
const ENV_NAME = "CCAPI_API_KEY";
const LITERAL_PROVIDER = "literalref";
const COMMAND_PROVIDER = "commandref";
const KEYLESS_PROVIDER = "keyless";
const BRACED_PROVIDER = "bracedref";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function manyModels(count: number): string {
	const models = Array.from({ length: count }, (_, index) => {
		const id = `model-${index}`;
		return `      - id: ${id}\n        name: Model ${index}\n        reasoning: true\n        input: [text, image]\n        contextWindow: ${1000 + index}\n        maxTokens: ${200 + index}`;
	});
	return models.join("\n");
}

function modelsYaml(): string {
	return [
		"providers:",
		`  ${ENV_PROVIDER}:`,
		"    baseUrl: https://api.envref.example/v1",
		"    api: openai-completions",
		`    apiKey: ${ENV_NAME}`,
		"    models:",
		"      - id: env-model",
		"        name: Env Model",
		"        input: [text]",
		"        contextWindow: 128000",
		"        maxTokens: 4096",
		"      - id: env-model-2",
		"        name: Env Model 2",
		`  ${LITERAL_PROVIDER}:`,
		"    baseUrl: https://api.literal.example/v1",
		"    api: anthropic-messages",
		`    apiKey: ${SECRETS.literal}`,
		"    models:",
		"      - id: literal-model",
		"        name: Literal Model",
		`  ${COMMAND_PROVIDER}:`,
		"    baseUrl: https://api.command.example/v1",
		"    api: openai-responses",
		`    apiKey: !command echo ${SECRETS.command}`,
		"    models:",
		"      - id: command-model",
		"        name: Command Model",
		`  ${KEYLESS_PROVIDER}:`,
		"    baseUrl: https://api.keyless.example/v1",
		"    api: openai-completions",
		"    models:",
		"      - id: keyless-model",
		"        name: Keyless Model",
		`  ${BRACED_PROVIDER}:`,
		"    baseUrl: https://api.braced.example/v1",
		"    api: openai-completions",
		"    apiKey: ${BRACED_API_KEY}",
		"    models:",
		"      - id: braced-model",
		"        name: Braced Model",
		"  big:",
		"    baseUrl: https://api.big.example/v1",
		"    api: openai-completions",
		`    apiKey: $${ENV_NAME}`,
		"    models:",
		manyModels(35),
		"",
	].join("\n");
}

interface Fixture {
	readonly homeDir: string;
	readonly modelsPath: string;
	readonly dbPath: string;
	readonly zshrcPath: string;
	readonly dotenvPath: string;
}

async function setup(options: { readonly modelsYml?: string | null; readonly db?: boolean } = {}): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "autorag-omp-config-"));
	directories.push(root);
	const homeDir = join(root, "home");
	const agentDir = join(homeDir, ".omp", "agent");
	await mkdir(agentDir, { recursive: true });
	const modelsPath = join(agentDir, "models.yml");
	if (options.modelsYml !== null) await writeFile(modelsPath, options.modelsYml ?? modelsYaml());
	const dbPath = join(agentDir, "agent.db");
	if (options.db !== false) {
		const db = new DatabaseSync(dbPath);
		db.exec(
			"CREATE TABLE auth_credentials (provider TEXT, credential_type TEXT, data TEXT, disabled_cause TEXT)",
		);
		const insert = db.prepare("INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause) VALUES (?, ?, ?, ?)");
		insert.run(ENV_PROVIDER, "api_key", JSON.stringify({ key: SECRETS.db, source: "env" }), null);
		insert.run("disabled-provider", "api_key", JSON.stringify({ key: SECRETS.disabled, source: "env" }), "user_disabled");
		insert.run("oauth-provider", "oauth", JSON.stringify({ access: "not-importable" }), null);
		insert.run("oauth-disabled", "oauth", JSON.stringify({ access: "not-importable" }), "revoked");
		db.close();
	}
	const zshrcPath = join(homeDir, ".zshrc");
	const dotenvPath = join(agentDir, ".env");
	return { homeDir, modelsPath, dbPath, zshrcPath, dotenvPath };
}

function inputs(fixture: Fixture, env: NodeJS.ProcessEnv = {}): OmpInputs {
	return { homeDir: fixture.homeDir, env, platform: "darwin" };
}

function byName(providers: readonly OmpProviderDefinition[], name: string): OmpProviderDefinition {
	const found = providers.find((provider) => provider.name === name);
	if (found === undefined) throw new Error(`missing provider ${name}`);
	return found;
}

describe("readOmpProviders", () => {
	it("reads every provider without ever exposing a secret", async () => {
		const fixture = await setup();
		const providers = readOmpProviders(inputs(fixture, { [ENV_NAME]: SECRETS.env, BRACED_API_KEY: SECRETS.braced }));
		const serialized = JSON.stringify(providers);
		for (const secret of Object.values(SECRETS)) {
			expect(serialized).not.toContain(secret);
		}
		expect(providers.map((provider) => provider.name).sort()).toEqual(
			[ENV_PROVIDER, LITERAL_PROVIDER, COMMAND_PROVIDER, KEYLESS_PROVIDER, BRACED_PROVIDER, "big"].sort(),
		);
	});

	it("classifies each apiKey form and keeps the model definitions", async () => {
		const fixture = await setup();
		const providers = readOmpProviders(inputs(fixture));

		const envProvider = byName(providers, ENV_PROVIDER);
		expect(envProvider.keyKind).toBe("env");
		expect(envProvider.keyEnvName).toBe(ENV_NAME);
		expect(envProvider.api).toBe("openai-completions");
		expect(envProvider.baseUrl).toBe("https://api.envref.example/v1");
		expect(envProvider.models).toHaveLength(2);
		expect(envProvider.models[0]).toEqual({
			id: "env-model",
			name: "Env Model",
			input: ["text"],
			contextWindow: 128000,
			maxTokens: 4096,
		});

		expect(byName(providers, LITERAL_PROVIDER).keyKind).toBe("literal");
		expect(byName(providers, LITERAL_PROVIDER).keyEnvName).toBeNull();
		expect(byName(providers, COMMAND_PROVIDER).keyKind).toBe("command");
		expect(byName(providers, KEYLESS_PROVIDER).keyKind).toBe("none");
		expect(byName(providers, KEYLESS_PROVIDER).keyEnvName).toBeNull();

		const braced = byName(providers, BRACED_PROVIDER);
		expect(braced.keyKind).toBe("env");
		expect(braced.keyEnvName).toBe("BRACED_API_KEY");

		const big = byName(providers, "big");
		expect(big.keyKind).toBe("env");
		expect(big.keyEnvName).toBe(ENV_NAME);
		expect(big.models).toHaveLength(35);
		expect(big.models[34]!.id).toBe("model-34");
		expect(big.models[0]!.reasoning).toBe(true);
	});

	it("returns an empty list for corrupt YAML instead of throwing", async () => {
		const fixture = await setup({ modelsYml: "providers: [unclosed\n  bad: : :\n" });
		expect(readOmpProviders(inputs(fixture))).toEqual([]);
	});

	it("returns an empty list when models.yml is missing", async () => {
		const fixture = await setup({ modelsYml: null });
		expect(readOmpProviders(inputs(fixture))).toEqual([]);
	});
});

describe("resolveOmpProviderKey", () => {
	it("resolves an env reference from the process environment first", async () => {
		const fixture = await setup();
		await writeFile(fixture.zshrcPath, `export ${ENV_NAME}=${SECRETS.zshrc}\n`);
		await writeFile(fixture.dotenvPath, `${ENV_NAME}=${SECRETS.dotenv}\n`);
		const provider = byName(readOmpProviders(inputs(fixture)), ENV_PROVIDER);

		expect(resolveOmpProviderKey(inputs(fixture, { [ENV_NAME]: SECRETS.env }), provider)).toEqual({
			value: SECRETS.env,
			from: "env",
		});
	});

	it("falls back to shell profile files, then the omp .env, in order", async () => {
		const fixture = await setup();
		await writeFile(fixture.zshrcPath, `export ${ENV_NAME}=${SECRETS.zshrc}\n`);
		await writeFile(fixture.dotenvPath, `${ENV_NAME}=${SECRETS.dotenv}\n`);
		const provider = byName(readOmpProviders(inputs(fixture)), ENV_PROVIDER);

		expect(resolveOmpProviderKey(inputs(fixture), provider)).toEqual({ value: SECRETS.zshrc, from: fixture.zshrcPath });

		await rm(fixture.zshrcPath, { force: true });
		expect(resolveOmpProviderKey(inputs(fixture), provider)).toEqual({ value: SECRETS.dotenv, from: fixture.dotenvPath });
	});

	it("reads a fish `set -gx` line from config.fish", async () => {
		const fixture = await setup();
		const fishDir = join(fixture.homeDir, ".config", "fish");
		await mkdir(fishDir, { recursive: true });
		const fishPath = join(fishDir, "config.fish");
		await writeFile(fishPath, `set -gx ${ENV_NAME} ${SECRETS.zshrc}\n`);
		const provider = byName(readOmpProviders(inputs(fixture)), ENV_PROVIDER);
		expect(resolveOmpProviderKey(inputs(fixture), provider)).toEqual({ value: SECRETS.zshrc, from: fishPath });
	});

	it("resolves a ${NAME} reference and a literal key", async () => {
		const fixture = await setup();
		const providers = readOmpProviders(inputs(fixture));
		expect(resolveOmpProviderKey(inputs(fixture, { BRACED_API_KEY: SECRETS.braced }), byName(providers, BRACED_PROVIDER))).toEqual({
			value: SECRETS.braced,
			from: "env",
		});
		expect(resolveOmpProviderKey(inputs(fixture), byName(providers, LITERAL_PROVIDER))).toEqual({
			value: SECRETS.literal,
			from: fixture.modelsPath,
		});
	});

	it("returns null for a command key, a keyless provider, and an unresolved env name", async () => {
		const fixture = await setup();
		const providers = readOmpProviders(inputs(fixture));
		expect(resolveOmpProviderKey(inputs(fixture), byName(providers, COMMAND_PROVIDER))).toBeNull();
		expect(resolveOmpProviderKey(inputs(fixture), byName(providers, KEYLESS_PROVIDER))).toBeNull();
		expect(resolveOmpProviderKey(inputs(fixture), byName(providers, ENV_PROVIDER))).toBeNull();
	});
});

describe("readOmpApiKeys", () => {
	it("reads api_key rows and flags the disabled ones", async () => {
		const fixture = await setup();
		const keys = readOmpApiKeys(inputs(fixture));
		expect(keys).toEqual(
			expect.arrayContaining([
				{ provider: ENV_PROVIDER, value: SECRETS.db, disabled: false },
				{ provider: "disabled-provider", value: SECRETS.disabled, disabled: true },
			]),
		);
	});

	it("returns an empty list when the database is missing or cannot be opened", async () => {
		const fixture = await setup({ db: false });
		expect(readOmpApiKeys(inputs(fixture))).toEqual([]);
		const throwing: OmpInputs = { ...inputs(fixture), openDb: () => null };
		expect(readOmpApiKeys(throwing)).toEqual([]);
	});
});

describe("listOmpOauth", () => {
	it("lists oauth rows with their disabled flag", async () => {
		const fixture = await setup();
		expect(listOmpOauth(inputs(fixture))).toEqual(
			expect.arrayContaining([
				{ provider: "oauth-provider", disabled: false },
				{ provider: "oauth-disabled", disabled: true },
			]),
		);
	});

	it("returns an empty list when the database cannot be opened", async () => {
		const fixture = await setup({ db: false });
		expect(listOmpOauth(inputs(fixture))).toEqual([]);
	});

	it("treats any value starting with ! as a command, the way pi and omp read apiKey, and never as a key", async () => {
		const fixture = await setup({
			modelsYml: [
				"providers:",
				"  pass:",
				"    baseUrl: https://a.example.test/v1",
				"    api: openai-completions",
				'    apiKey: "!pass show some-key"',
				"    models: [{ id: m, name: M }]",
				"  op:",
				"    baseUrl: https://b.example.test/v1",
				"    api: openai-completions",
				'    apiKey: "!op read op://vault/item/key"',
				"    models: [{ id: m, name: M }]",
				"  escaped:",
				"    baseUrl: https://c.example.test/v1",
				"    api: openai-completions",
				'    apiKey: "$!literal-bang-key-0123456789"',
				"    models: [{ id: m, name: M }]",
				"",
			].join("\n"),
		});
		const providers = readOmpProviders(inputs(fixture));
		expect(Object.fromEntries(providers.map((provider) => [provider.name, provider.keyKind]))).toEqual({ pass: "command", op: "command", escaped: "literal" });
		const pass = providers.find((provider) => provider.name === "pass");
		expect(pass && resolveOmpProviderKey(inputs(fixture), pass)).toBeNull();
		expect(JSON.stringify(providers)).not.toContain("some-key");
	});
});
