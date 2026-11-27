import { JEV_SLLM_BACKEND, jevBackendFor } from "./ai-roles";
import { isJsonObject, type AutoRagConfigUpdate, type JsonObject, type ModelCatalogEntry } from "./settings-contract";

/**
 * Wire protocols accepted by the shared AutoRAG config for `model.api` (upstream
 * `AGENT_MODEL_APIS`). Other Pi catalog protocols (e.g. google-generative-ai)
 * are supported by omitting `api` and letting the catalog model supply its own
 * transport — the config `api` is only an override and must be one of these.
 */
export const ALLOWED_AGENT_APIS: readonly string[] = [
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

/** The write that makes `entry` the question-decomposition model, in the same shape as the answer model. */
export function decompositionConfigUpdates(entry: ModelCatalogEntry): AutoRagConfigUpdate[] {
	const model: Record<string, string> = { provider: entry.provider, id: entry.id };
	const name = entry.name.trim();
	const baseUrl = (entry.baseUrl ?? "").trim();
	const env = (entry.apiKeyEnv ?? "").trim();
	if (name.length > 0) model.name = name;
	if (entry.api.length > 0 && isAllowedAgentApi(entry.api)) model.api = entry.api;
	if (baseUrl.length > 0) model.baseUrl = baseUrl;
	if (env.length > 0) model.apiKeyEnv = env;
	return [{ path: ["queryDecomposition"], value: { model } }];
}

/** The leaf write that makes `entry` the Jev model, with the backend its provider serves. */
export function jevConfigUpdates(entry: ModelCatalogEntry): AutoRagConfigUpdate[] {
	const backend = jevBackendFor(entry.provider);
	return [{ path: ["jev"], value: { model: entry.id, ...(backend === undefined ? {} : { backend }) } }];
}

/** The leaf write that makes the small chat model the decision model; it replaces any Jev backend and model. */
export function jevSllmConfigUpdates(): AutoRagConfigUpdate[] {
	return [{ path: ["jev"], value: { backend: JEV_SLLM_BACKEND } }];
}

/** The leaf write that enables the reranker on the provider and model `entry` names. */
export function rerankConfigUpdates(entry: ModelCatalogEntry): AutoRagConfigUpdate[] {
	return [{ path: ["rerank"], value: { enabled: true, provider: entry.provider, model: entry.id } }];
}

function existingVisualParseObject(config: JsonObject | undefined): Record<string, unknown> {
	const raw = config?.visualParse;
	return isJsonObject(raw) ? { ...raw } : {};
}

function modelRefFromEntry(entry: ModelCatalogEntry): Record<string, string> {
	const model: Record<string, string> = { provider: entry.provider, id: entry.id };
	const name = entry.name.trim();
	const baseUrl = (entry.baseUrl ?? "").trim();
	const env = (entry.apiKeyEnv ?? "").trim();
	if (name.length > 0) model.name = name;
	if (entry.api.length > 0 && isAllowedAgentApi(entry.api)) model.api = entry.api;
	if (baseUrl.length > 0) model.baseUrl = baseUrl;
	if (env.length > 0) model.apiKeyEnv = env;
	return model;
}

/** Enable visual-rich page parsing with a VLM model, keeping any existing gate/ocr/limit settings intact. */
export function visualParseVlmConfigUpdates(entry: ModelCatalogEntry, currentConfig?: JsonObject): AutoRagConfigUpdate[] {
	const base = existingVisualParseObject(currentConfig);
	return [
		{
			path: ["visualParse"],
			value: {
				...base,
				enabled: true,
				extractor: { kind: "vlm", model: modelRefFromEntry(entry) },
			} as JsonObject,
		},
	];
}

/**
 * Turn off the VLM extractor while preserving an active OCR engine if one is configured;
 * if OCR is also off, turns `visualParse` completely off (`false`).
 */
export function visualParseVlmOffConfigUpdates(currentConfig?: JsonObject): AutoRagConfigUpdate[] {
	const base = existingVisualParseObject(currentConfig);
	if (base.ocr === undefined || base.ocr === false) {
		return [{ path: ["visualParse"], value: false }];
	}
	const { extractor: _extractor, ...rest } = base;
	return [
		{
			path: ["visualParse"],
			value: {
				...rest,
				enabled: true,
			} as JsonObject,
		},
	];
}

/** Set the Stage 2 OCR engine to a local engine (`"auto"`, `"kordoc"`, or `"tesseract"`), keeping any VLM/gate settings intact. */
export function visualParseOcrLocalConfigUpdates(
	engine: "auto" | "kordoc" | "tesseract",
	currentConfig?: JsonObject,
): AutoRagConfigUpdate[] {
	const base = existingVisualParseObject(currentConfig);
	return [
		{
			path: ["visualParse"],
			value: {
				...base,
				enabled: true,
				ocr: { engine },
			} as JsonObject,
		},
	];
}

/** Set the Stage 2 OCR model to a remote vision/OCR model, keeping any VLM/gate settings intact. */
export function visualParseOcrRemoteConfigUpdates(entry: ModelCatalogEntry, currentConfig?: JsonObject): AutoRagConfigUpdate[] {
	const base = existingVisualParseObject(currentConfig);
	return [
		{
			path: ["visualParse"],
			value: {
				...base,
				enabled: true,
				ocr: { engine: "vlm", model: modelRefFromEntry(entry) },
			} as JsonObject,
		},
	];
}

/**
 * Turn off Stage 2 OCR while preserving a configured VLM extractor if one is active;
 * if no VLM extractor is set, turns `visualParse` completely off (`false`).
 */
export function visualParseOcrOffConfigUpdates(currentConfig?: JsonObject): AutoRagConfigUpdate[] {
	const base = existingVisualParseObject(currentConfig);
	const extractor = isJsonObject(base.extractor) ? base.extractor : null;
	if (extractor?.kind === "vlm") {
		return [
			{
				path: ["visualParse"],
				value: {
					...base,
					enabled: true,
					ocr: false,
				} as JsonObject,
			},
		];
	}
	return [{ path: ["visualParse"], value: false }];
}

/** Legacy helper: enable Stage 2 visual parsing with local auto OCR. */
export function visualParseOcrConfigUpdates(currentConfig?: JsonObject): AutoRagConfigUpdate[] {
	return visualParseOcrLocalConfigUpdates("auto", currentConfig);
}

/** Turn visual-rich page parsing (both VLM and OCR) completely off. */
export function visualParseOffConfigUpdates(): AutoRagConfigUpdate[] {
	return [{ path: ["visualParse"], value: false }];
}
