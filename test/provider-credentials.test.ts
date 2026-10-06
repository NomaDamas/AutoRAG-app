import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProviderCredentialService, type SafeStorageLike } from "../src/main/provider-credentials";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function fakeSafeStorage(available = true, backend?: string): SafeStorageLike {
	return {
		isEncryptionAvailable: () => available,
		encryptString: (plainText) => Buffer.from(`enc:${plainText}`),
		decryptString: (encrypted) => encrypted.toString("utf8").replace(/^enc:/u, ""),
		...(backend === undefined ? {} : { getSelectedStorageBackend: () => backend }),
	};
}

async function createFixture(available = true, backend?: string): Promise<{ filePath: string; safeStorage: SafeStorageLike; env: NodeJS.ProcessEnv }> {
	const root = await mkdtemp(join(tmpdir(), "autorag-credentials-"));
	directories.push(root);
	return { filePath: join(root, "credentials.enc.json"), safeStorage: fakeSafeStorage(available, backend), env: {} };
}

describe("createProviderCredentialService", () => {
	it("stores the secret encrypted at rest and never returns it", async () => {
		const fixture = await createFixture();
		const service = createProviderCredentialService(fixture);

		const status = service.set("OPENROUTER_API_KEY", "top-secret");

		expect(status).toEqual([{ envName: "OPENROUTER_API_KEY", stored: true, source: "stored" }]);
		expect(fixture.env.OPENROUTER_API_KEY).toBe("top-secret");
		expect(await readFile(fixture.filePath, "utf8")).not.toContain("top-secret");
		expect(JSON.stringify(status)).not.toContain("top-secret");
	});

	it("loads stored credentials into a fresh environment", async () => {
		const fixture = await createFixture();
		createProviderCredentialService(fixture).set("OPENROUTER_API_KEY", "top-secret");

		const freshEnv: NodeJS.ProcessEnv = {};
		const reloaded = createProviderCredentialService({ ...fixture, env: freshEnv });
		const applied = reloaded.load();

		expect(applied).toEqual(["OPENROUTER_API_KEY"]);
		expect(freshEnv.OPENROUTER_API_KEY).toBe("top-secret");
	});

	it("load never overrides an ambient env value", async () => {
		const fixture = await createFixture();
		createProviderCredentialService(fixture).set("ANTHROPIC_API_KEY", "stored");
		const external: NodeJS.ProcessEnv = { OPENAI_API_KEY: "external", ANTHROPIC_API_KEY: "external-anthropic" };

		const applied = createProviderCredentialService({ ...fixture, env: external }).load();

		expect(applied).toEqual([]);
		expect(external.OPENAI_API_KEY).toBe("external");
		expect(external.ANTHROPIC_API_KEY).toBe("external-anthropic");
	});

	it("explicit save may override and remove restores the original external value", async () => {
		const fixture = await createFixture();
		const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "external", UNRELATED_KEY: "keep" };
		const service = createProviderCredentialService({ ...fixture, env });
		service.set("OPENAI_API_KEY", "stored");
		expect(env.OPENAI_API_KEY).toBe("stored");

		const status = service.remove("OPENAI_API_KEY");

		expect(status).toEqual([{ envName: "OPENAI_API_KEY", stored: false, source: "env" }]);
		expect(env.OPENAI_API_KEY).toBe("external");
		expect(env.UNRELATED_KEY).toBe("keep");
	});

	it("refuses to store when the OS backend is insecure basic_text", async () => {
		const fixture = await createFixture(true, "basic_text");
		const service = createProviderCredentialService(fixture);

		expect(() => service.set("OPENROUTER_API_KEY", "top-secret")).toThrow(/secure keyring/);
	});

	it("refuses to touch a malformed credential store", async () => {
		const fixture = await createFixture();
		await writeFile(fixture.filePath, "{not json");
		const service = createProviderCredentialService(fixture);

		expect(() => service.list()).toThrow(/refusing to overwrite/);
		expect(() => service.set("OPENROUTER_API_KEY", "top-secret")).toThrow(/refusing to overwrite/);
		expect(await readFile(fixture.filePath, "utf8")).toBe("{not json");
	});

	it("refuses to store when OS encryption is unavailable", async () => {
		const fixture = await createFixture(false);
		const service = createProviderCredentialService(fixture);

		expect(() => service.set("OPENROUTER_API_KEY", "top-secret")).toThrow(/encryption is unavailable/);
		expect(fixture.env.OPENROUTER_API_KEY).toBeUndefined();
	});

	it("rejects invalid env names and empty secrets", async () => {
		const fixture = await createFixture();
		const service = createProviderCredentialService(fixture);

		expect(() => service.set("not a name", "x")).toThrow(/Invalid environment variable name/);
		expect(() => service.set("OPENROUTER_API_KEY", "")).toThrow(/must not be empty/);
	});

	it("reports the ambient env source when a stored value is never applied", async () => {
		const fixture = await createFixture();
		createProviderCredentialService(fixture).set("OPENROUTER_API_KEY", "stored");
		const env: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: "ambient" };
		const service = createProviderCredentialService({ ...fixture, env });

		expect(service.load()).toEqual([]);
		expect(service.list(["OPENROUTER_API_KEY"])).toEqual([{ envName: "OPENROUTER_API_KEY", stored: true, source: "env" }]);
		expect(env.OPENROUTER_API_KEY).toBe("ambient");
	});

	it("reports none for a stored value whose decryption fails", async () => {
		const fixture = await createFixture();
		await writeFile(
			fixture.filePath,
			`${JSON.stringify({ version: 1, entries: { OPENROUTER_API_KEY: Buffer.from("ciphertext").toString("base64") } }, null, 2)}\n`,
		);
		const service = createProviderCredentialService({
			...fixture,
			safeStorage: {
				...fixture.safeStorage,
				decryptString: () => {
					throw new Error("cannot decrypt");
				},
			},
		});

		expect(service.load()).toEqual([]);
		expect(service.list(["OPENROUTER_API_KEY"])).toEqual([{ envName: "OPENROUTER_API_KEY", stored: true, source: "none" }]);
	});

	it("refuses an unsupported credential store version instead of silently accepting it", async () => {
		const fixture = await createFixture();
		await writeFile(fixture.filePath, `${JSON.stringify({ version: 2, entries: {} }, null, 2)}\n`);
		const service = createProviderCredentialService(fixture);

		expect(() => service.list()).toThrow(/version is not supported/);
		expect(await readFile(fixture.filePath, "utf8")).toContain('"version": 2');
	});
});
