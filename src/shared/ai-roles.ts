import { AUTORAG_PROVIDER_ID } from "./account-contract";
import { t } from "./i18n/core";

export { providerConnectRoute, withoutAutorag } from "./account-contract";

/**
 * The Jev and rerank roles are not general LLM roles: each backend serves a
 * fixed set of wire model ids. This module holds those tables and the rules
 * for adopting the AutoRAG plan as the backend, so the Settings picker and the
 * account service read one source.
 */

export type JevBackend = "autorag" | "typesafe" | "openrouter" | "vercel";

export interface RoleModel {
	readonly id: string;
	readonly label: string;
}

/** A catalog entry: `labelKey` translates at read time, `label` stays verbatim. */
interface RoleModelSpec {
	readonly id: string;
	readonly label?: string;
	readonly labelKey?: "finderState.roles.jevLatest" | "finderState.roles.rerankFree";
}

/**
 * Jev backend a Pi provider id maps to. `jev-use` resolves typesafe /
 * openrouter / vercel; the hosted plan is the `autorag` backend. The Vercel AI
 * Gateway provider id is `vercel-ai-gateway`, not `vercel`.
 */
const JEV_BACKEND_BY_PROVIDER: Readonly<Record<string, JevBackend>> = {
	[AUTORAG_PROVIDER_ID]: "autorag",
	typesafe: "typesafe",
	openrouter: "openrouter",
	"vercel-ai-gateway": "vercel",
};

/** The Jev model ids each backend accepts. */
const JEV_MODELS_BY_BACKEND: Readonly<Record<JevBackend, readonly RoleModelSpec[]>> = {
	autorag: [{ id: "jev-1.13", label: "Jev 1.13" }],
	typesafe: [{ id: "jev-latest", labelKey: "finderState.roles.jevLatest" }],
	openrouter: [
		{ id: "typesafe/jev-1.13", label: "Jev 1.13" },
		{ id: "typesafe/jev-latest", labelKey: "finderState.roles.jevLatest" },
	],
	vercel: [{ id: "typesafe/jev-latest", labelKey: "finderState.roles.jevLatest" }],
};

/** Rerank model ids each provider serves (rerank is not a general LLM role). */
const RERANK_MODELS_BY_PROVIDER: Readonly<Record<string, readonly RoleModelSpec[]>> = {
	[AUTORAG_PROVIDER_ID]: [
		{ id: "qwen/qwen3-reranker-8b", label: "Qwen3 Reranker 8B" },
		{ id: "nvidia/llama-nemotron-rerank-vl-1b-v2:free", labelKey: "finderState.roles.rerankFree" },
	],
	openrouter: [
		{ id: "voyageai/rerank-3-lite", label: "Voyage Rerank 3 Lite" },
		{ id: "voyageai/rerank-3", label: "Voyage Rerank 3" },
		{ id: "cohere/rerank-v3.5", label: "Cohere Rerank 3.5" },
		{ id: "cohere/rerank-4-fast", label: "Cohere Rerank 4 Fast" },
	],
};

export function jevBackendFor(providerId: string): JevBackend | undefined {
	return JEV_BACKEND_BY_PROVIDER[providerId];
}

export function jevModelsFor(providerId: string): readonly RoleModel[] {
	const backend = JEV_BACKEND_BY_PROVIDER[providerId];
	if (backend === undefined) return [];
	return JEV_MODELS_BY_BACKEND[backend].map(({ id, label, labelKey }) => ({
		id,
		label: labelKey === undefined ? (label ?? id) : t(labelKey),
	}));
}

export function rerankModelsFor(providerId: string): readonly RoleModel[] {
	const specs = RERANK_MODELS_BY_PROVIDER[providerId];
	if (specs === undefined) return [];
	return specs.map(({ id, label, labelKey }) => ({
		id,
		label: labelKey === undefined ? (label ?? id) : t(labelKey),
	}));
}

/**
 * What the librarian writes into a fresh config for these roles
 * (`writeDefaultConfig`: `jev: {backend: "openrouter"}` and the OpenRouter
 * rerank block). A block that matches one exactly was never chosen by the
 * user, so it counts as unset; any difference is a deliberate choice.
 */
const UNTOUCHED_DEFAULTS: Readonly<Record<"backend" | "provider", Readonly<Record<string, string | number>>>> = {
	backend: { backend: "openrouter" },
	provider: { provider: "openrouter", model: "voyageai/rerank-3-lite", apiKeyEnv: "OPENROUTER_API_KEY", topN: 25 },
};

/** Keys an AutoRAG role block may carry and still be ours to refresh (anything else is the user's tuning). */
const REFRESHABLE_KEYS: Readonly<Record<"backend" | "provider", readonly string[]>> = {
	backend: ["backend", "model"],
	provider: ["provider", "model", "enabled"],
};

/**
 * Classify a role block: `unset` for `undefined`, `{}` or the librarian's
 * untouched default; `autorag` for an AutoRAG block that is on and carries
 * only the plan and a model; otherwise `other`: an explicit `false`, another
 * backend/provider, a malformed value, or an AutoRAG block the user switched
 * off (`enabled: false`) or tuned (`topN`, `baseUrl`, `confidenceThreshold`...).
 */
function roleOwner(value: unknown, key: "backend" | "provider"): "unset" | "autorag" | "other" {
	if (value === undefined) return "unset";
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "other";
	const entries = Object.entries(value);
	if (entries.length === 0) return "unset";
	if (entries.some(([name, named]) => name === key && named === AUTORAG_PROVIDER_ID)) {
		const refreshable = entries.every(([name, named]) => REFRESHABLE_KEYS[key].includes(name) && (name !== "enabled" || named === true));
		return refreshable ? "autorag" : "other";
	}
	const untouched = Object.entries(UNTOUCHED_DEFAULTS[key]);
	return entries.length === untouched.length && untouched.every(([name, expected]) => entries.some(([entryName, entryValue]) => entryName === name && entryValue === expected)) ? "unset" : "other";
}

/**
 * Per role: may signing in point it at the AutoRAG plan? Only when the config
 * names nothing for it, or it already names AutoRAG without anything to keep.
 */
export function shouldAdoptManagedRoles(config: { readonly jev?: unknown; readonly rerank?: unknown }): { readonly jev: boolean; readonly rerank: boolean } {
	return {
		jev: roleOwner(config.jev, "backend") !== "other",
		rerank: roleOwner(config.rerank, "provider") !== "other",
	};
}

/** The decomposition model the librarian writes into a fresh config. */
const UNTOUCHED_DECOMPOSITION_ID = "qwen/qwen3.7-flash";

/**
 * Question decomposition: adoptable when absent, `{}`, already an AutoRAG
 * model, or the librarian's untouched default. A deliberate OpenRouter pick,
 * `false` ("decompose with the answer model") and anything else stay.
 */
export function shouldAdoptManagedDecomposition(value: unknown): boolean {
	if (value === undefined) return true;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const entries = Object.entries(value);
	if (entries.length === 0) return true;
	const [only] = entries;
	if (entries.length !== 1 || only === undefined || only[0] !== "model") return false;
	const model = only[1];
	if (typeof model !== "object" || model === null || Array.isArray(model)) return false;
	const fields = Object.entries(model);
	if (fields.some(([name, named]) => name === "provider" && named === AUTORAG_PROVIDER_ID)) return true;
	return fields.length === 2 && fields.every(([name, named]) => (name === "provider" && named === "openrouter") || (name === "id" && named === UNTOUCHED_DECOMPOSITION_ID));
}

export interface ManagedRoleUpdates {
	readonly jev?: { readonly backend: "autorag"; readonly model: string };
	readonly rerank?: { readonly enabled: true; readonly provider: "autorag"; readonly model: string };
}

/**
 * The config blocks to write for the roles that may be adopted. A model the
 * existing AutoRAG block names is kept while the server still lists it;
 * otherwise the server's first model is used.
 */
export function managedRoleUpdates(
	adopt: { readonly jev: boolean; readonly rerank: boolean },
	jevModels: readonly { readonly id: string }[],
	rerankModels: readonly { readonly id: string }[],
	current: { readonly jev?: unknown; readonly rerank?: unknown } = {},
): ManagedRoleUpdates {
	const jevModel = pickModel(jevModels, current.jev);
	const rerankModel = pickModel(rerankModels, current.rerank);
	return {
		...(adopt.jev && jevModel !== undefined ? { jev: { backend: "autorag" as const, model: jevModel } } : {}),
		...(adopt.rerank && rerankModel !== undefined ? { rerank: { enabled: true as const, provider: "autorag" as const, model: rerankModel } } : {}),
	};
}

function pickModel(models: readonly { readonly id: string }[], block: unknown): string | undefined {
	const named = typeof block === "object" && block !== null && "model" in block ? block.model : undefined;
	return models.find((model) => model.id === named)?.id ?? models[0]?.id;
}
