import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAutoRagConfigService } from "../src/main/autorag-config-service";
import { createDataSourceStatusService } from "../src/main/datasource-status";
import { createEmbeddingSettingsService } from "../src/main/embedding-settings-service";
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
	return { root, configPath, env: { HOME: root, AUTORAG_CONFIG: configPath }, synced: [] };
}

function buildService(fixture: Fixture, fetchImpl?: typeof fetch) {
	const config = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });
	const real = createDataSourceStatusService({ env: fixture.env, cwd: fixture.root });
	const dataSources = {
		...real,
		sync: async (id: string): Promise<DataSourceSyncResult> => {
			fixture.synced.push(id);
			return {
				id,
				ok: true,
				state: "indexed",
				chunkCount: 3,
				indexedAt: "2026-01-01T00:00:00.000Z",
				durationMs: 5,
				diagnostics: [],
				error: null,
			};
		},
	};
	const embedding = createEmbeddingSettingsService({
		env: fixture.env,
		cwd: fixture.root,
		config,
		dataSources,
		...(fetchImpl === undefined ? {} : { fetchImpl }),
	});
	return { embedding };
}

async function readConfig(fixture: Fixture): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(fixture.configPath, "utf8")) as Record<string, unknown>;
}

/** What the embedding service wrote into the fixture's `mail` datasource connector, if anything. */
function mailConnector(config: Record<string, unknown>): Record<string, unknown> | undefined {
	const datasources = config.datasources as Record<string, { connector?: Record<string, unknown> }> | undefined;
	return datasources?.mail?.connector;
}

function vectorResponse(dimension: number): Response {
	return new Response(
		JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: Array.from({ length: dimension }, (_, i) => i / dimension) }] }),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("createEmbeddingSettingsService", () => {
	it("propagates a native-qwen3 change to minSync and every reachable datasource while preserving unknown config", async () => {
		const fixture = await createFixture({
			mail: { type: "mailcrawl", connector: {} },
			vault: { type: "obsidian", connector: { vaultPath: fixtureRootPlaceholder() } },
			news: { type: "rss", connector: { feeds: [{ url: "https://example.com/feed.xml" }] } },
		});
		const { embedding } = buildService(fixture);

		const result = await embedding.apply({ profileId: "native-qwen3" });

		expect(result.ok).toBe(true);
		expect(result.applied).toBe(true);
		expect(result.incompatibilities).toEqual([]);
		const config = await readConfig(fixture);
		expect(config.minSync).toMatchObject({ embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } });
		expect(config.customSection).toEqual({ keep: true });
		// mailcrawl reads the shared endpoint when it indexes; nothing is written into its environment.
		expect(mailConnector(config)?.env).toBeUndefined();
		// rss keeps its own lexical index; only embedding sources reindex.
		expect(fixture.synced.sort()).toEqual(["mail", "vault"]);
		expect(result.rebuilds.map((rebuild) => rebuild.id).sort()).toEqual(["mail", "vault"]);
	});

	it("offers keyword-only search as a profile, and reports it as current once the config switched semantic search off", async () => {
		const fixture = await createFixture({ chat: { type: "discord", connector: {} } });
		const { embedding } = buildService(fixture);
		expect((await embedding.get()).profiles.map((profile) => profile.id)).toEqual(["none", "native-qwen3", "local-server"]);
		expect((await embedding.get()).current.profileId).toBeNull();

		await embedding.apply({ profileId: "none" });

		const snapshot = await embedding.get();
		expect(snapshot.current.profileId).toBe("none");
		expect(snapshot.sources.map((source) => source.adoption)).toEqual(["not-applicable"]);
	});

	it("applies keyword-only without blocking on sources that cannot adopt a model, keeps the configured embedder, and rebuilds nothing", async () => {
		const fixture = await createFixture({ chat: { type: "discord", connector: {} }, mail: { type: "mailcrawl", connector: {} } });
		const raw = await readConfig(fixture);
		await writeFile(fixture.configPath, JSON.stringify({ ...raw, minSync: { embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } } }));
		fixture.env.QMD_EMBED_MODEL = "hf:old";
		const { embedding } = buildService(fixture);

		const result = await embedding.apply({ profileId: "none" });

		expect(result).toMatchObject({ ok: true, applied: true, incompatibilities: [], rebuilds: [] });
		const config = await readConfig(fixture);
		expect(config.appIndexing).toEqual({ semanticSearch: false });
		expect(config.minSync).toEqual({ embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } });
		expect(config.customSection).toEqual({ keep: true });
		expect(fixture.synced).toEqual([]);
		expect(fixture.env.QMD_EMBED_MODEL).toBeUndefined();
	});

	it("switches semantic search back on when a model is chosen after keyword-only, and rebuilds the sources that embed", async () => {
		const fixture = await createFixture({ mail: { type: "mailcrawl", connector: {} } });
		const { embedding } = buildService(fixture);
		await embedding.apply({ profileId: "none" });

		const result = await embedding.apply({ profileId: "native-qwen3" });

		expect(result.ok).toBe(true);
		const config = await readConfig(fixture);
		expect(config.appIndexing).toBeUndefined();
		expect(config.minSync).toMatchObject({ embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B" } });
		expect(fixture.synced).toEqual(["mail"]);
	});

	it("sets the qmd process env for the local model, and never writes embedding overrides into mailcrawl", async () => {
		const fixture = await createFixture({
			mail: { type: "mailcrawl", connector: {} },
			vault: { type: "obsidian", connector: { vaultPath: fixtureRootPlaceholder() } },
		});
		const { embedding } = buildService(fixture);

		await embedding.apply({ profileId: "native-qwen3" });

		const config = await readConfig(fixture);
		expect(config.minSync).toMatchObject({ embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } });
		expect(mailConnector(config)?.env).toBeUndefined();
		expect(fixture.env.QMD_EMBED_MODEL).toContain("Qwen3-Embedding-0.6B");
	});

	it("blocks a change when an enabled datasource cannot adopt the model, and does not write", async () => {
		const fixture = await createFixture({ vault: { type: "obsidian", connector: { vaultPath: fixtureRootPlaceholder() } } });
		const fetchImpl = vi.fn(async () => vectorResponse(1024)) as unknown as typeof fetch;
		const { embedding } = buildService(fixture, fetchImpl);
		const request = { profileId: "local-server", localServer: { id: "bge-m3", baseUrl: "http://127.0.0.1:11434", dimension: 1024 } };

		const blocked = await embedding.apply(request);

		expect(blocked.ok).toBe(false);
		expect(blocked.applied).toBe(false);
		expect(blocked.incompatibilities.map((status) => status.id)).toEqual(["vault"]);
		expect((await readConfig(fixture)).minSync).toBeUndefined();

		const forced = await embedding.apply({ ...request, acknowledgeIncompatible: true });
		expect(forced.ok).toBe(true);
		expect(forced.applied).toBe(true);
		expect(forced.incompatibilities.map((status) => status.id)).toEqual(["vault"]);
		expect(fixture.synced).toEqual([]);
	});

	it("probes a local server for real vectors, writes it as the embedder, and lets mailcrawl and the chat sources follow it", async () => {
		const fixture = await createFixture({ mail: { type: "mailcrawl", connector: {} }, chat: { type: "discord", connector: {} }, talk: { type: "telegram", connector: {} } });
		const fetchImpl = vi.fn(async () => vectorResponse(1024)) as unknown as typeof fetch;
		const { embedding } = buildService(fixture, fetchImpl);

		const result = await embedding.apply({
			profileId: "local-server",
			localServer: { id: "bge-m3", baseUrl: "http://127.0.0.1:11434", dimension: 1024 },
		});

		expect(result.ok).toBe(true);
		const config = await readConfig(fixture);
		expect(config.minSync).toMatchObject({ embedder: { id: "bge-m3", baseUrl: "http://127.0.0.1:11434", dimension: 1024 } });
		expect(mailConnector(config)?.env).toBeUndefined();
		expect(fixture.synced.sort()).toEqual(["chat", "mail", "talk"]);
	});

	it("rejects a local server whose real dimension differs, and never writes a half state", async () => {
		const fixture = await createFixture({ mail: { type: "mailcrawl", connector: {} } });
		const fetchImpl = vi.fn(async () => vectorResponse(768)) as unknown as typeof fetch;
		const { embedding } = buildService(fixture, fetchImpl);

		const result = await embedding.apply({
			profileId: "local-server",
			localServer: { id: "bge-m3", baseUrl: "http://127.0.0.1:11434", dimension: 1024 },
		});

		expect(result.ok).toBe(false);
		expect(result.error).toContain("차원");
		expect((await readConfig(fixture)).minSync).toBeUndefined();
	});

	it("refuses a non-loopback embedding server before probing", async () => {
		const fixture = await createFixture({});
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		const { embedding } = buildService(fixture, fetchImpl);

		const result = await embedding.apply({
			profileId: "local-server",
			localServer: { id: "remote", baseUrl: "https://api.example.com", dimension: 1024 },
		});

		expect(result.ok).toBe(false);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect((await readConfig(fixture)).minSync).toBeUndefined();
	});

	it("offers only keyword-only, native-qwen3 and local-server, and rejects retired runtime profiles", async () => {
		const fixture = await createFixture({ mail: { type: "mailcrawl", connector: {} } });
		const { embedding } = buildService(fixture);

		const profileIds = (await embedding.get()).profiles.map((profile) => profile.id);
		expect(profileIds).toEqual(["none", "native-qwen3", "local-server"]);
		for (const retired of ["embeddinggemma-300m", "qwen3-embedding-0.6b"]) {
			const result = await embedding.apply({ profileId: retired });
			expect(result.ok).toBe(false);
			expect(result.error).toContain(retired);
		}
		expect((await readConfig(fixture)).minSync).toBeUndefined();
	});

	it("reports the current profile and which sources follow it, from the shared config", async () => {
		const fixture = await createFixture({
			mail: { type: "mailcrawl", connector: {} },
			chat: { type: "discord", connector: {} },
			talk: { type: "kakao", connector: {} },
			gist: { type: "github-gist", connector: {} },
			vault: { type: "obsidian", connector: { vaultPath: fixtureRootPlaceholder() } },
			news: { type: "rss", connector: { feeds: [{ url: "https://example.com/feed.xml" }] } },
		});
		const { embedding } = buildService(fixture);
		await embedding.apply({ profileId: "native-qwen3" });

		const snapshot = await embedding.get();
		expect(snapshot.current.profileId).toBe("native-qwen3");
		expect(snapshot.profiles.map((profile) => profile.id)).toContain("local-server");
		const adoption = Object.fromEntries(snapshot.sources.map((source) => [source.id, source.adoption]));
		expect(adoption).toEqual({ mail: "native", chat: "propagated", talk: "native", gist: "native", vault: "propagated", news: "not-applicable" });

		const plan = await embedding.plan({ profileId: "native-qwen3" });
		expect(plan.current.profileId).toBe("native-qwen3");
		expect(plan.sources.find((source) => source.id === "chat")?.adoption).toBe("propagated");
	});
});

/** The obsidian connector requires a vaultPath; the fixture root is created lazily, so reuse tmpdir. */
function fixtureRootPlaceholder(): string {
	return join(tmpdir(), "autorag-embedding-vault");
}
