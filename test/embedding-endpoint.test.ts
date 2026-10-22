import { describe, expect, it, vi } from "vitest";
import {
	createEndpointEmbedder,
	datasourceEmbeddingFor,
	discrawlRuntimeFor,
	QWEN3_QUERY_PREFIX,
	resolveEmbeddingEndpoint,
	type EmbeddingEndpoint,
} from "../src/main/embedding-endpoint";

const DAEMON = { state: "running", baseUrl: "http://127.0.0.1:50000", dimension: 1024, pid: 1, started: false } as const;
const local = async () => DAEMON;

describe("resolveEmbeddingEndpoint", () => {
	it("is the local server for the default model, with Qwen3's query instruction", async () => {
		expect(await resolveEmbeddingEndpoint({}, { local })).toEqual({
			backend: "daemon",
			protocol: "openai",
			baseUrl: "http://127.0.0.1:50000",
			model: "Qwen/Qwen3-Embedding-0.6B",
			dimension: 1024,
			queryPrefix: QWEN3_QUERY_PREFIX,
			passagePrefix: "",
		});
	});

	it("lets an operator prefix win, including the empty one, and gives other local models none", async () => {
		const empty = await resolveEmbeddingEndpoint({ minSync: { embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", queryPrefix: "" } } }, { local });
		const other = await resolveEmbeddingEndpoint({ minSync: { embedder: { id: "native:Org/Other" } } }, { local });

		expect(empty?.queryPrefix).toBe("");
		expect(other?.queryPrefix).toBe("");
	});

	it("is undefined when the local server cannot run, so callers report it instead of embedding elsewhere", async () => {
		expect(await resolveEmbeddingEndpoint({}, { local: async () => ({ state: "unavailable", reason: "x" }) })).toBeUndefined();
	});

	it("is undefined in keyword-only mode and never asks for a server", async () => {
		const ask = vi.fn(local);

		expect(await resolveEmbeddingEndpoint({ appIndexing: { semanticSearch: false } }, { local: ask })).toBeUndefined();
		expect(ask).not.toHaveBeenCalled();
	});

	it("maps an OpenAI-compatible server the user runs, loopback or remote, without asking for a local one", async () => {
		const ask = vi.fn(local);

		const ollama = await resolveEmbeddingEndpoint({ minSync: { embedder: { id: "bge-m3", baseUrl: "http://127.0.0.1:11434", dimension: 1024 } } }, { local: ask });
		const cloud = await resolveEmbeddingEndpoint(
			{ minSync: { embedder: { id: "openai:qwen/qwen3-embedding-0.6b", baseUrl: "https://api.dazziapp.com", dimension: 1024, apiKeyEnv: "OPENAI_API_KEY" } } },
			{ local: ask },
		);

		expect(ollama).toMatchObject({ backend: "remote", protocol: "openai", baseUrl: "http://127.0.0.1:11434", model: "bge-m3", dimension: 1024 });
		expect(cloud).toMatchObject({ backend: "remote", protocol: "openai", baseUrl: "https://api.dazziapp.com", model: "qwen/qwen3-embedding-0.6b", apiKeyEnv: "OPENAI_API_KEY" });
		expect(ask).not.toHaveBeenCalled();
	});

	it("maps tei: ids to the TEI protocol and openai: without a URL to api.openai.com", async () => {
		const tei = await resolveEmbeddingEndpoint({ minSync: { embedder: { id: "tei:bge", baseUrl: "http://10.0.0.5:8080" } } }, { local });
		const openai = await resolveEmbeddingEndpoint({ minSync: { embedder: { id: "openai:text-embedding-3-small" } } }, { local });

		expect(tei).toMatchObject({ protocol: "tei", model: "bge", baseUrl: "http://10.0.0.5:8080" });
		expect(openai).toMatchObject({ protocol: "openai", baseUrl: "https://api.openai.com", model: "text-embedding-3-small" });
	});
});

const daemonEndpoint: EmbeddingEndpoint = { backend: "daemon", protocol: "openai", baseUrl: "http://127.0.0.1:50000", model: "Qwen/Qwen3-Embedding-0.6B", dimension: 1024, queryPrefix: QWEN3_QUERY_PREFIX, passagePrefix: "" };

interface Call {
	readonly url: string;
	readonly headers: Record<string, string>;
	readonly body: { readonly model: string; readonly input: readonly string[] };
}

function vectors(count: number): Response {
	return new Response(JSON.stringify({ data: Array.from({ length: count }, (_, index) => ({ index, embedding: [index, 1] })) }), { status: 200 });
}

/** A fetch that records what was sent and answers with `respond()`. */
function recordingFetch(respond: () => Response): { readonly fetchImpl: typeof fetch; readonly calls: Call[] } {
	const calls: Call[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)) });
		return respond();
	};
	return { fetchImpl, calls };
}

describe("createEndpointEmbedder", () => {
	it("prefixes a query and sends documents raw, to the OpenAI route, and reports the shared identity", async () => {
		const { fetchImpl, calls } = recordingFetch(() => vectors(1));
		const embedder = createEndpointEmbedder(async () => daemonEndpoint, { fetchImpl });

		await embedder.embed(["hello"], { role: "query" });
		await embedder.embed(["hello"], { role: "document" });

		expect(calls[0]?.url).toBe("http://127.0.0.1:50000/v1/embeddings");
		expect(calls[0]?.body.input).toEqual([`${QWEN3_QUERY_PREFIX}hello`]);
		expect(calls[1]?.body.input).toEqual(["hello"]);
		expect(await embedder.identity()).toEqual({ provider: "minsync", model: "Qwen/Qwen3-Embedding-0.6B", dimension: 1024 });
	});

	it("restores order by index and rejects a short answer instead of inventing vectors", async () => {
		const reordered = recordingFetch(() => new Response(JSON.stringify({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }), { status: 200 }));
		expect(await createEndpointEmbedder(async () => daemonEndpoint, { fetchImpl: reordered.fetchImpl }).embed(["a", "b"])).toEqual([[1], [2]]);

		const short = recordingFetch(() => vectors(1));
		await expect(createEndpointEmbedder(async () => daemonEndpoint, { fetchImpl: short.fetchImpl }).embed(["a", "b"])).rejects.toThrow(/2 inputs/);
	});

	it("sends a remote key as a bearer token read from the named variable, and fails clearly without it", async () => {
		const remote: EmbeddingEndpoint = { ...daemonEndpoint, backend: "remote", baseUrl: "https://api.dazziapp.com", apiKeyEnv: "DAZZI_KEY", queryPrefix: "", passagePrefix: "" };
		const { fetchImpl, calls } = recordingFetch(() => vectors(1));

		await createEndpointEmbedder(async () => remote, { fetchImpl, env: { DAZZI_KEY: "secret" } }).embed(["x"]);
		expect(calls[0]?.headers.authorization).toBe("Bearer secret");

		await expect(createEndpointEmbedder(async () => remote, { fetchImpl, env: {} }).embed(["x"])).rejects.toThrow(/DAZZI_KEY/);
	});

	it("fails with a reason the user can act on when no endpoint exists", async () => {
		const embedder = createEndpointEmbedder(async () => undefined, {});

		await expect(embedder.embed(["x"])).rejects.toThrow(/embedding/i);
	});
});

describe("discrawlRuntimeFor", () => {
	it("points discrawl at the local server over /v1 with a keyless placeholder, and a remote at its key variable", () => {
		expect(discrawlRuntimeFor(daemonEndpoint)).toEqual({
			provider: "openai_compatible",
			model: "Qwen/Qwen3-Embedding-0.6B",
			baseUrl: "http://127.0.0.1:50000/v1",
			dimensions: 1024,
			apiKeyEnv: "AUTORAG_LOCAL_EMBEDDING_KEY",
			apiKeyValue: "local",
		});
		expect(discrawlRuntimeFor({ ...daemonEndpoint, backend: "remote", baseUrl: "https://api.x.com/v1", apiKeyEnv: "K" })).toMatchObject({ baseUrl: "https://api.x.com/v1", apiKeyEnv: "K" });
	});

	it("cannot use a TEI endpoint, because discrawl speaks OpenAI only", () => {
		expect(discrawlRuntimeFor({ ...daemonEndpoint, protocol: "tei" })).toBeUndefined();
	});
});

describe("datasourceEmbeddingFor", () => {
	it("gives datasource skills the shared embedder, the endpoint for CLIs, and discrawl's runtime", async () => {
		const options = datasourceEmbeddingFor(async () => daemonEndpoint, {});

		expect(await options.cliEndpoint()).toEqual(daemonEndpoint);
		expect(typeof options.embedder.embed).toBe("function");
		expect(await options.discrawl()).toMatchObject({ provider: "openai_compatible" });
	});
});
