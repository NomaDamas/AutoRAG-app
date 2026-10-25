import { jevBackendFor } from "./ai-roles";
import type { AutoRagConfigUpdate, ModelCatalogEntry } from "./settings-contract";

/**
 * Wire protocols accepted by the shared AutoRAG config for `model.api` (upstream
 * `AGENT_MODEL_APIS`). Other Pi catalog protocols (e.g. google-generative-ai)
 * are supported by omitting `api` and letting the catalog model supply its own
 * transport — the config `api` is only an override and must be one of these.
 */
const ALLOWED_AGENT_APIS: readonly string[] = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"openai-codex-responses",
	"azure-openai-responses",
];

export function isAllowedAgentApi(api: string): boolean {
	return ALLOWED_AGENT_APIS.includes(api);
}

/**
 * The leaf writes that make `entry` the answer model. Settings → AI 모델 and the
 * onboarding model step both save through this, so the two always agree on what
 * a chosen model looks like in the config.
 */
export function modelConfigUpdates(entry: ModelCatalogEntry): AutoRagConfigUpdate[] {
	const name = entry.name.trim();
	const baseUrl = (entry.baseUrl ?? "").trim();
	const env = (entry.apiKeyEnv ?? "").trim();
	return [
		{ path: ["model", "provider"], value: entry.provider },
		{ path: ["model", "id"], value: entry.id },
		name.length > 0 ? { path: ["model", "name"], value: name } : { path: ["model", "name"], remove: true },
		entry.api.length > 0 && isAllowedAgentApi(entry.api) ? { path: ["model", "api"], value: entry.api } : { path: ["model", "api"], remove: true },
		baseUrl.length > 0 ? { path: ["model", "baseUrl"], value: baseUrl } : { path: ["model", "baseUrl"], remove: true },
		env.length > 0 ? { path: ["model", "apiKeyEnv"], value: env } : { path: ["model", "apiKeyEnv"], remove: true },
	];
}

/** The leaf write that makes `entry` the Jev model, with the backend its provider serves. */
export function jevConfigUpdates(entry: ModelCatalogEntry): AutoRagConfigUpdate[] {
	const backend = jevBackendFor(entry.provider);
	return [{ path: ["jev"], value: { model: entry.id, ...(backend === undefined ? {} : { backend }) } }];
}

/** The leaf write that enables the reranker on the provider and model `entry` names. */
export function rerankConfigUpdates(entry: ModelCatalogEntry): AutoRagConfigUpdate[] {
	return [{ path: ["rerank"], value: { enabled: true, provider: entry.provider, model: entry.id } }];
}
