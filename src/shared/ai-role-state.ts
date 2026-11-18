/**
 * Pure reads and shapes shared by the AI-models helper agent (`ai-customizer`):
 * how Settings → AI 모델 and Settings → 웹 검색 decode the shared AutoRAG config
 * and how they build the catalog entries a click would write. No React, no
 * i18n: the main process and tests use this, and the renderer's `roleSupport`
 * keeps its own copy.
 */

import { jevBackendFor, JEV_SLLM_BACKEND } from "./ai-roles";
import { isJsonObject, type AutoRagConfigUpdate, type JsonObject, type JsonValue, type ModelCatalogEntry, type ProviderSummary } from "./settings-contract";

/** The four model roles Settings → AI 모델 edits. */
export type RoleId = "answer" | "decomposition" | "jev" | "rerank";

/**
 * Default API-key env-var name for a provider id (`foo-bar` → `FOO_BAR_API_KEY`).
 * The renderer's `configSupport` keeps the same three lines; this copy is the one
 * the main process and the AI assistant's key tools use.
 */
export function defaultEnvName(provider: string): string {
	const base = provider.replace(/[^A-Za-z0-9]/gu, "_").toUpperCase();
	return base.length === 0 ? "" : `${base}_API_KEY`;
}

/** What a role currently points at, the shape `RolePicker` highlights: a model, a special, or nothing. */
export type RoleSelection =
	| { readonly kind: "model"; readonly provider: string; readonly modelId: string }
	| { readonly kind: "special"; readonly value: string }
	| null;

function getAt(root: JsonObject, path: readonly string[]): JsonValue | undefined {
	let current: JsonValue | undefined = root;
	for (const segment of path) {
		if (!isJsonObject(current)) return undefined;
		current = current[segment];
	}
	return current;
}

function asRecord(value: JsonValue | undefined): JsonObject | null {
	return value !== undefined && isJsonObject(value) ? value : null;
}

function stringOf(value: JsonValue | undefined): string {
	return typeof value === "string" ? value : "";
}

function boolOf(value: JsonValue | undefined): boolean | null {
	return typeof value === "boolean" ? value : null;
}

/** The providers that are actually connected, in the order Settings shows them. */
export function connectedProviders(providers: readonly ProviderSummary[]): readonly ProviderSummary[] {
	return providers.filter((provider) => provider.authConfigured);
}

/** A provider's catalog entry for `modelId`, or null when the provider does not serve it. */
export function catalogModelEntry(provider: ProviderSummary, modelId: string): ModelCatalogEntry | null {
	return provider.models.find((model) => model.id === modelId) ?? null;
}

/** The catalog entry a Jev/rerank static model id becomes, matching `roleSupport.staticCatalogEntry`. */
export function staticCatalogEntry(provider: ProviderSummary, id: string, name: string): ModelCatalogEntry {
	return { provider: provider.id, id, name, api: "", available: true, baseUrl: provider.baseUrl, apiKeyEnv: provider.apiKeyEnv ?? null };
}

/**
 * Which model (or special) a role currently points at, decoded from the shared
 * config exactly as `roleSelectionFor` does for the picker: `false` and absence
 * are the decomposition/rerank specials, and Jev's `sllm` backend is the small
 * chat model rather than a provider.
 */
export function roleSelectionFromConfig(role: RoleId, config: JsonObject, connected: readonly ProviderSummary[]): RoleSelection {
	if (role === "answer") {
		const model = asRecord(getAt(config, ["model"]));
		const provider = stringOf(model?.provider);
		const modelId = stringOf(model?.id);
		return provider.length > 0 && modelId.length > 0 ? { kind: "model", provider, modelId } : null;
	}
	if (role === "decomposition") {
		const raw = getAt(config, ["queryDecomposition"]);
		if (raw === false) return { kind: "special", value: "same" };
		if (raw === undefined) return { kind: "special", value: "default" };
		const model = asRecord(asRecord(raw)?.model);
		const provider = stringOf(model?.provider);
		const modelId = stringOf(model?.id);
		return provider.length > 0 && modelId.length > 0 ? { kind: "model", provider, modelId } : null;
	}
	if (role === "rerank") {
		const raw = getAt(config, ["rerank"]);
		if (raw === false) return { kind: "special", value: "off" };
		const record = asRecord(raw);
		const provider = stringOf(record?.provider);
		const modelId = stringOf(record?.model);
		return provider.length > 0 && modelId.length > 0 ? { kind: "model", provider, modelId } : null;
	}
	const raw = getAt(config, ["jev"]);
	if (raw === false) return null;
	const record = asRecord(raw);
	const backend = stringOf(record?.backend);
	if (backend === JEV_SLLM_BACKEND) return { kind: "special", value: JEV_SLLM_BACKEND };
	const modelId = stringOf(record?.model);
	if (backend.length === 0 || modelId.length === 0) return null;
	const matched = connected.find((provider) => jevBackendFor(provider.id) === backend);
	return matched === undefined ? null : { kind: "model", provider: matched.id, modelId };
}

/** The answer model's thinking depth (`thinking.final`); empty when unset. */
export function thinkingLevelOf(config: JsonObject): string {
	return stringOf(getAt(config, ["thinking", "final"]));
}

export interface WebSearchState {
	/** On unless `webSearch` is `false` or its `enabled` is `false`. */
	readonly enabled: boolean;
	/** The pinned provider id, empty when automatic. */
	readonly provider: string;
	/** On unless its `fetch` block is `false` or `fetch.enabled` is `false`. */
	readonly fetchEnabled: boolean;
}

/** Settings → 웹 검색's view of `webSearch`, with the page's `false`/`enabled` semantics. */
export function webSearchStateOf(config: JsonObject): WebSearchState {
	const web = getAt(config, ["webSearch"]);
	const webObject = asRecord(web) ?? {};
	const enabled = web === undefined ? true : web !== false && boolOf(webObject.enabled) !== false;
	const provider = stringOf(webObject.provider);
	const rawFetch = webObject.fetch;
	const fetchObject = asRecord(rawFetch) ?? {};
	const fetchEnabled = rawFetch === undefined ? true : rawFetch !== false && boolOf(fetchObject.enabled) !== false;
	return { enabled, provider, fetchEnabled };
}

export interface WebSearchChanges {
	readonly enabled?: boolean;
	/** A {@link WEBSEARCH_PROVIDERS} id, or `"auto"` to remove the pinned provider. */
	readonly provider?: string;
	readonly fetchEnabled?: boolean;
}

/**
 * The leaf writes Settings → 웹 검색 produces for these toggles, in the page's
 * order and shapes: enabling/disabling replaces the whole `webSearch` object
 * (turning `false` into `{enabled:true}`), the provider is a leaf (or removed),
 * and `fetch` keeps its sibling keys while only `enabled` changes.
 */
export function webSearchUpdates(config: JsonObject, changes: WebSearchChanges): AutoRagConfigUpdate[] {
	const web = getAt(config, ["webSearch"]);
	const webObject = asRecord(web) ?? {};
	const updates: AutoRagConfigUpdate[] = [];
	if (changes.enabled !== undefined) updates.push({ path: ["webSearch"], value: { ...webObject, enabled: changes.enabled } });
	if (changes.provider !== undefined) {
		updates.push(changes.provider === "auto" ? { path: ["webSearch", "provider"], remove: true } : { path: ["webSearch", "provider"], value: changes.provider });
	}
	if (changes.fetchEnabled !== undefined) {
		const fetchObject = asRecord(webObject.fetch) ?? {};
		updates.push({ path: ["webSearch", "fetch"], value: { ...fetchObject, enabled: changes.fetchEnabled } });
	}
	return updates;
}
