import { isJsonObject } from "../shared/settings-contract";
import { DEFAULT_LOCAL_EMBEDDING_MODEL, localEmbeddingModel, type EmbeddingDaemonState } from "./embedding-daemon";

/**
 * Where text is embedded right now, for everything that embeds: the librarian's memory and chat sidecars,
 * the gist index, and the datasource CLIs that embed for themselves (mailcrawl, lazykatok, discrawl).
 * One answer, derived from `minSync.embedder` in the shared config: the local `minsync serve` server the
 * app runs, or the server the user configured. Nothing here loads a model or starts a process; the local
 * server is asked for through `local`, which the app wires to its embedding daemon.
 *
 * The librarian has the same logic, but it exports none of it, so the app keeps its own small copy.
 */

/** Qwen3-Embedding embeds a query as `Instruct: {task}\nQuery:{query}` and a document raw (model card). */
export const QWEN3_QUERY_PREFIX = "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:";

const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com";
const LOCAL_KEY_ENV = "AUTORAG_LOCAL_EMBEDDING_KEY";
const LOCAL_KEY_PLACEHOLDER = "local";
const REQUEST_TIMEOUT_MS = 120_000;
const BATCH_SIZE = 32;

export interface EmbeddingEndpoint {
	/** `daemon` is the app's own local server; `remote` is any server the user configured, loopback or not. */
	readonly backend: "daemon" | "remote";
	readonly protocol: "openai" | "tei";
	/** Server root; the OpenAI route is under `/v1`, TEI at `/embed`. */
	readonly baseUrl: string;
	readonly model: string;
	readonly dimension: number | undefined;
	/** Name of the environment variable that holds the bearer token. Never the token. */
	readonly apiKeyEnv?: string;
	readonly queryPrefix: string;
	readonly passagePrefix: string;
}

export interface EndpointDeps {
	/** The local server for a model; the app's daemon. */
	readonly local: (model: string) => Promise<EmbeddingDaemonState>;
}

/** The embedding endpoint the config selects, or undefined when nothing can embed (keyword-only, or the local server is down). */
export async function resolveEmbeddingEndpoint(raw: Record<string, unknown>, deps: EndpointDeps): Promise<EmbeddingEndpoint | undefined> {
	if (isJsonObject(raw.appIndexing) && raw.appIndexing.semanticSearch === false) return undefined;
	const embedder = isJsonObject(raw.minSync) && isJsonObject(raw.minSync.embedder) ? raw.minSync.embedder : {};
	const queryPrefix = typeof embedder.queryPrefix === "string" ? embedder.queryPrefix : undefined;
	const passagePrefix = typeof embedder.passagePrefix === "string" ? embedder.passagePrefix : "";
	const model = localEmbeddingModel(raw);
	if (model !== null) {
		const server = await deps.local(model);
		if (server.state !== "running") return undefined;
		const defaultQuery = model.toLowerCase() === DEFAULT_LOCAL_EMBEDDING_MODEL.toLowerCase() ? QWEN3_QUERY_PREFIX : "";
		return {
			backend: "daemon",
			protocol: "openai",
			baseUrl: server.baseUrl,
			model,
			dimension: server.dimension,
			queryPrefix: queryPrefix ?? defaultQuery,
			passagePrefix,
		};
	}
	const id = typeof embedder.id === "string" ? embedder.id : "";
	const separator = id.indexOf(":");
	const kind = separator === -1 ? undefined : id.slice(0, separator);
	const baseUrl = typeof embedder.baseUrl === "string" && embedder.baseUrl.length > 0 ? embedder.baseUrl : kind === "openai" ? OPENAI_DEFAULT_BASE_URL : undefined;
	if (baseUrl === undefined) return undefined;
	return {
		backend: "remote",
		protocol: kind === "tei" ? "tei" : "openai",
		baseUrl,
		model: kind === "openai" || kind === "tei" ? id.slice(separator + 1) : id,
		dimension: typeof embedder.dimension === "number" ? embedder.dimension : undefined,
		...(typeof embedder.apiKeyEnv === "string" ? { apiKeyEnv: embedder.apiKeyEnv } : {}),
		queryPrefix: queryPrefix ?? "",
		passagePrefix,
	};
}

export type EndpointSource = () => Promise<EmbeddingEndpoint | undefined>;

export interface EmbedOptions {
	readonly role?: "query" | "document";
}

/** The shape the librarian's memory, sidecars and gist code against. */
export interface SharedEmbedder {
	identity(): Promise<{ readonly provider: string; readonly model: string; readonly dimension: number }>;
	embed(texts: readonly string[], options?: EmbedOptions): Promise<readonly (readonly number[])[]>;
}

export interface EmbedderRuntime {
	readonly fetchImpl?: typeof fetch;
	readonly env?: NodeJS.ProcessEnv;
}

function route(endpoint: EmbeddingEndpoint): string {
	const root = endpoint.baseUrl.replace(/\/+$/u, "");
	return endpoint.protocol === "tei" ? `${root}/embed` : `${root.replace(/\/v1$/u, "")}/v1/embeddings`;
}

function readVectors(endpoint: EmbeddingEndpoint, json: unknown, expected: number): number[][] {
	let rows: unknown[] = [];
	if (endpoint.protocol === "tei") {
		rows = Array.isArray(json) ? json : [];
	} else if (isJsonObject(json) && Array.isArray(json.data)) {
		const indexed = json.data.filter(isJsonObject);
		rows = indexed
			.map((row, position) => ({ position: typeof row.index === "number" ? row.index : position, embedding: row.embedding }))
			.sort((a, b) => a.position - b.position)
			.map((row) => row.embedding);
	}
	const vectors = rows.filter((row): row is number[] => Array.isArray(row) && row.every((value) => typeof value === "number"));
	if (vectors.length !== expected || rows.length !== expected) throw new Error(`the embedding endpoint returned ${vectors.length} usable vectors for ${expected} inputs`);
	return vectors;
}

/**
 * An embedder over the endpoint the config selects, looked up on every call so a server that came or went
 * since is noticed. It reports one identity whatever serves the model, so stores keyed on it do not
 * re-embed when the local server restarts.
 */
export function createEndpointEmbedder(source: EndpointSource, runtime: EmbedderRuntime): SharedEmbedder {
	const fetchImpl = runtime.fetchImpl ?? fetch;
	const env = runtime.env ?? process.env;

	const active = async (): Promise<EmbeddingEndpoint> => {
		const endpoint = await source();
		if (endpoint === undefined) throw new Error("no embedding server is available: the local embedding server is not running, or semantic search is off");
		return endpoint;
	};

	const send = async (endpoint: EmbeddingEndpoint, batch: readonly string[]): Promise<number[][]> => {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (endpoint.apiKeyEnv !== undefined) {
			const key = env[endpoint.apiKeyEnv];
			if (typeof key !== "string" || key.length === 0) throw new Error(`embedding API key is not set: environment variable ${endpoint.apiKeyEnv} is empty or missing`);
			headers.Authorization = `Bearer ${key}`;
		}
		const body = endpoint.protocol === "tei" ? { inputs: batch } : { model: endpoint.model, input: batch };
		const response = await fetchImpl(route(endpoint), { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		if (!response.ok) throw new Error(`embedding endpoint ${route(endpoint)} returned HTTP ${response.status}: ${await response.text().catch(() => "")}`);
		return readVectors(endpoint, await response.json(), batch.length);
	};

	return {
		async identity() {
			const endpoint = await active();
			const dimension = endpoint.dimension ?? (await send(endpoint, ["dimension probe"]))[0]?.length;
			if (dimension === undefined) throw new Error("the embedding endpoint did not report a vector size");
			return { provider: "minsync", model: endpoint.model, dimension };
		},
		async embed(texts, options) {
			if (texts.length === 0) return [];
			const endpoint = await active();
			const prefix = options?.role === "query" ? endpoint.queryPrefix : endpoint.passagePrefix;
			const inputs = prefix === "" ? texts : texts.map((text) => `${prefix}${text}`);
			const vectors: number[][] = [];
			for (let offset = 0; offset < inputs.length; offset += BATCH_SIZE) vectors.push(...(await send(endpoint, inputs.slice(offset, offset + BATCH_SIZE))));
			return vectors;
		},
	};
}

export interface DiscrawlEmbeddingRuntime {
	readonly provider: string;
	readonly model: string;
	readonly baseUrl: string;
	readonly dimensions?: number;
	readonly apiKeyEnv?: string;
	readonly apiKeyValue?: string;
}

/** What discrawl's managed `[search.embeddings]` section is told: it speaks OpenAI only, so a TEI endpoint is not offered. */
export function discrawlRuntimeFor(endpoint: EmbeddingEndpoint | undefined): DiscrawlEmbeddingRuntime | undefined {
	if (endpoint === undefined || endpoint.protocol !== "openai") return undefined;
	const root = endpoint.baseUrl.replace(/\/+$/u, "").replace(/\/v1$/u, "");
	return {
		provider: "openai_compatible",
		model: endpoint.model,
		baseUrl: `${root}/v1`,
		...(endpoint.dimension === undefined ? {} : { dimensions: endpoint.dimension }),
		// discrawl keeps embeddings off unless its key variable is non-empty; the local server has no authentication.
		...(endpoint.backend === "daemon" ? { apiKeyEnv: LOCAL_KEY_ENV, apiKeyValue: LOCAL_KEY_PLACEHOLDER } : endpoint.apiKeyEnv === undefined ? {} : { apiKeyEnv: endpoint.apiKeyEnv }),
	};
}

/** Everything a datasource skill needs to embed through the shared endpoint. */
export function datasourceEmbeddingFor(source: EndpointSource, runtime: EmbedderRuntime) {
	return {
		embedder: createEndpointEmbedder(source, runtime),
		discrawl: async () => discrawlRuntimeFor(await source()),
		cliEndpoint: async () => {
			const endpoint = await source();
			if (endpoint === undefined) return undefined;
			const dimension = endpoint.dimension ?? (await createEndpointEmbedder(async () => endpoint, runtime).identity()).dimension;
			return { ...endpoint, dimension };
		},
	};
}
