import {
	DiscrawlClient,
	MailcrawlClient,
	QmdClient,
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
 * can skip its embedding step does, and the vector and hybrid methods answer
 * nothing. The shared config file is left alone, like `indexing-policy`: the
 * policy is applied to the config the app hands to the librarian.
 *
 * The librarian (v2.10.x) has no switch for this, so the policy works with what
 * it exposes: refresh method selection, per-datasource connector options, and
 * the public retrieval registry and client classes.
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
	// Needs a librarian that maps `connector.semantic` to the gist skill's own switch; older ones ignore the key.
	if (template === "github-gist") return { ...entry, connector: { ...connector, semantic: false } };
	if (template === "clawgallery") return { ...entry, connector: { ...connector, syncVisual: false } };
	return entry;
}

/** The config with every datasource's semantic option switched off; the same object while semantic search is on. */
export function withSemanticPolicyApplied(config: CliConfig, semantic: boolean): CliConfig {
	if (semantic || config.datasources === undefined) return config;
	const datasources = Object.fromEntries(Object.entries(config.datasources).map(([alias, entry]) => [alias, entryWithoutSemantic(alias, entry)]));
	return { ...config, datasources: datasources as NonNullable<CliConfig["datasources"]> };
}

/**
 * Makes every vector and hybrid method in the registry answer nothing without
 * running it. Descriptors are untouched, so tool listings stay truthful, and no
 * "method failed" diagnostic reaches the agent for an index that is deliberately
 * absent. Returns the names it neutralized.
 */
export function neutralizeSemanticMethods(registry: { list(): RetrievalMethod[] }): readonly string[] {
	const names: string[] = [];
	for (const method of registry.list()) {
		const { name, type } = method.describe();
		if (SEMANTIC_TYPES[type] !== true) continue;
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
 * datasource: mailcrawl's `index`, qmd's `embed` (obsidian), discrawl's `embed`.
 * Each becomes a successful no-op; the sync/update steps next to them still run.
 */
function replacementSteps(): readonly { readonly owner: object; readonly key: string; readonly stub: unknown }[] {
	return [
		{ owner: MailcrawlClient.prototype, key: "index", stub: async () => ({ ok: true, data: { embedded: 0, reused: 0 }, ...NO_OUTPUT }) },
		{ owner: QmdClient.prototype, key: "embed", stub: async () => ({ ok: true, data: { embedded: false }, ...NO_OUTPUT }) },
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

/** Agent options for keyword-only mode: past-question memory search ranks by keywords too. */
export function agentOptionsForSemantic<T extends object>(options: T, semantic: boolean): T & { readonly memoryEmbedder?: false } {
	return semantic ? options : { ...options, memoryEmbedder: false };
}

/** Silences the agent's vector and hybrid methods in keyword-only mode. */
export function applySemanticPolicyToAgent(agent: { getMethodRegistry(): { list(): RetrievalMethod[] } }, semantic: boolean): void {
	if (!semantic) neutralizeSemanticMethods(agent.getMethodRegistry());
}
