import { AUTORAG_PROVIDER_ID } from "./account-contract";

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
const JEV_MODELS_BY_BACKEND: Readonly<Record<JevBackend, readonly RoleModel[]>> = {
	autorag: [{ id: "jev-1.13", label: "Jev 1.13" }],
	typesafe: [{ id: "jev-latest", label: "Jev (최신)" }],
	openrouter: [
		{ id: "typesafe/jev-1.13", label: "Jev 1.13" },
		{ id: "typesafe/jev-latest", label: "Jev (최신)" },
	],
	vercel: [{ id: "typesafe/jev-latest", label: "Jev (최신)" }],
};

/** Rerank model ids each provider serves (rerank is not a general LLM role). */
const RERANK_MODELS_BY_PROVIDER: Readonly<Record<string, readonly RoleModel[]>> = {
	[AUTORAG_PROVIDER_ID]: [
		{ id: "qwen/qwen3-reranker-8b", label: "Qwen3 Reranker 8B" },
		{ id: "nvidia/llama-nemotron-rerank-vl-1b-v2:free", label: "Nemotron Rerank VL 1B (무료)" },
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
	return backend === undefined ? [] : JEV_MODELS_BY_BACKEND[backend];
}

export function rerankModelsFor(providerId: string): readonly RoleModel[] {
	return RERANK_MODELS_BY_PROVIDER[providerId] ?? [];
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

/**
 * Classify a role block: `unset` for `undefined`, `{}` or the librarian's
 * untouched default, `autorag` when its `key` names the AutoRAG plan, otherwise
 * `other` (an explicit `false`, another backend/provider, or a malformed value,
 * all of which are the user's choice).
 */
function roleOwner(value: unknown, key: "backend" | "provider"): "unset" | "autorag" | "other" {
	if (value === undefined) return "unset";
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "other";
	const entries = Object.entries(value);
	if (entries.length === 0) return "unset";
	if (entries.some(([name, named]) => name === key && named === AUTORAG_PROVIDER_ID)) return "autorag";
	const untouched = Object.entries(UNTOUCHED_DEFAULTS[key]);
	return entries.length === untouched.length && untouched.every(([name, expected]) => entries.some(([entryName, entryValue]) => entryName === name && entryValue === expected)) ? "unset" : "other";
}

/**
 * Per role: may signing in point it at the AutoRAG plan? Only when the config
 * names nothing for it, or it already names AutoRAG.
 */
export function shouldAdoptManagedRoles(config: { readonly jev?: unknown; readonly rerank?: unknown }): { readonly jev: boolean; readonly rerank: boolean } {
	return {
		jev: roleOwner(config.jev, "backend") !== "other",
		rerank: roleOwner(config.rerank, "provider") !== "other",
	};
}

export interface ManagedRoleUpdates {
	readonly jev?: { readonly backend: "autorag"; readonly model: string };
	readonly rerank?: { readonly enabled: true; readonly provider: "autorag"; readonly model: string };
}

/** The config blocks to write for the roles that may be adopted, using the server's first model for each. */
export function managedRoleUpdates(
	adopt: { readonly jev: boolean; readonly rerank: boolean },
	jevModels: readonly { readonly id: string }[],
	rerankModels: readonly { readonly id: string }[],
): ManagedRoleUpdates {
	const jevModel = jevModels[0];
	const rerankModel = rerankModels[0];
	return {
		...(adopt.jev && jevModel !== undefined ? { jev: { backend: "autorag" as const, model: jevModel.id } } : {}),
		...(adopt.rerank && rerankModel !== undefined ? { rerank: { enabled: true as const, provider: "autorag" as const, model: rerankModel.id } } : {}),
	};
}
