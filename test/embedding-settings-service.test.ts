import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAutoRagConfigService } from "../src/main/autorag-config-service";
import { createDataSourceStatusService } from "../src/main/datasource-status";
import { createEmbeddingSettingsService } from "../src/main/embedding-settings-service";
import type { ProviderCredentialService } from "../src/main/provider-credentials";
import type { DataSourceSyncResult } from "../src/shared/settings-contract";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface Fixture {
	readonly root: string;
	readonly configPath: string;
	readonly env: NodeJS.ProcessEnv;
	readonly synced: string[];
}

async function createFixture(datasources: Record<string, unknown>): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "autorag-embedding-"));
	directories.push(root);
	const configPath = join(root, "config.json");
	await writeFile(
		configPath,
		`${JSON.stringify(
			{
				searchPaths: [root],
				workspacePath: root,
				memoryPath: join(root, "memory.json"),
				datasources,
				customSection: { keep: true },
			},
			null,
			2,
		)}\n`,
	);
	return { root, configPath, env: { HOME: root, AUTORAG_CONFIG: configPath, PI_CODING_AGENT_DIR: join(root, "pi-agent") }, synced: [] };
}

/** A credential store that records what the service stored, and puts it in the env like the real one. */
function fakeCredentials(env: NodeJS.ProcessEnv): { readonly service: ProviderCredentialService; readonly stored: Record<string, string> } {
	const stored: Record<string, string> = {};
	const service: ProviderCredentialService = {
		list: async (envNames) => [...new Set([...(envNames ?? []), ...Object.keys(stored)])].map((envName) => ({ envName, stored: stored[envName] !== undefined, source: stored[envName] !== undefined ? ("stored" as const) : ("none" as const) })),
		set: async (envName, secret) => {
			stored[envName] = secret;
			env[envName] = secret;
			return [];
		},
		remove: async (envName) => {
			delete stored[envName];
			delete env[envName];
			return [];
		},
		load: async () => [],
	};
	return { service, stored };
}

function buildService(fixture: Fixture, fetchImpl?: typeof fetch) {
	const config = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });
	const real = createDataSourceStatusService({ env: fixture.env, cwd: fixture.root });
	const dataSources = {
		...real,
		sync: async (id: string): Promise<DataSourceSyncResult> => {
			fixture.synced.push(id);
			return { id, ok: true, state: "indexed", chunkCount: 3, indexedAt: "2026-01-01T00:00:00.000Z", durationMs: 5, diagnostics: [], error: null };
		},
	};
	const credentials = fakeCredentials(fixture.env);
	const embedding = createEmbeddingSettingsService({
		env: fixture.env,
		cwd: fixture.root,
		config,
		dataSources,
		credentials: credentials.service,
		...(fetchImpl === undefined ? {} : { fetchImpl }),
	});
	return { embedding, credentials };
}

async function readConfig(fixture: Fixture): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(fixture.configPath, "utf8")) as Record<string, unknown>;
}

/** What the embedding service wrote into the fixture's `mail` datasource connector, if anything. */
function mailConnector(config: Record<string, unknown>): Record<string, unknown> | undefined {
	const datasources = config.datasources as Record<string, { connector?: Record<string, unknown> }> | undefined;
	return datasources?.mail?.connector;
}

const QWEN3_DIMENSION = 1024;

function vectorResponse(dimension: number): Response {
	return new Response(
		JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: Array.from({ length: dimension }, (_, i) => i / dimension) }] }),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

/** A fetch that answers an OpenAI route with `dimension`-sized vectors and records every call. */
function openAiServer(dimension: number = QWEN3_DIMENSION): { readonly fetchImpl: typeof fetch; readonly calls: { readonly url: string; readonly authorization: string | null; readonly body: { readonly model?: string; readonly input?: readonly string[]; readonly inputs?: readonly string[] } }[] } {
	const calls: { url: string; authorization: string | null; body: { model?: string; input?: string[]; inputs?: string[] } }[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
		return vectorResponse(dimension);
	};
	return { fetchImpl, calls };
}

function signedIn(fixture: Fixture, token = "dazzi-plan-token"): void {
	const dir = join(fixture.root, "pi-agent");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "auth.json"), JSON.stringify({ dazzi: { type: "oauth", access: token, refresh: "", expires: 9_999_999_999_999 } }));
}

const BYOK = { baseUrl: "https://embed.example.com", protocol: "openai" } as const;

describe("createEmbeddingSettingsService", () => {
	it("offers keyword-only, the local server, Dazzi cloud and the user's own server, and nothing else", async () => {
		const fixture = await createFixture({});
		const { embedding } = buildService(fixture);

		const profiles = (await embedding.get()).profiles;

		expect(profiles.map((profile) => [profile.id, profile.kind])).toEqual([["none", "none"], ["local", "local"], ["dazzi", "dazzi"], ["byok", "byok"]]);
		// The model is not a choice: every profile that embeds is Qwen3-Embedding-0.6B at 1024 dimensions.
		expect(profiles.filter((profile) => profile.kind !== "none").map((profile) => profile.dimension)).toEqual([QWEN3_DIMENSION, QWEN3_DIMENSION, QWEN3_DIMENSION]);
		expect(profiles.find((profile) => profile.id === "byok")?.model).toBe("Qwen/Qwen3-Embedding-0.6B");
	});

	it("applies the local server: writes the native Qwen3 id, rebuilds the sources that embed, and writes nothing into mailcrawl", async () => {
		const fixture = await createFixture({
			mail: { type: "mailcrawl", connector: {} },
			vault: { type: "obsidian", connector: { vaultPath: fixtureRootPlaceholder() } },
			news: { type: "rss", connector: { feeds: [{ url: "https://example.com/feed.xml" }] } },
		});
		const { embedding } = buildService(fixture);

		const result = await embedding.apply({ profileId: "local" });

		expect(result).toMatchObject({ ok: true, applied: true, incompatibilities: [] });
		const config = await readConfig(fixture);
		expect(config.minSync).toMatchObject({ embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: QWEN3_DIMENSION } });
		expect(config.customSection).toEqual({ keep: true });
		expect(mailConnector(config)?.env).toBeUndefined();
		expect(fixture.synced.sort()).toEqual(["mail", "vault"]);
		expect(fixture.env.QMD_EMBED_MODEL).toContain("Qwen3-Embedding-0.6B");
	});

	it("applies Dazzi cloud: needs a signed-in account and consent, probes the hosted route, and stores the plan key as the embedding key", async () => {
		const fixture = await createFixture({ mail: { type: "mailcrawl", connector: {} } });
		const server = openAiServer();
		const { embedding, credentials } = buildService(fixture, server.fetchImpl);

		const signedOut = await embedding.apply({ profileId: "dazzi", acknowledgeRemote: true });
		expect(signedOut).toMatchObject({ ok: false, applied: false });
		expect(signedOut.error).toMatch(/Dazzi|로그인|sign/i);
		expect((await readConfig(fixture)).minSync).toBeUndefined();

		signedIn(fixture);
		const unconsented = await embedding.apply({ profileId: "dazzi" });
		expect(unconsented).toMatchObject({ ok: false, applied: false });
		expect(server.calls).toEqual([]);
		expect((await readConfig(fixture)).minSync).toBeUndefined();

		const applied = await embedding.apply({ profileId: "dazzi", acknowledgeRemote: true });

		expect(applied).toMatchObject({ ok: true, applied: true });
		expect(server.calls[0]).toMatchObject({ url: "https://api.dazziapp.com/v1/embeddings", authorization: "Bearer dazzi-plan-token", body: { model: "qwen/qwen3-embedding-0.6b" } });
		expect((await readConfig(fixture)).minSync).toMatchObject({ embedder: { id: "openai:qwen/qwen3-embedding-0.6b", baseUrl: "https://api.dazziapp.com", dimension: QWEN3_DIMENSION, apiKeyEnv: "OPENAI_API_KEY" } });
		expect(credentials.stored.OPENAI_API_KEY).toBe("dazzi-plan-token");
		expect(fixture.synced).toEqual(["mail"]);
	});

	it("applies the user's own OpenAI-compatible server: keeps the key out of the config, in the keyring", async () => {
		const fixture = await createFixture({ mail: { type: "mailcrawl", connector: {} } });
		const server = openAiServer();
		const { embedding, credentials } = buildService(fixture, server.fetchImpl);

		const result = await embedding.apply({ profileId: "byok", byok: { ...BYOK, apiKey: "sk-user-key" }, acknowledgeRemote: true });

		expect(result).toMatchObject({ ok: true, applied: true });
		expect(server.calls[0]).toMatchObject({ url: "https://embed.example.com/v1/embeddings", authorization: "Bearer sk-user-key", body: { model: "Qwen/Qwen3-Embedding-0.6B" } });
		const text = await readFile(fixture.configPath, "utf8");
		expect(text).not.toContain("sk-user-key");
		expect(JSON.parse(text).minSync.embedder).toEqual({ id: "openai:Qwen/Qwen3-Embedding-0.6B", baseUrl: "https://embed.example.com", dimension: QWEN3_DIMENSION, apiKeyEnv: "AUTORAG_EMBEDDING_API_KEY" });
		expect(credentials.stored.AUTORAG_EMBEDDING_API_KEY).toBe("sk-user-key");
		expect(fixture.synced).toEqual(["mail"]);
	});

	it("applies the user's own TEI server over its /embed route", async () => {
		const fixture = await createFixture({});
		const server = openAiServer();
		const teiFetch: typeof fetch = async (input, init) => {
			server.calls.push({ url: String(input), authorization: null, body: JSON.parse(String(init?.body)) });
			return new Response(JSON.stringify([Array.from({ length: QWEN3_DIMENSION }, () => 0.1)]), { status: 200 });
		};
		const { embedding } = buildService(fixture, teiFetch);

		const result = await embedding.apply({ profileId: "byok", byok: { baseUrl: "http://127.0.0.1:8080", protocol: "tei" } });

		expect(result.ok).toBe(true);
		expect(server.calls[0]).toMatchObject({ url: "http://127.0.0.1:8080/embed", body: { inputs: ["ping"] } });
		expect((await readConfig(fixture)).minSync).toMatchObject({ embedder: { id: "tei:Qwen/Qwen3-Embedding-0.6B", baseUrl: "http://127.0.0.1:8080", dimension: QWEN3_DIMENSION } });
	});

	it("needs consent before document text goes to a server off this computer, but not for a loopback server", async () => {
		const fixture = await createFixture({});
		const server = openAiServer();
		const { embedding } = buildService(fixture, server.fetchImpl);

		const remote = await embedding.apply({ profileId: "byok", byok: { ...BYOK, apiKey: "k" } });
		expect(remote).toMatchObject({ ok: false, applied: false });
		expect(server.calls).toEqual([]);
		expect((await readConfig(fixture)).minSync).toBeUndefined();

		const loopback = await embedding.apply({ profileId: "byok", byok: { baseUrl: "http://127.0.0.1:11434", protocol: "openai" } });
		expect(loopback).toMatchObject({ ok: true, applied: true });
	});

	it("rejects a server that does not return Qwen3-sized vectors, and never writes a half state or stores a key", async () => {
		const fixture = await createFixture({});
		const server = openAiServer(768);
		const { embedding, credentials } = buildService(fixture, server.fetchImpl);

		const result = await embedding.apply({ profileId: "byok", byok: { ...BYOK, apiKey: "sk-user-key" }, acknowledgeRemote: true });

		expect(result).toMatchObject({ ok: false, applied: false });
		expect(result.error).toContain("768");
		expect((await readConfig(fixture)).minSync).toBeUndefined();
		expect(credentials.stored).toEqual({});
	});

	it("rejects a server that is unreachable, a bad URL, a non-http URL and a missing server", async () => {
		const fixture = await createFixture({});
		const down: typeof fetch = async () => {
			throw new Error("connect ECONNREFUSED");
		};
		const { embedding } = buildService(fixture, down);

		expect((await embedding.apply({ profileId: "byok", byok: { baseUrl: "http://127.0.0.1:9", protocol: "openai" } })).error).toContain("ECONNREFUSED");
		expect((await embedding.apply({ profileId: "byok", byok: { baseUrl: "not a url", protocol: "openai" } })).applied).toBe(false);
		expect((await embedding.apply({ profileId: "byok", byok: { baseUrl: "ftp://example.com", protocol: "openai" } })).applied).toBe(false);
		expect((await embedding.apply({ profileId: "byok" })).applied).toBe(false);
		expect((await readConfig(fixture)).minSync).toBeUndefined();
	});

	it("keeps the stored key when the user switches servers without typing one again", async () => {
		const fixture = await createFixture({});
		const server = openAiServer();
		const { embedding, credentials } = buildService(fixture, server.fetchImpl);
		await embedding.apply({ profileId: "byok", byok: { ...BYOK, apiKey: "sk-first" }, acknowledgeRemote: true });

		const second = await embedding.apply({ profileId: "byok", byok: { baseUrl: "https://other.example.com", protocol: "openai" }, acknowledgeRemote: true });

		expect(second.ok).toBe(true);
		expect(server.calls.at(-1)?.authorization).toBe("Bearer sk-first");
		expect(credentials.stored.AUTORAG_EMBEDDING_API_KEY).toBe("sk-first");
	});

	it("drops the stored embedding key and the Dazzi plan key when switching back to the local server", async () => {
		const fixture = await createFixture({});
		signedIn(fixture);
		const server = openAiServer();
		const { embedding, credentials } = buildService(fixture, server.fetchImpl);
		await embedding.apply({ profileId: "dazzi", acknowledgeRemote: true });
		await embedding.apply({ profileId: "byok", byok: { ...BYOK, apiKey: "sk-user-key" }, acknowledgeRemote: true });

		const local = await embedding.apply({ profileId: "local" });

		expect(local.ok).toBe(true);
		expect(credentials.stored).toEqual({});
		expect((await readConfig(fixture)).minSync).toMatchObject({ embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B" } });
		expect(((await readConfig(fixture)).minSync as { embedder: Record<string, unknown> }).embedder.baseUrl).toBeUndefined();
	});

	it("never removes a key the user set in their own environment", async () => {
		const fixture = await createFixture({});
		fixture.env.OPENAI_API_KEY = "sk-from-the-shell";
		const { embedding, credentials } = buildService(fixture);

		await embedding.apply({ profileId: "local" });

		expect(fixture.env.OPENAI_API_KEY).toBe("sk-from-the-shell");
		expect(credentials.stored).toEqual({});
	});

	it("applies keyword-only without blocking on sources that cannot adopt a model, keeps the configured embedder, and rebuilds nothing", async () => {
		const fixture = await createFixture({ chat: { type: "discord", connector: {} }, mail: { type: "mailcrawl", connector: {} } });
		const raw = await readConfig(fixture);
		await writeFile(fixture.configPath, JSON.stringify({ ...raw, minSync: { embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: QWEN3_DIMENSION } } }));
		fixture.env.QMD_EMBED_MODEL = "hf:old";
		const { embedding } = buildService(fixture);

		const result = await embedding.apply({ profileId: "none" });

		expect(result).toMatchObject({ ok: true, applied: true, incompatibilities: [], rebuilds: [] });
		const config = await readConfig(fixture);
		expect(config.appIndexing).toEqual({ semanticSearch: false });
		expect(config.minSync).toEqual({ embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: QWEN3_DIMENSION } });
		expect(fixture.synced).toEqual([]);
		expect(fixture.env.QMD_EMBED_MODEL).toBeUndefined();
	});

	it("switches semantic search back on when a model is chosen after keyword-only", async () => {
		const fixture = await createFixture({ mail: { type: "mailcrawl", connector: {} } });
		const { embedding } = buildService(fixture);
		await embedding.apply({ profileId: "none" });

		const result = await embedding.apply({ profileId: "local" });

		expect(result.ok).toBe(true);
		expect((await readConfig(fixture)).appIndexing).toBeUndefined();
		expect(fixture.synced).toEqual(["mail"]);
	});

	it("blocks a change when an enabled datasource cannot follow the server, and does not write, unless acknowledged", async () => {
		const fixture = await createFixture({ vault: { type: "obsidian", connector: { vaultPath: fixtureRootPlaceholder() } } });
		const server = openAiServer();
		const { embedding } = buildService(fixture, server.fetchImpl);
		const request = { profileId: "byok", byok: { baseUrl: "http://127.0.0.1:11434", protocol: "openai" as const } };

		const blocked = await embedding.apply(request);

		expect(blocked).toMatchObject({ ok: false, applied: false });
		expect(blocked.incompatibilities.map((status) => status.id)).toEqual(["vault"]);
		expect((await readConfig(fixture)).minSync).toBeUndefined();

		const forced = await embedding.apply({ ...request, acknowledgeIncompatible: true });
		expect(forced).toMatchObject({ ok: true, applied: true });
		expect(fixture.synced).toEqual([]);
	});

	it("rejects retired and unknown profile ids", async () => {
		const fixture = await createFixture({});
		const { embedding } = buildService(fixture);

		for (const retired of ["native-qwen3", "local-server", "embeddinggemma-300m", "qwen3-embedding-0.6b"]) {
			const result = await embedding.apply({ profileId: retired });
			expect(result.ok).toBe(false);
			expect(result.error).toContain(retired);
		}
		expect((await readConfig(fixture)).minSync).toBeUndefined();
	});

	it("reports which profile is current for each way the config can look, and which sources follow it", async () => {
		const fixture = await createFixture({
			mail: { type: "mailcrawl", connector: {} },
			chat: { type: "discord", connector: {} },
			talk: { type: "kakao", connector: {} },
			vault: { type: "obsidian", connector: { vaultPath: fixtureRootPlaceholder() } },
			news: { type: "rss", connector: { feeds: [{ url: "https://example.com/feed.xml" }] } },
		});
		const { embedding } = buildService(fixture, openAiServer().fetchImpl);
		const currentAfter = async (embedder: Record<string, unknown> | null) => {
			const raw = await readConfig(fixture);
			await writeFile(fixture.configPath, JSON.stringify({ ...raw, minSync: embedder === null ? undefined : { embedder } }));
			return (await embedding.get()).current.profileId;
		};

		expect(await currentAfter(null)).toBeNull();
		expect(await currentAfter({ id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: QWEN3_DIMENSION })).toBe("local");
		expect(await currentAfter({ profile: "qwen3-embedding-0.6b", dimension: QWEN3_DIMENSION })).toBe("local");
		expect(await currentAfter({ id: "openai:qwen/qwen3-embedding-0.6b", baseUrl: "https://api.dazziapp.com", dimension: QWEN3_DIMENSION, apiKeyEnv: "OPENAI_API_KEY" })).toBe("dazzi");
		expect(await currentAfter({ id: "openai:Qwen/Qwen3-Embedding-0.6B", baseUrl: "https://embed.example.com", dimension: QWEN3_DIMENSION })).toBe("byok");
		expect(await currentAfter({ id: "bge-m3", baseUrl: "http://127.0.0.1:11434", dimension: 1024 })).toBe("byok");

		const adoption = Object.fromEntries((await embedding.get()).sources.map((source) => [source.id, source.adoption]));
		expect(adoption).toEqual({ mail: "native", chat: "propagated", talk: "native", vault: "incompatible", news: "not-applicable" });
	});
});

/** The obsidian connector requires a vaultPath; the fixture root is created lazily, so reuse tmpdir. */
function fixtureRootPlaceholder(): string {
	return join(tmpdir(), "autorag-embedding-vault");
}
