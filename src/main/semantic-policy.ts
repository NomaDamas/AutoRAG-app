import {
	DiscrawlClient,
	MailcrawlClient,
	type AutoRAGAgentOptions,
	type CliConfig,
	type RefreshMethod,
	type RetrievalMethod,
} from "@autorag/librarian";
import { isJsonObject } from "../shared/settings-contract";

/**
 * Keyword-only mode ("사용 안 함" on the onboarding embedding step).
 *
 * With `appIndexing.semanticSearch: false` nothing in the app embeds text and no
 * retrieval method ranks by meaning: MinSync never runs, every datasource that
 * can skip its embedding step does, MinSync's vector and hybrid methods answer
 * nothing, and the shared embedder reports no endpoint, so a datasource's
 * hybrid-first method falls back to its own keyword search.
 * The shared config file is left alone, like `indexing-policy`: the policy is
 * applied to the config the app hands to the librarian.
 *
 * The librarian has no switch for this, so the policy works with what it
 * exposes: refresh method selection, per-datasource connector options, the
 * public retrieval registry, the shared embedder, client classes, and the one
 * member of the agent the registry does not reach (`agentMinSyncVectorMethod`;
 * a test fails when a librarian release moves it).
 */

/** Retrieval method types that rank by embeddings, alone or fused with keywords. */
const SEMANTIC_TYPES: Record<string, true> = { vector: true, hybrid: true };

/**
 * The refresh methods to run. MinSync is replaced by what a MinSync run implied
 * besides embedding: the parsed mirror it indexes over and Jikji's keyword artifacts.
 */
export function methodsForSemantic(methods: readonly RefreshMethod[], semantic: boolean): readonly RefreshMethod[] {
	if (semantic || !methods.includes("minsync")) return methods;
	const out: RefreshMethod[] = [];
	for (const method of methods) {
		for (const next of method === "minsync" ? (["parsed", "jikji"] as const) : [method]) {
			if (!out.includes(next)) out.push(next);
		}
	}
	return out;
}

/** Datasource templates whose read-only sidecar embeds messages unless `connector.sidecar.semantic` is false. */
const SIDECAR_TEMPLATES: Record<string, true> = { kakao: true, slack: true, telegram: true, whatsapp: true };

function entryWithoutSemantic(alias: string, entry: unknown): unknown {
	if (!isJsonObject(entry)) return entry;
	const template = typeof entry.type === "string" ? entry.type : alias;
	const connector = isJsonObject(entry.connector) ? entry.connector : {};
	if (SIDECAR_TEMPLATES[template] === true) {
		if (connector.sidecar === false) return entry;
		const sidecar = isJsonObject(connector.sidecar) ? connector.sidecar : {};
		return { ...entry, connector: { ...connector, sidecar: { ...sidecar, semantic: false } } };
	}
	if (template === "discord") return { ...entry, connector: { ...connector, defaultMode: "fts" } };
	// The librarian maps `connector.semantic: false` to the gist skill's own switch (AutoRAG#1936): no vector index, no semantic method.
	if (template === "github-gist" || template === "hister") return { ...entry, connector: { ...connector, semantic: false } };
	if (template === "clawgallery") return { ...entry, connector: { ...connector, syncVisual: false, defaultMode: "keyword" } };
	// An Obsidian vault is indexed by MinSync, which cannot index without an embedder; keyword-only mode runs none.
	if (template === "obsidian") return { ...entry, enabled: false };
	return entry;
}

/** The config with every datasource's semantic option switched off; the same object while semantic search is on. */
export function withSemanticPolicyApplied(config: CliConfig, semantic: boolean): CliConfig {
	if (semantic || config.datasources === undefined) return config;
	const datasources = Object.fromEntries(Object.entries(config.datasources).map(([alias, entry]) => [alias, entryWithoutSemantic(alias, entry)]));
	return { ...config, datasources: datasources as NonNullable<CliConfig["datasources"]> };
}

function isRetrievalMethod(value: unknown): value is RetrievalMethod {
	return typeof value === "object" && value !== null && "describe" in value && typeof value.describe === "function" && "retrieve" in value && typeof value.retrieve === "function";
}

function isManagedEmbedder(value: unknown): value is NonNullable<AutoRAGAgentOptions["embedder"]> {
	return typeof value === "object" && value !== null && "describeEndpoint" in value && typeof value.describeEndpoint === "function";
}

/**
 * Makes every vector and hybrid method in the registry stop ranking by meaning.
 *
 * A method answers nothing without running, except a hybrid method that belongs to a datasource. Since the librarian
 * searches hybrid-first, that one method is the datasource's whole search: it leads with the hybrid and answers from
 * keyword search when the hybrid throws, which it does while the embedder reports no endpoint (`agentOptionsForSemantic`).
 * It keeps running, and the pipeline is not told its fallback happened, because here that is the mode working, not a
 * failed method.
 *
 * Descriptors are untouched, so tool listings stay truthful, and no "method failed" diagnostic reaches the agent for an
 * index that is deliberately absent. Returns the names of the methods it silenced.
 */
export function neutralizeSemanticMethods(registry: { list(): RetrievalMethod[] }): readonly string[] {
	const names: string[] = [];
	for (const method of registry.list()) {
		const { name, type, datasourceId } = method.describe();
		if (SEMANTIC_TYPES[type] !== true) continue;
		if (type === "hybrid" && datasourceId !== undefined) {
			const retrieve = method.retrieve.bind(method);
			method.retrieve = (query, options) => {
				const { onFallback: _deliberate, ...rest } = options;
				return retrieve(query, rest);
			};
			continue;
		}
		method.retrieve = async () => [];
		names.push(name);
	}
	return names;
}

interface EmbeddingStep {
	readonly owner: object;
	readonly key: string;
	readonly original: unknown;
}

const NO_OUTPUT = { stdout: "", stderr: "", code: 0 } as const;

/**
 * The embedding steps the librarian runs unconditionally while indexing a
 * datasource: mailcrawl's `index` and discrawl's `embed`.
 * Each becomes a successful no-op; the sync/update steps next to them still run.
 */
function replacementSteps(): readonly { readonly owner: object; readonly key: string; readonly stub: unknown }[] {
	return [
		{ owner: MailcrawlClient.prototype, key: "index", stub: async () => ({ ok: true, data: { embedded: 0, reused: 0 }, ...NO_OUTPUT }) },
		{
			owner: DiscrawlClient.prototype,
			key: "embed",
			stub: async () => ({ ok: true, data: { processed: 0, succeeded: 0, failed: 0, remainingBacklog: 0 }, ...NO_OUTPUT }),
		},
	];
}

let active = 0;
let saved: EmbeddingStep[] = [];

/**
 * Runs `work` with the datasource embedding steps disabled. Overlapping runs
 * share one patch, restored when the last of them settles, so a failing run can
 * never leave the librarian's clients permanently without embedding.
 */
export async function runWithoutSemanticIndexing<T>(work: () => Promise<T>): Promise<T> {
	if (active === 0) {
		saved = replacementSteps().map(({ owner, key, stub }) => {
			const record = owner as Record<string, unknown>;
			const original = record[key];
			record[key] = stub;
			return { owner, key, original };
		});
	}
	active += 1;
	try {
		return await work();
	} finally {
		active -= 1;
		if (active === 0) {
			for (const { owner, key, original } of saved) (owner as Record<string, unknown>)[key] = original;
			saved = [];
		}
	}
}

/**
 * Agent options for keyword-only mode. Past-question memory search ranks by keywords too, and the shared embedder
 * reports no endpoint: the datasource CLIs (mailcrawl, lazykatok) then fail their hybrid and semantic searches with
 * `embedding-unavailable` instead of embedding with their own native model or a running `minsync serve`, so a hybrid-first
 * datasource method answers from its keyword search. The datasource skills hold this same embedder instance, which is why
 * it is changed in place.
 */
export function agentOptionsForSemantic<T extends object>(options: T, semantic: boolean): T & { readonly memoryEmbedder?: false } {
	if (semantic) return options;
	if ("embedder" in options && isManagedEmbedder(options.embedder)) options.embedder.describeEndpoint = async () => undefined;
	return { ...options, memoryEmbedder: false };
}

/**
 * The MinSync vector method the agent keeps for itself: the search pre-fetch and the `semantic_search_local_docs` tool
 * read it directly. Hybrid-first retrieval (librarian after v2.12.0) leaves it out of the registry, so the registry no
 * longer reaches it. Undefined when the agent has no such member.
 */
export function agentMinSyncVectorMethod(agent: object): RetrievalMethod | undefined {
	const found: unknown = Reflect.get(agent, "minSyncMethod");
	return isRetrievalMethod(found) ? found : undefined;
}

/**
 * Silences the agent's vector and hybrid methods in keyword-only mode: the registry's, and the vector method the agent
 * holds outside it. Throws instead of searching by meaning when the librarian no longer exposes that method.
 */
export function applySemanticPolicyToAgent(agent: { getMethodRegistry(): { list(): RetrievalMethod[] } }, semantic: boolean): void {
	if (semantic) return;
	const vector = agentMinSyncVectorMethod(agent);
	if (vector === undefined) {
		throw new Error("Keyword-only mode cannot silence MinSync's vector method: the librarian's agent has no `minSyncMethod` member any more.");
	}
	const methods = new Set([...agent.getMethodRegistry().list(), vector]);
	neutralizeSemanticMethods({ list: () => [...methods] });
}
