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

/** The mailcrawl env the embedding service wrote for the fixture's `mail` datasource. */
function mailEnv(config: Record<string, unknown>): Record<string, string> {
	const datasources = config.datasources as Record<string, { connector?: { env?: Record<string, string> } }> | undefined;
	const env = datasources?.mail?.connector?.env;
	if (env === undefined) throw new Error("Expected a written mailcrawl env");
	return env;
}

function vectorResponse(dimension: number): Response {
	return new Response(
		JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: Array.from({ length: dimension }, (_, i) => i / dimension) }] }),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("createEmbeddingSettingsService", () => {
	it("propagates a profile change to minSync and every reachable datasource while preserving unknown config", async () => {
		const fixture = await createFixture({
			mail: { type: "mailcrawl", connector: {} },
			vault: { type: "obsidian", connector: { vaultPath: fixtureRootPlaceholder() } },
			news: { type: "rss", connector: { feeds: [{ url: "https://example.com/feed.xml" }] } },
		});
		const { embedding } = buildService(fixture);

		const result = await embedding.apply({ profileId: "qwen3-embedding-0.6b" });

		expect(result.ok).toBe(true);
		expect(result.applied).toBe(true);
		expect(result.incompatibilities).toEqual([]);
		const config = await readConfig(fixture);
		expect(config.minSync).toMatchObject({ embedder: { profile: "qwen3-embedding-0.6b", dimension: 1024 } });
		expect(config.customSection).toEqual({ keep: true });
		expect(mailEnv(config).MAILCRAWL_EMBEDDER_PROVIDER).toBe("native");
		// rss keeps its own lexical index; only embedding sources reindex.
		expect(fixture.synced.sort()).toEqual(["mail", "vault"]);
		expect(result.rebuilds.map((rebuild) => rebuild.id).sort()).toEqual(["mail", "vault"]);
		await embedding.dispose();
	});

	it("writes the native Qwen3 mailcrawl override and the qmd process env", async () => {
		const fixture = await createFixture({
			mail: { type: "mailcrawl", connector: {} },
			vault: { type: "obsidian", connector: { vaultPath: fixtureRootPlaceholder() } },
		});
		const { embedding } = buildService(fixture);

		await embedding.apply({ profileId: "native-qwen3" });

		const config = await readConfig(fixture);
		expect(config.minSync).toMatchObject({ embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } });
		const env = mailEnv(config);
		expect(env.MAILCRAWL_EMBEDDER_PROVIDER).toBe("native");
		expect(env.MAILCRAWL_NATIVE_MODEL).toBe("Qwen/Qwen3-Embedding-0.6B");
		expect(fixture.env.QMD_EMBED_MODEL).toContain("Qwen3-Embedding-0.6B");
		await embedding.dispose();
	});

	it("blocks a change when an enabled datasource cannot adopt the model, and does not write", async () => {
		const fixture = await createFixture({ chat: { type: "discord", connector: {} } });
		const { embedding } = buildService(fixture);

		const blocked = await embedding.apply({ profileId: "native-qwen3" });

		expect(blocked.ok).toBe(false);
		expect(blocked.applied).toBe(false);
		expect(blocked.incompatibilities.map((status) => status.id)).toEqual(["chat"]);
		expect((await readConfig(fixture)).minSync).toBeUndefined();

		const forced = await embedding.apply({ profileId: "native-qwen3", acknowledgeIncompatible: true });
		expect(forced.ok).toBe(true);
		expect(forced.applied).toBe(true);
		expect(forced.incompatibilities.map((status) => status.id)).toEqual(["chat"]);
		expect(fixture.synced).toEqual([]);
		await embedding.dispose();
	});

	it("probes a local server for real vectors and overlays mailcrawl through the loopback adapter", async () => {
		const fixture = await createFixture({ mail: { type: "mailcrawl", connector: {} } });
		const fetchImpl = vi.fn(async () => vectorResponse(1024)) as unknown as typeof fetch;
		const { embedding } = buildService(fixture, fetchImpl);

		const result = await embedding.apply({
			profileId: "local-server",
			localServer: { id: "bge-m3", baseUrl: "http://127.0.0.1:11434", dimension: 1024 },
		});

		expect(result.ok).toBe(true);
		const config = await readConfig(fixture);
		expect(config.minSync).toMatchObject({ embedder: { id: "bge-m3", baseUrl: "http://127.0.0.1:11434", dimension: 1024 } });
		const env = mailEnv(config);
		expect(env.MAILCRAWL_EMBEDDER_PROVIDER).toBe("loopback-http");
		expect(env.MAILCRAWL_EMBED_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mailcrawl\/embeddings$/);
		await embedding.dispose();
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
		await embedding.dispose();
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
		await embedding.dispose();
	});

	it("no longer offers the dropped EmbeddingGemma profile and rejects it", async () => {
		const fixture = await createFixture({ mail: { type: "mailcrawl", connector: {} } });
		const { embedding } = buildService(fixture);

		expect((await embedding.get()).profiles.map((profile) => profile.id)).not.toContain("embeddinggemma-300m");
		const result = await embedding.apply({ profileId: "embeddinggemma-300m" });

		expect(result.ok).toBe(false);
		expect(result.error).toContain("embeddinggemma-300m");
		expect((await readConfig(fixture)).minSync).toBeUndefined();
		await embedding.dispose();
	});

	it("reports the current profile and adoption plan from the shared config", async () => {
		const fixture = await createFixture({
			mail: { type: "mailcrawl", connector: {} },
			chat: { type: "discord", connector: {} },
		});
		const { embedding } = buildService(fixture);
		await embedding.apply({ profileId: "qwen3-embedding-0.6b", acknowledgeIncompatible: true });

		const snapshot = await embedding.get();
		expect(snapshot.current.profileId).toBe("qwen3-embedding-0.6b");
		expect(snapshot.profiles.map((profile) => profile.id)).toContain("local-server");
		expect(snapshot.sources.find((source) => source.id === "mail")?.adoption).toBe("propagated");
		expect(snapshot.sources.find((source) => source.id === "chat")?.adoption).toBe("incompatible");

		const plan = await embedding.plan({ profileId: "native-qwen3" });
		expect(plan.current.profileId).toBe("native-qwen3");
		expect(plan.sources.find((source) => source.id === "chat")?.adoption).toBe("incompatible");
		await embedding.dispose();
	});
});

/** The obsidian connector requires a vaultPath; the fixture root is created lazily, so reuse tmpdir. */
function fixtureRootPlaceholder(): string {
	return join(tmpdir(), "autorag-embedding-vault");
}
