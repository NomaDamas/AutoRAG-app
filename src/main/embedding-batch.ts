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

/** The batch size learned for this kind (`appIndexing.embeddingBatchSize.<kind>`), if any. */
export function learnedBatchSize(raw: Record<string, unknown>, kind: EmbedderKind): number | null {
	const appIndexing = isJsonObject(raw.appIndexing) ? raw.appIndexing : {};
	const learned = isJsonObject(appIndexing.embeddingBatchSize) ? appIndexing.embeddingBatchSize : {};
	return positiveInteger(learned[kind]);
}

/** Learned size, else the operator's `minSync.embedder.batchSize`, else MinSync's default. */
export function startingBatchSize(raw: Record<string, unknown>): number {
	const minSync = isJsonObject(raw.minSync) ? raw.minSync : {};
	const embedder = isJsonObject(minSync.embedder) ? minSync.embedder : {};
	return learnedBatchSize(raw, embedderKind(embedder)) ?? positiveInteger(embedder.batchSize) ?? DEFAULT_EMBEDDING_BATCH_SIZE;
}

/** Half the batch, never below one; null when it is already one and cannot shrink. */
export function smallerBatchSize(current: number): number | null {
	return current <= 1 ? null : Math.floor(current / 2);
}

/** True when a MinSync failure message is the embedding request timing out. */
export function isEmbeddingTimeout(message: string | undefined): boolean {
	return message !== undefined && /\b504\b|gateway timeout|timed out|"code":\s*"timeout"/iu.test(message);
}

/** Copy of `raw` with the learned size stored for `kind`; other keys are untouched. */
export function withLearnedBatchSize(raw: Record<string, unknown>, kind: EmbedderKind, size: number): Record<string, unknown> {
	const appIndexing = isJsonObject(raw.appIndexing) ? raw.appIndexing : {};
	const learned = isJsonObject(appIndexing.embeddingBatchSize) ? appIndexing.embeddingBatchSize : {};
	return { ...raw, appIndexing: { ...appIndexing, embeddingBatchSize: { ...learned, [kind]: size } } };
}
