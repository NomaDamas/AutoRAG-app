import { describe, expect, it } from "vitest";
import { migrateLegacyEmbedding } from "../src/main/embedding-migration";

describe("migrateLegacyEmbedding", () => {
	it("turns the retired runtime profile into the local Qwen3 model", () => {
		const raw = { minSync: { enabled: true, embedder: { profile: "qwen3-embedding-0.6b", dimension: 1024, queryPrefix: "q:" } } };

		const result = migrateLegacyEmbedding(raw);

		expect(result.changed).toBe(true);
		expect(result.raw.minSync).toEqual({ enabled: true, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024, queryPrefix: "q:" } });
	});

	it("drops a GGUF id together with the gateway address it came with, which no longer exists", () => {
		const raw = { minSync: { embedder: { id: "tei:Qwen3-Embedding-0.6B-Q8_0.gguf", baseUrl: "http://127.0.0.1:48080", dimension: 1024 } } };

		expect(migrateLegacyEmbedding(raw).raw.minSync).toEqual({ embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } });
	});

	it("leaves a server the user configured, and the current native id, alone", () => {
		const own = { minSync: { embedder: { id: "bge-m3", baseUrl: "http://127.0.0.1:11434", dimension: 1024 } } };
		const native = { minSync: { embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } } };
		const cloud = { minSync: { embedder: { id: "openai:qwen/qwen3-embedding-0.6b", baseUrl: "https://api.dazziapp.com", dimension: 1024, apiKeyEnv: "OPENAI_API_KEY" } } };

		for (const raw of [own, native, cloud, {}]) {
			const result = migrateLegacyEmbedding(raw);
			expect(result.changed).toBe(false);
			expect(result.raw).toBe(raw);
		}
	});

	it("removes the embedding overrides the app used to write into mailcrawl's environment, and keeps the user's own variables", () => {
		const raw = {
			datasources: {
				mail: {
					type: "mailcrawl",
					connector: {
						env: {
							MAILCRAWL_EMBEDDER_PROVIDER: "loopback-http",
							MAILCRAWL_EMBED_URL: "http://127.0.0.1:50123/mailcrawl/embeddings",
							MAILCRAWL_EMBED_MODEL: "bge-m3",
							MAILCRAWL_EMBED_DIM: "1024",
							MAILCRAWL_NATIVE_MODEL: "Qwen/Qwen3-Embedding-0.6B",
							MAILCRAWL_NATIVE_DEVICE: "auto",
							MAILCRAWL_DATA_DIR: "/data/mail",
						},
					},
				},
				chat: { type: "discord", connector: {} },
			},
		};

		const result = migrateLegacyEmbedding(raw);

		expect(result.changed).toBe(true);
		expect(result.raw.datasources).toEqual({
			mail: { type: "mailcrawl", connector: { env: { MAILCRAWL_DATA_DIR: "/data/mail" } } },
			chat: { type: "discord", connector: {} },
		});
	});

	it("drops an env block the migration emptied", () => {
		const raw = { datasources: { mail: { type: "mailcrawl", connector: { env: { MAILCRAWL_EMBED_MODEL: "x" } } } } };

		expect(migrateLegacyEmbedding(raw).raw.datasources).toEqual({ mail: { type: "mailcrawl", connector: {} } });
	});
});
