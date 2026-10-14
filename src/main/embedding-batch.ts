import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject } from "../shared/settings-contract";

/**
 * Adaptive embedding batch size. MinSync sends `batchSize` texts per request
 * (default 64) and the loopback gateway aborts a request after 30 s, so on a
 * slow machine one batch can never finish and every retry returns 504. Instead
 * of fixing one number, a refresh halves the batch after a timeout (64 → 32 →
 * 16 → ...) and remembers the size that worked for later refreshes.
 *
 * Local (loopback or AutoRAG-profile) and remote embedders are remembered
 * separately: their throughput is unrelated, so a size learned against one must
 * never throttle the other.
 */

export type EmbedderKind = "local" | "remote";

export const DEFAULT_EMBEDDING_BATCH_SIZE = 64;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** An embedder with a non-loopback `baseUrl` is remote; a profile or loopback server is local. */
export function embedderKind(embedder: unknown): EmbedderKind {
	if (!isJsonObject(embedder) || typeof embedder.baseUrl !== "string" || embedder.baseUrl.length === 0) return "local";
	try {
		return LOOPBACK_HOSTS.has(new URL(embedder.baseUrl).hostname) ? "local" : "remote";
	} catch {
		return "remote";
	}
}

function positiveInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Learned sizes live in `embedding-batch.json` next to the shared config, not in
 * the config itself: a refresh (scheduled job or app) must not read-modify-write
 * the file Settings edits, because the librarian's write lock is not exported and
 * a whole-file replace would drop a concurrent edit.
 */
export function learnedBatchFile(configPath: string): string {
	return join(dirname(configPath), "embedding-batch.json");
}

function readLearned(configPath: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(learnedBatchFile(configPath), "utf8"));
		return isJsonObject(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** The batch size learned for this kind, if any. */
export function learnedBatchSize(configPath: string, kind: EmbedderKind): number | null {
	return positiveInteger(readLearned(configPath)[kind]);
}

/** Remember `size` for `kind`; the other kind's size is kept. Written atomically. */
export function saveLearnedBatchSize(configPath: string, kind: EmbedderKind, size: number): void {
	const file = learnedBatchFile(configPath);
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify({ ...readLearned(configPath), [kind]: size }, null, 2)}\n`);
	renameSync(temporary, file);
}

/** Learned size, else the operator's `minSync.embedder.batchSize`, else MinSync's default. */
export function startingBatchSize(configPath: string, raw: Record<string, unknown>): number {
	const minSync = isJsonObject(raw.minSync) ? raw.minSync : {};
	const embedder = isJsonObject(minSync.embedder) ? minSync.embedder : {};
	return learnedBatchSize(configPath, embedderKind(embedder)) ?? positiveInteger(embedder.batchSize) ?? DEFAULT_EMBEDDING_BATCH_SIZE;
}

/** Half the batch, never below one; null when it is already one and cannot shrink. */
export function smallerBatchSize(current: number): number | null {
	return current <= 1 ? null : Math.floor(current / 2);
}

/**
 * True when MinSync failed because an embedding request timed out at the
 * gateway (HTTP 504 / "Embedding upstream timed out"). A runtime that never
 * became ready ("health check timed out") is not a batch-size problem.
 */
export function isEmbeddingTimeout(message: string | undefined): boolean {
	return message !== undefined && /\b504\b|gateway timeout|embedding upstream timed out/iu.test(message);
}
