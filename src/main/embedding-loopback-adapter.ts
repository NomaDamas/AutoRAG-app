import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * App-local loopback protocol adapter for the corpus embedder.
 *
 * The AutoRAG embedding runtime is not a public `@autorag/librarian` export, so
 * the app cannot serve a profile model itself. What it *can* do is expose a
 * local embedding server the operator already runs (Ollama or any
 * OpenAI-compatible endpoint) in the request/response shapes the datasource
 * CLIs expect, without ever leaving the machine or inventing vectors: every
 * request is proxied to the real upstream `/v1/embeddings` and the real vectors
 * are reshaped. It is not a model; it is a protocol bridge.
 *
 * Routes:
 * - `GET  /healthz`             — readiness, upstream, model, dimension
 * - `POST /v1/embeddings`       — OpenAI `{ model, input }` → `{ data: [...] }`
 * - `POST /api/embeddings`      — Ollama `{ model, prompt }` → `{ embedding }`
 * - `POST /mailcrawl/embeddings`— `{ model, texts }` → `{ embeddings }`
 */

const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true, "::1": true, "[::1]": true };

export interface EmbeddingLoopbackAdapter {
	/** Loopback base URL the CLIs use, e.g. `http://127.0.0.1:49152`. */
	readonly url: string;
	close(): Promise<void>;
}

export interface EmbeddingLoopbackAdapterOptions {
	/** Real local embedding server, e.g. `http://127.0.0.1:11434`. Must be loopback. */
	readonly upstreamBaseUrl: string;
	readonly model: string;
	readonly dimension: number;
	/** Test seam; defaults to the global `fetch`. */
	readonly fetchImpl?: typeof fetch;
}

interface OpenAiEmbeddingResponse {
	readonly data?: readonly { readonly embedding?: readonly number[] }[];
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	if (chunks.length === 0) return undefined;
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return undefined;
	}
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
	response.end(payload);
}

function asStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	if (value.some((item) => typeof item !== "string")) return null;
	return value as string[];
}

export async function startEmbeddingLoopbackAdapter(options: EmbeddingLoopbackAdapterOptions): Promise<EmbeddingLoopbackAdapter> {
	let upstreamHost: string;
	try {
		upstreamHost = new URL(options.upstreamBaseUrl).hostname.toLowerCase();
	} catch {
		throw new Error(`Embedding loopback adapter upstream must be a valid URL, got ${options.upstreamBaseUrl}`);
	}
	if (LOOPBACK_HOSTS[upstreamHost] !== true) {
		throw new Error(`Embedding loopback adapter upstream must be loopback, got ${options.upstreamBaseUrl}`);
	}
	const upstream = `${options.upstreamBaseUrl.replace(/\/+$/u, "")}/v1/embeddings`;
	const doFetch = options.fetchImpl ?? fetch;

	const embed = async (inputs: readonly string[]): Promise<readonly (readonly number[])[]> => {
		const result = await doFetch(upstream, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: options.model, input: inputs }),
		});
		if (!result.ok) throw new Error(`Upstream embedding request failed with HTTP ${result.status}`);
		// The upstream is an OpenAI-compatible server we already probed; its JSON is
		// still untrusted, so every vector is validated before it is reshaped.
		const payload = (await result.json()) as OpenAiEmbeddingResponse;
		const vectors: (readonly number[])[] = [];
		for (const entry of payload.data ?? []) {
			const embedding = entry.embedding;
			if (!Array.isArray(embedding) || embedding.some((value) => typeof value !== "number")) {
				throw new Error("Upstream embedding response did not contain numeric vectors");
			}
			vectors.push(embedding);
		}
		return vectors;
	};

	const server: Server = createServer((request, response) => {
		void (async () => {
			try {
				if (request.method === "GET" && request.url === "/healthz") {
					sendJson(response, 200, {
						status: "ok",
						model: options.model,
						dimension: options.dimension,
						upstream: options.upstreamBaseUrl,
					});
					return;
				}
				if (request.method !== "POST") {
					sendJson(response, 405, { error: "method not allowed" });
					return;
				}
				const body: unknown = await readJson(request);
				const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
				if (request.url === "/v1/embeddings") {
					const inputs = asStringArray(record.input);
					if (inputs === null) return sendJson(response, 400, { error: "input must be a string array" });
					const vectors = await embed(inputs);
					sendJson(response, 200, {
						object: "list",
						model: options.model,
						data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })),
					});
					return;
				}
				if (request.url === "/api/embeddings") {
					const prompt = typeof record.prompt === "string" ? record.prompt : null;
					if (prompt === null) return sendJson(response, 400, { error: "prompt must be a string" });
					const vectors = await embed([prompt]);
					sendJson(response, 200, { embedding: vectors[0] });
					return;
				}
				if (request.url === "/mailcrawl/embeddings") {
					const texts = asStringArray(record.texts);
					if (texts === null) return sendJson(response, 400, { error: "texts must be a string array" });
					sendJson(response, 200, { embeddings: await embed(texts) });
					return;
				}
				sendJson(response, 404, { error: "not found" });
			} catch (error) {
				sendJson(response, 502, { error: error instanceof Error ? error.message : String(error) });
			}
		})();
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		server.close();
		throw new Error("Embedding loopback adapter failed to bind a loopback port");
	}
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}
