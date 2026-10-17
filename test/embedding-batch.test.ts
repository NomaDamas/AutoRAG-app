import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	embedderKind,
	isEmbeddingTimeout,
	saveLearnedBatchSize,
	smallerBatchSize,
	startingBatchSize,
} from "../src/main/embedding-batch";

const directories: string[] = [];

async function configPath(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "autorag-batch-"));
	directories.push(dir);
	return join(dir, "config.json");
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

	it("keeps local and remote sizes apart", async () => {
		const path = await configPath();
		const local = { minSync: { embedder: { profile: "qwen3-embedding-0.6b" } } };
		const remote = { minSync: { embedder: { id: "x", baseUrl: "https://api.example.com/v1" } } };
		saveLearnedBatchSize(path, "local", 8);
		expect(startingBatchSize(path, local)).toBe(8);
		expect(startingBatchSize(path, remote)).toBe(64);
		saveLearnedBatchSize(path, "remote", 16);
		expect(startingBatchSize(path, remote)).toBe(16);
		expect(startingBatchSize(path, local)).toBe(8);
	});

	it("falls back to the operator's batchSize, then the default", async () => {
		const path = await configPath();
		expect(startingBatchSize(path, { minSync: { embedder: { batchSize: 20 } } })).toBe(20);
		expect(startingBatchSize(path, {})).toBe(64);
	});

	it("recognises gateway timeouts, native embedder deadlines, and batch-limit 413 errors, but not a runtime that never became ready", () => {
		expect(isEmbeddingTimeout('embedding failed: TEI API error 504 Gateway Timeout: {"code":"timeout"}')).toBe(true);
		expect(isEmbeddingTimeout("Embedding upstream timed out after 30000ms")).toBe(true);
		expect(isEmbeddingTimeout('embedding failed: TEI API error 413 Payload Too Large: {"error":"Embedding batch exceeds the configured limit.","code":"batch-limit"}')).toBe(true);
		expect(isEmbeddingTimeout("embedder timeout: native embedding batch exceeded 60s; its thread cannot be cancelled")).toBe(true);
		expect(isEmbeddingTimeout("Embedding runtime did not become ready within 60000ms: health check timed out")).toBe(false);
		expect(isEmbeddingTimeout("model file is missing")).toBe(false);
		expect(isEmbeddingTimeout(undefined)).toBe(false);
	});

	describe("does not mistake an unrelated message for an embedding timeout", () => {
		it.each([
			["a file name that contains 413", "MinSync skipped this file at the embed stage: files/Docs/invoice-413.pdf.md: embedding failed: non-finite values"],
			["a file name that contains 504", "MinSync skipped this file at the read stage: files/Docs/room-504.md: Permission denied"],
			["a size in bytes", "MinSync skipped this file at the read stage: file is 413 bytes, too small"],
			["a port number", "embedder unavailable: connection refused at 127.0.0.1:504"],
			["a file called timeout", "MinSync skipped this file at the read stage: files/notes/gateway timeout plan.md: invalid utf-8"],
			["a file called batch-limit", "MinSync skipped this file at the read stage: files/batch-limit.md: invalid utf-8"],
			["a document path that names the deadline phrase", "MinSync skipped this file at the read stage: files/native embedding batch exceeded.md: invalid utf-8"],
		])("ignores %s", (_label, message) => {
			expect(isEmbeddingTimeout(message)).toBe(false);
		});

		it("still recognises the same signals when a file path precedes them", () => {
			expect(isEmbeddingTimeout("embedder timeout: files/huge.md: native embedding batch exceeded 60s; its thread cannot be cancelled")).toBe(true);
			expect(isEmbeddingTimeout("embedding failed: files/invoice-413.md: OpenAI API error 504 Gateway Timeout")).toBe(true);
			expect(isEmbeddingTimeout("embedding failed: OpenAI API error 413 Payload Too Large: Embedding batch exceeds the configured limit.")).toBe(true);
		});

		it("takes a list so a path in one message cannot combine with a code in another", () => {
			expect(isEmbeddingTimeout(["files/room-504.md: Permission denied", "files/a.md: invalid utf-8"])).toBe(false);
			expect(isEmbeddingTimeout(["files/a.md: Permission denied", "TEI API error 504 Gateway Timeout"])).toBe(true);
		});
	});
});
