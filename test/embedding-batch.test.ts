import { describe, expect, it } from "vitest";
import {
	embedderKind,
	isEmbeddingTimeout,
	smallerBatchSize,
	startingBatchSize,
	withLearnedBatchSize,
} from "../src/main/embedding-batch";

describe("embedding batch size", () => {
	it("halves 64 down to 1 and then stops", () => {
		const sizes = [64];
		for (let next = smallerBatchSize(64); next !== null; next = smallerBatchSize(next)) sizes.push(next);
		expect(sizes).toEqual([64, 32, 16, 8, 4, 2, 1]);
	});

	it("tells a remote embedder from a profile or loopback server", () => {
		expect(embedderKind({ profile: "qwen3-embedding-0.6b" })).toBe("local");
		expect(embedderKind({ id: "x", baseUrl: "http://127.0.0.1:11434/v1" })).toBe("local");
		expect(embedderKind({ id: "x", baseUrl: "https://api.example.com/v1" })).toBe("remote");
	});

	it("keeps local and remote sizes apart", () => {
		const local = withLearnedBatchSize({ minSync: { embedder: { profile: "qwen3-embedding-0.6b" } } }, "local", 8);
		expect(startingBatchSize(local)).toBe(8);
		const remote = { ...local, minSync: { embedder: { id: "x", baseUrl: "https://api.example.com/v1" } } };
		expect(startingBatchSize(remote)).toBe(64);
		expect(startingBatchSize(withLearnedBatchSize(remote, "remote", 16))).toBe(16);
	});

	it("falls back to the operator's batchSize, then the default, and preserves other appIndexing keys", () => {
		expect(startingBatchSize({ minSync: { embedder: { batchSize: 20 } } })).toBe(20);
		expect(startingBatchSize({})).toBe(64);
		const next = withLearnedBatchSize({ appIndexing: { refreshIntervalMs: 5 } }, "local", 4);
		expect(next.appIndexing).toEqual({ refreshIntervalMs: 5, embeddingBatchSize: { local: 4 } });
	});

	it("recognises the gateway timeout and nothing else", () => {
		expect(isEmbeddingTimeout('embedding failed: TEI API error 504 Gateway Timeout: {"code":"timeout"}')).toBe(true);
		expect(isEmbeddingTimeout("embedding request timed out")).toBe(true);
		expect(isEmbeddingTimeout("model file is missing")).toBe(false);
		expect(isEmbeddingTimeout(undefined)).toBe(false);
	});
});
