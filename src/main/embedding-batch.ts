import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject } from "../shared/settings-contract";

/**
 * Adaptive embedding batch size. MinSync sends `batchSize` texts per request
 * (default 64). On a slow machine, or against a server with a request cap
 * (the local `minsync serve` answers 413 above its limits, a user's own server
 * may answer 504), one batch can never finish and every retry fails the same
 * way. Instead of fixing one number, a refresh halves the batch after a
 * timeout (64 → 32 → 16 → ...) and remembers the size that worked.
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
 * The three shapes an over-sized or too-slow embedding batch is reported in. Each is
 * anchored to the sentence MinSync or the gateway actually writes, never to a bare
 * number or word: a skipped file's name (`invoice-413.pdf`), a byte count, or a port
 * can contain the same digits, and matching those shrank the batch for nothing and
 * remembered the smaller size for every later run.
 *
 * - an HTTP failure from the embedding endpoint, `<provider> API error 504|413 ...`
 *   (the 413 body carries "batch-limit" / "Embedding batch exceeds the configured limit"),
 * - the gateway's own deadline, `Embedding upstream timed out after <n>ms`,
 * - the native embedder's per-batch deadline, `embedder timeout: [<path>: ]native embedding
 *   batch exceeded <duration>`; a path may sit between the two parts, so only the prefix and the
 *   phrase with its duration are required.
 */
const EMBEDDING_TIMEOUT_SIGNALS: readonly RegExp[] = [
	/\bAPI error (?:504|413)\b/u,
	/\bembedding upstream timed out after \d+ms\b/iu,
	/\bembedder timeout:.*\bnative embedding batch exceeded \d+(?:\.\d+)?m?s\b/isu,
];

/**
 * True when MinSync failed because an embedding batch timed out or exceeded the
 * batch limit. A runtime that never became ready ("health check timed out") is not a
 * batch-size problem.
 *
 * A list is checked one message at a time: joining messages let a file name in one
 * combine with a status code in another.
 */
export function isEmbeddingTimeout(messages: string | undefined | readonly (string | undefined)[]): boolean {
	const list = typeof messages === "string" || messages === undefined ? [messages] : messages;
	return list.some((message) => message !== undefined && EMBEDDING_TIMEOUT_SIGNALS.some((signal) => signal.test(message)));
}
