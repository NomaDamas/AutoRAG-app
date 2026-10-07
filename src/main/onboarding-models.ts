import type {
	ByokProviderId,
	DetectedModelProvider,
	ModelOption,
	ModelVerifyRequest,
	ModelVerifyResult,
} from "../shared/onboarding-contract";
import type { ModelCatalogSnapshot } from "../shared/settings-contract";
import { isJsonObject } from "../shared/settings-contract";
import type { ProviderCredentialService } from "./provider-credentials";

/**
 * The model step (BYOK only). Detection reads the environment and the encrypted
 * credential store; verification calls the provider once with the key the user
 * typed (or the one already stored). A key that verifies is written to the
 * encrypted store — never to the shared config, and never back to the renderer.
 */

/** Env var each provider's key lives in; `null` when the provider is keyless (Ollama). */
export const PROVIDER_ENV_NAME: Readonly<Record<ByokProviderId, string | null>> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	google: "GEMINI_API_KEY",
	ollama: null,
	"openai-compatible": "OPENAI_COMPATIBLE_API_KEY",
};

/** Model-id fragments a sensible default is chosen from, best first. */
const PREFERRED_MODELS: Readonly<Record<ByokProviderId, readonly string[]>> = {
	anthropic: ["claude-sonnet-4-5", "claude-sonnet-4", "claude-3-7-sonnet", "claude-3-5-sonnet"],
	openai: ["gpt-5-mini", "gpt-5", "gpt-4.1", "gpt-4o"],
	openrouter: ["claude-sonnet-4-5", "claude-sonnet-4", "gpt-5", "deepseek"],
	google: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
	ollama: [],
	"openai-compatible": [],
};

const DETECTION_ORDER: readonly ByokProviderId[] = ["anthropic", "openai", "openrouter", "google", "ollama"];
const OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_TIMEOUT_MS = 10_000;

export type ModelFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ModelDetectionDeps {
	readonly env: NodeJS.ProcessEnv;
	readonly credentials: Pick<ProviderCredentialService, "list" | "set">;
	readonly fetchFn: ModelFetch;
	/** Pi's catalog, used for the OpenRouter model list and for display names. */
	readonly modelsCatalog: () => Promise<ModelCatalogSnapshot>;
	readonly timeoutMs?: number;
}

function recommendedFor(provider: ByokProviderId, models: readonly ModelOption[]): string {
	for (const fragment of PREFERRED_MODELS[provider]) {
		const match = models.find((model) => model.id.toLowerCase().includes(fragment));
		if (match !== undefined) return match.id;
	}
	return models[0]?.id ?? "";
}

function optionsFromCatalog(catalog: ModelCatalogSnapshot, providerIds: readonly string[]): ModelOption[] {
	const options: ModelOption[] = [];
	for (const provider of catalog.providers) {
		if (!providerIds.includes(provider.id)) continue;
		for (const model of provider.models) options.push({ id: model.id, name: model.name });
	}
	return options;
}

/** Merge provider-returned ids with catalog display names, de-duplicated by id. */
function mergeModels(catalog: ModelCatalogSnapshot, providerIds: readonly string[], fetched: readonly ModelOption[]): ModelOption[] {
	const names = new Map(optionsFromCatalog(catalog, providerIds).map((model) => [model.id, model.name]));
	const merged: ModelOption[] = [];
	const seen = new Set<string>();
	for (const model of fetched) {
		if (model.id.length === 0 || seen.has(model.id)) continue;
		seen.add(model.id);
		merged.push({ id: model.id, name: names.get(model.id) ?? model.name });
	}
	return merged;
}

async function jsonBody(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

function stringField(value: unknown, key: string): string | null {
	if (!isJsonObject(value)) return null;
	const field = value[key];
	return typeof field === "string" ? field : null;
}

export async function detectModelProviders(deps: ModelDetectionDeps): Promise<readonly DetectedModelProvider[]> {
	const detected: DetectedModelProvider[] = [];
	for (const provider of DETECTION_ORDER) {
		const envName = PROVIDER_ENV_NAME[provider];
		if (envName === null) {
			try {
				const response = await fetchWithTimeout(deps, `${OLLAMA_URL}/api/tags`, {});
				if (response.ok) detected.push({ provider, origin: "local", envName: null });
			} catch {
				// Not running; skip.
			}
			continue;
		}
		const external = deps.env[envName];
		if (typeof external === "string" && external.length > 0) {
			detected.push({ provider, origin: "env", envName });
			continue;
		}
		const stored = deps.credentials.list([envName]).some((status) => status.stored);
		if (stored) detected.push({ provider, origin: "stored", envName });
	}
	return detected;
}

async function fetchWithTimeout(deps: ModelDetectionDeps, url: string, init: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS).unref();
	try {
		return await deps.fetchFn(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

function failure(response: Response, detail: string): string {
	return detail.length > 0 ? `${response.status}: ${detail}` : `HTTP ${response.status}`;
}

async function fetchAnthropic(deps: ModelDetectionDeps, key: string): Promise<ModelOption[]> {
	const response = await fetchWithTimeout(deps, "https://api.anthropic.com/v1/models", {
		headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
	});
	if (!response.ok) throw new Error(failure(response, ""));
	const body = await jsonBody(response);
	const data = isJsonObject(body) && Array.isArray(body.data) ? body.data : [];
	const models: ModelOption[] = [];
	for (const item of data) {
		const id = stringField(item, "id");
		if (id !== null) models.push({ id, name: stringField(item, "display_name") ?? id });
	}
	return models;
}

async function fetchOpenai(deps: ModelDetectionDeps, key: string, baseUrl?: string): Promise<ModelOption[]> {
	const url = baseUrl === undefined ? "https://api.openai.com/v1/models" : `${baseUrl.replace(/\/+$/u, "")}/models`;
	const headers: Record<string, string> = {};
	if (key.length > 0) headers.Authorization = `Bearer ${key}`;
	const response = await fetchWithTimeout(deps, url, { headers });
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(failure(response, text.slice(0, 200)));
	}
	const body = await jsonBody(response);
	const data = isJsonObject(body) && Array.isArray(body.data) ? body.data : [];
	const models: ModelOption[] = [];
	for (const item of data) {
		const id = stringField(item, "id");
		if (id !== null) models.push({ id, name: id });
	}
	return models;
}

async function fetchOpenrouter(deps: ModelDetectionDeps, key: string): Promise<ModelOption[]> {
	const response = await fetchWithTimeout(deps, "https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` } });
	if (!response.ok) throw new Error(failure(response, ""));
	const catalog = await deps.modelsCatalog();
	return mergeModels(catalog, ["openrouter"], optionsFromCatalog(catalog, ["openrouter"]));
}

async function fetchGoogle(deps: ModelDetectionDeps, key: string): Promise<ModelOption[]> {
	const response = await fetchWithTimeout(deps, `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`, {});
	if (!response.ok) throw new Error(failure(response, ""));
	const body = await jsonBody(response);
	const data = isJsonObject(body) && Array.isArray(body.models) ? body.models : [];
	const models: ModelOption[] = [];
	for (const item of data) {
		const name = stringField(item, "name");
		if (name === null) continue;
		const id = name.replace(/^models\//u, "");
		models.push({ id, name: stringField(item, "displayName") ?? id });
	}
	return models;
}

async function fetchOllama(deps: ModelDetectionDeps): Promise<ModelOption[]> {
	const response = await fetchWithTimeout(deps, `${OLLAMA_URL}/api/tags`, {});
	if (!response.ok) throw new Error(failure(response, ""));
	const body = await jsonBody(response);
	const data = isJsonObject(body) && Array.isArray(body.models) ? body.models : [];
	const models: ModelOption[] = [];
	for (const item of data) {
		const id = stringField(item, "name") ?? stringField(item, "model");
		if (id !== null) models.push({ id, name: id });
	}
	return models;
}

export async function verifyModel(deps: ModelDetectionDeps, request: ModelVerifyRequest): Promise<ModelVerifyResult> {
	const envName = PROVIDER_ENV_NAME[request.provider];
	const storedOrEnv = envName === null ? undefined : deps.env[envName];
	const key = request.apiKey ?? (typeof storedOrEnv === "string" ? storedOrEnv : "");
	try {
		let models: ModelOption[];
		let catalogIds: readonly string[] = [];
		switch (request.provider) {
			case "anthropic":
				if (key.length === 0) return { ok: false, error: "API 키가 필요합니다." };
				catalogIds = ["anthropic"];
				models = await fetchAnthropic(deps, key);
				break;
			case "openai":
				if (key.length === 0) return { ok: false, error: "API 키가 필요합니다." };
				catalogIds = ["openai"];
				models = await fetchOpenai(deps, key);
				break;
			case "openrouter":
				if (key.length === 0) return { ok: false, error: "API 키가 필요합니다." };
				models = await fetchOpenrouter(deps, key);
				break;
			case "google":
				if (key.length === 0) return { ok: false, error: "API 키가 필요합니다." };
				catalogIds = ["google"];
				models = await fetchGoogle(deps, key);
				break;
			case "ollama":
				models = await fetchOllama(deps);
				break;
			case "openai-compatible": {
				if (request.baseUrl === null || request.baseUrl.length === 0) return { ok: false, error: "서버 주소(base URL)가 필요합니다." };
				models = await fetchOpenai(deps, key, request.baseUrl);
				break;
			}
		}
		if (catalogIds.length > 0 && models.length > 0) {
			const catalog = await deps.modelsCatalog();
			models = mergeModels(catalog, catalogIds, models);
		}
		if (request.apiKey !== null && envName !== null && request.apiKey.length > 0) {
			deps.credentials.set(envName, request.apiKey);
		}
		return { ok: true, envName, models, recommended: recommendedFor(request.provider, models) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
