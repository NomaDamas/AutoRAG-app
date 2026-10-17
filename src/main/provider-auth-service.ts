import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";
import type { AuthEvent, AuthPrompt, AuthType, Provider } from "@earendil-works/pi-ai";
import type {
	DiscoveredModel,
	ProviderAuthKind,
	ProviderConnectionResult,
	ProviderDiscoveryResult,
	ProviderKind,
	ProviderLoginEvent,
	ProviderLoginPrompt,
	ProviderLoginStartResult,
	ProviderServerInput,
	ProviderSummary,
} from "../shared/settings-contract";
import { isJsonObject } from "../shared/settings-contract";
import type { ProviderCredentialService } from "./provider-credentials";
import { registerDazziProvider } from "@autorag/librarian";
import { AUTORAG_PROVIDER_ID, autoragFirst } from "../shared/account-contract";
import { readDazziPlanCredential } from "./dazzi-plan-credential";

/**
 * Real Pi provider authentication: `/login` OAuth and API-key flows driven by
 * the same `ModelRuntime` and `~/.pi/agent/auth.json` the librarian uses, plus
 * local/custom OpenAI-compatible servers persisted to `~/.pi/agent/models.json`
 * (their optional key lives only in the encrypted credential store, never on
 * disk in plaintext).
 */
export interface ProviderAuthService {
	/** Every runtime provider (built-in + models.json custom/local) with its live auth state. */
	list(): Promise<readonly ProviderSummary[]>;
	start(providerId: string, authType: ProviderAuthKind): Promise<ProviderLoginStartResult>;
	respond(sessionId: string, value: string): Promise<void>;
	cancel(sessionId: string): Promise<void>;
	logout(providerId: string): Promise<void>;
	/** Probes a local/custom server and returns only the models it actually reports. */
	discover(input: ProviderServerInput): Promise<ProviderDiscoveryResult>;
	/** Adds or edits a local/custom provider (discovering its models) and returns the fresh list. */
	upsert(input: ProviderServerInput): Promise<readonly ProviderSummary[]>;
	/** Removes a local/custom provider and its stored key; returns the fresh list. */
	remove(id: string): Promise<readonly ProviderSummary[]>;
	/** Re-probes a saved provider's server for a connection check. */
	test(id: string): Promise<ProviderConnectionResult>;
	/** Bridge auth.json-stored OpenRouter/Vercel keys into the process env Jev/rerank read. */
	warmEnv(): Promise<void>;
	/** Fetch the signed-in account's model catalog into the runtime (no-op when signed out or offline). */
	syncAutoragCatalog(): Promise<void>;
	/** Cancel active logins and detach the process-env bridges this service injected. */
	dispose(): Promise<void>;
}

export interface ProviderAuthServiceDeps {
	readonly send: (event: ProviderLoginEvent) => void;
	readonly env: NodeJS.ProcessEnv;
	/** Encrypted store for local/custom provider keys. */
	readonly credentials: ProviderCredentialService;
	/** Pi agent dir holding auth.json/models.json. Defaults to {@link getAgentDir}. */
	readonly agentDir?: string;
	/** Fetch used for discovery/probes; injectable for tests. */
	readonly fetch?: typeof globalThis.fetch;
	/** Discovery/probe timeout in ms. */
	readonly timeoutMs?: number;
}

interface Pending {
	readonly resolve: (value: string) => void;
	readonly reject: (error: Error) => void;
}

interface Session {
	readonly providerId: string;
	readonly authType: ProviderAuthKind;
	readonly controller: AbortController;
	pending?: Pending;
}

const DEFAULT_CUSTOM_API = "openai-completions";
const DEFAULT_TIMEOUT_MS = 8000;
/** Cheapest models tried per connection check, and the budget for all of them together. */
const CONNECTION_PROBE_ATTEMPTS = 4;
const CONNECTION_TEST_TIMEOUT_MS = 30_000;
/** opencode-style gateways refuse a request that carries no session id. */
const CONNECTION_PROBE_SESSION_ID = "autorag-connection-check";

/**
 * Catalog models in the order a connection check should try them: paid models
 * by ascending price, then unpriced ones. Free-tier models go last because they
 * can be restricted to their own client or rate-limited while the connection works.
 */
export function rankConnectionProbeModels<T extends { readonly cost: { readonly input: number; readonly output: number } }>(models: readonly T[]): T[] {
	const price = (model: T): number => {
		const total = model.cost.input + model.cost.output;
		return Number.isFinite(total) && total > 0 ? total : 0;
	};
	const paid = models.filter((model) => price(model) > 0).sort((a, b) => price(a) - price(b));
	return [...paid, ...models.filter((model) => price(model) === 0)];
}

/** Hosts that mean "this device" for local-server validation. */
const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true, "::1": true, "[::1]": true };

/** Providers whose resolved key also feeds the env-driven Jev/rerank backends. */
const ENV_BRIDGES: ReadonlyArray<{ readonly providerId: string; readonly envName: string }> = [
	{ providerId: "openrouter", envName: "OPENROUTER_API_KEY" },
	{ providerId: "vercel-ai-gateway", envName: "AI_GATEWAY_API_KEY" },
];

function authKinds(provider: Provider): ProviderAuthKind[] {
	const kinds: ProviderAuthKind[] = [];
	if (provider.auth.apiKey !== undefined) kinds.push("api_key");
	if (provider.auth.oauth !== undefined) kinds.push("oauth");
	return kinds;
}

function mapAuthSource(source: string | undefined): ProviderSummary["authSource"] {
	switch (source) {
		case "stored":
			return "stored";
		case "environment":
			return "environment";
		case "runtime":
		case "models_json_key":
		case "models_json_command":
		case "fallback":
			return "runtime";
		default:
			return "none";
	}
}

function promptFor(prompt: AuthPrompt): ProviderLoginPrompt {
	if (prompt.type === "select") return { type: "select", message: prompt.message, options: prompt.options };
	return {
		type: prompt.type,
		message: prompt.message,
		...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
	};
}

/** First `$VAR` / `${VAR}` reference in a models.json config value. */
function configValueEnvName(config: string | undefined): string | null {
	if (typeof config !== "string") return null;
	const match = config.match(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/u);
	return match?.[1] ?? null;
}

function providerEnvName(id: string): string {
	return `AUTORAG_PROVIDER_${id.replace(/[^A-Za-z0-9]/gu, "_").toUpperCase()}_API_KEY`;
}

function slugify(label: string): string {
	const slug = label
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-+|-+$/gu, "");
	return slug.length > 0 ? slug.slice(0, 32) : "server";
}

/** Validate and normalize a local/custom server URL. Throws with a precise reason. */
function normalizeServerUrl(input: ProviderServerInput): { readonly baseUrl: string; readonly url: URL } {
	const label = input.label?.trim() ?? "";
	if (label.length === 0) throw new Error("Provider name must not be empty");
	if (typeof input.baseUrl !== "string" || input.baseUrl.trim().length === 0) throw new Error("Server address must not be empty");
	let url: URL;
	try {
		url = new URL(input.baseUrl.trim());
	} catch {
		throw new Error("Server address must be a valid URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Server address must use http or https");
	if (input.kind === "local" && LOOPBACK_HOSTS[url.hostname.toLowerCase()] !== true) {
		throw new Error("Local servers must be on this device (localhost or 127.0.0.1)");
	}
	const baseUrl = input.baseUrl.trim().replace(/\/+$/u, "");
	return { baseUrl, url };
}

async function readModelsJson(path: string): Promise<Record<string, unknown>> {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		return isJsonObject(parsed) ? { ...parsed } : {};
	} catch (error) {
		throw new Error(`models.json is unreadable; refusing to overwrite it (${String(error)})`);
	}
}

async function writeModelsJson(path: string, raw: Record<string, unknown>): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(raw, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
}

function modelsJsonProviders(raw: Record<string, unknown>): Record<string, unknown> {
	return isJsonObject(raw.providers) ? { ...raw.providers } : {};
}

export function createProviderAuthService(deps: ProviderAuthServiceDeps): ProviderAuthService {
	const agentDir = deps.agentDir ?? getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const modelsPath = join(agentDir, "models.json");
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const fetchImpl = deps.fetch ?? globalThis.fetch;
	const sessions = new Map<string, Session>();
	// The hosted AutoRAG plan is its own provider; it must exist on this runtime
	// for `/login`, the provider list, and its persisted model catalog.
	const runtimePromise = ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false }).then(async (created) => {
		await registerDazziProvider(created, deps.env);
		return created;
	});
	/** Process env values this service injected, keyed by env name. */
	const injected = new Map<string, { readonly providerId: string; readonly value: string }>();

	const notify = (sessionId: string, event: AuthEvent): void => {
		if (event.type === "auth_url") {
			deps.send({
				type: "auth_url",
				sessionId,
				url: event.url,
				...(event.instructions === undefined ? {} : { instructions: event.instructions }),
			});
			return;
		}
		if (event.type === "device_code") {
			deps.send({
				type: "device_code",
				sessionId,
				userCode: event.userCode,
				verificationUri: event.verificationUri,
				...(event.intervalSeconds === undefined ? {} : { intervalSeconds: event.intervalSeconds }),
				...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }),
			});
			return;
		}
		if (event.type === "info") {
			deps.send({
				type: "info",
				sessionId,
				message: event.message,
				...(event.links === undefined ? {} : { links: event.links }),
			});
			return;
		}
		deps.send({ type: "progress", sessionId, message: event.message });
	};

	/** Prompt handler that respects `AuthPrompt.signal` so a prompt that loses the browser-callback race is cancelled. */
	function makePrompt(sessionId: string): (input: AuthPrompt) => Promise<string> {
		return (input) =>
			new Promise<string>((resolve, reject) => {
				const session = sessions.get(sessionId);
				if (session === undefined) {
					reject(new Error("Login session is no longer active"));
					return;
				}
				const signal = input.signal;
				let settled = false;
				const finish = (settle: () => void): void => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					const current = sessions.get(sessionId);
					if (current?.pending !== undefined) {
						const { pending: _pending, ...rest } = current;
						sessions.set(sessionId, rest);
					}
					settle();
				};
				const onAbort = (): void => finish(() => reject(new Error("Login prompt cancelled")));
				if (signal?.aborted === true) {
					onAbort();
					return;
				}
				signal?.addEventListener("abort", onAbort, { once: true });
				sessions.set(sessionId, {
					...session,
					pending: {
						resolve: (value) => finish(() => resolve(value)),
						reject: (error) => finish(() => reject(error)),
					},
				});
				deps.send({ type: "prompt", sessionId, prompt: promptFor(input) });
			});
	}

	async function injectEnv(providerId: string): Promise<void> {
		const bridge = ENV_BRIDGES.find((entry) => entry.providerId === providerId);
		if (bridge === undefined || injected.has(bridge.envName)) return;
		const ambient = deps.env[bridge.envName];
		if (typeof ambient === "string" && ambient.length > 0) return;
		const runtime = await runtimePromise;
		if (!runtime.hasConfiguredAuth(providerId)) return;
		let key: string | undefined;
		try {
			key = (await runtime.getAuth(providerId))?.auth.apiKey;
		} catch {
			return;
		}
		if (typeof key !== "string" || key.length === 0) return;
		injected.set(bridge.envName, { providerId, value: key });
		deps.env[bridge.envName] = key;
	}

	function releaseEnv(providerId: string): void {
		for (const [envName, record] of injected) {
			if (record.providerId !== providerId) continue;
			if (deps.env[envName] === record.value) delete deps.env[envName];
			injected.delete(envName);
		}
	}

	async function list(): Promise<readonly ProviderSummary[]> {
		const runtime = await runtimePromise;
		const raw = await readModelsJson(modelsPath);
		const customProviders = modelsJsonProviders(raw);
		const available = new Set(runtime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`));
		return autoragFirst(runtime.getProviders().map((provider): ProviderSummary => {
			const status = runtime.getProviderAuthStatus(provider.id);
			const rawCustom = customProviders[provider.id];
			const custom = isJsonObject(rawCustom) ? rawCustom : undefined;
			const baseUrl = provider.baseUrl ?? (typeof custom?.baseUrl === "string" ? custom.baseUrl : null);
			let kind: ProviderKind = "runtime";
			if (custom !== undefined) {
				let host = "";
				try {
					host = new URL(baseUrl ?? "").hostname;
				} catch {
					host = "";
				}
				kind = LOOPBACK_HOSTS[host.toLowerCase()] === true ? "local" : "custom";
			}
			const apiKeyEnv =
				kind === "runtime"
					? (findEnvKeys(provider.id)?.[0] ?? null)
					: configValueEnvName(typeof custom?.apiKey === "string" ? custom.apiKey : undefined) ?? providerEnvName(provider.id);
			return {
				id: provider.id,
				name: provider.name,
				baseUrl,
				kind,
				authKinds: authKinds(provider),
				subscription: provider.auth.oauth?.isSubscription === true,
				authConfigured: status.configured,
				authSource: mapAuthSource(status.source),
				apiKeyEnv,
				models: runtime.getModels(provider.id).map((model) => ({
					provider: model.provider,
					id: model.id,
					name: model.name,
					api: model.api,
					available: available.has(`${model.provider}/${model.id}`),
					baseUrl: model.baseUrl ?? baseUrl,
					apiKeyEnv,
				})),
			};
		}));
	}

	async function start(providerId: string, authType: ProviderAuthKind): Promise<ProviderLoginStartResult> {
		const runtime = await runtimePromise;
		const provider = runtime.getProvider(providerId);
		if (provider === undefined) throw new Error(`Unknown provider: ${providerId}`);
		if (authType === "oauth" && provider.auth.oauth === undefined) {
			throw new Error(`${provider.name} does not support browser login`);
		}
		if (authType === "api_key" && provider.auth.apiKey?.login === undefined) {
			throw new Error(`${provider.name} does not support interactive API-key login here`);
		}
		// One active login per provider: an old session would fight the new one for the credential lock.
		for (const [existingId, existing] of sessions) {
			if (existing.providerId === providerId) await cancel(existingId);
		}
		const sessionId = randomUUID();
		const controller = new AbortController();
		sessions.set(sessionId, { providerId, authType, controller });
		void (async () => {
			try {
				await runtime.login(providerId, authType as AuthType, {
					signal: controller.signal,
					prompt: makePrompt(sessionId),
					notify: (event) => notify(sessionId, event),
				});
				await injectEnv(providerId);
				deps.send({ type: "done", sessionId });
			} catch (error) {
				// A user/ownership cancel is not an error the renderer should surface.
				if (!controller.signal.aborted) {
					deps.send({ type: "error", sessionId, message: error instanceof Error ? error.message : String(error) });
				}
			} finally {
				sessions.delete(sessionId);
			}
		})();
		return { sessionId };
	}

	async function respond(sessionId: string, value: string): Promise<void> {
		const session = sessions.get(sessionId);
		if (session?.pending === undefined) throw new Error("Login is not waiting for input");
		session.pending.resolve(value);
	}

	async function cancel(sessionId: string): Promise<void> {
		const session = sessions.get(sessionId);
		if (session === undefined) return;
		sessions.delete(sessionId);
		session.pending?.reject(new Error("Login cancelled"));
		session.controller.abort();
	}

	async function logout(providerId: string): Promise<void> {
		for (const [sessionId, session] of sessions) {
			if (session.providerId === providerId) await cancel(sessionId);
		}
		await (await runtimePromise).logout(providerId);
		releaseEnv(providerId);
	}

	async function fetchJson(target: string, headers: Record<string, string>): Promise<unknown> {
		const response = await fetchImpl(target, { headers, signal: AbortSignal.timeout(timeoutMs) });
		if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
		return response.json();
	}

	/** Try OpenAI `/v1/models`, then Ollama `/api/tags`; return raw discovered models. */
	async function probe(baseUrl: string, apiKey: string | undefined): Promise<ProviderDiscoveryResult> {
		const url = new URL(baseUrl);
		const path = url.pathname.replace(/\/+$/u, "");
		const modelsBase = path.endsWith("/v1") ? `${url.origin}${path}` : `${url.origin}${path}/v1`;
		const errors: string[] = [];
		const headers: Record<string, string> = { accept: "application/json" };
		if (typeof apiKey === "string" && apiKey.length > 0) headers.authorization = `Bearer ${apiKey}`;
		try {
			const payload = await fetchJson(`${modelsBase}/models`, headers);
			const models = parseOpenAiModels(payload);
			if (models.length > 0) return { ok: true, error: null, protocol: "openai", models };
			errors.push("OpenAI endpoint reported no models");
		} catch (error) {
			errors.push(`OpenAI endpoint: ${error instanceof Error ? error.message : String(error)}`);
		}
		try {
			const payload = await fetchJson(`${url.origin}/api/tags`, headers);
			const models = parseOllamaTags(payload);
			if (models.length > 0) return { ok: true, error: null, protocol: "ollama", models };
			errors.push("Ollama endpoint reported no models");
		} catch (error) {
			errors.push(`Ollama endpoint: ${error instanceof Error ? error.message : String(error)}`);
		}
		return { ok: false, error: errors.join("; "), protocol: null, models: [] };
	}

	async function discover(input: ProviderServerInput): Promise<ProviderDiscoveryResult> {
		let normalized: { readonly baseUrl: string; readonly url: URL };
		try {
			normalized = normalizeServerUrl(input);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error), protocol: null, models: [] };
		}
		return probe(normalized.baseUrl, input.apiKey);
	}

	async function upsert(input: ProviderServerInput): Promise<readonly ProviderSummary[]> {
		const normalized = normalizeServerUrl(input); // throws on invalid
		const label = input.label.trim();
		const raw = await readModelsJson(modelsPath);
		const providers = modelsJsonProviders(raw);
		const editingId = input.id?.trim();
		if (editingId !== undefined && editingId.length > 0 && !isJsonObject(providers[editingId])) {
			throw new Error(`Unknown local/custom provider: ${editingId}`);
		}
		const id = editingId !== undefined && editingId.length > 0 ? editingId : uniqueProviderId(providers, input.kind, label);
		const rawExisting = providers[id];
		const existing = isJsonObject(rawExisting) ? rawExisting : undefined;

		const discovery = await probe(normalized.baseUrl, input.apiKey);
		if (!discovery.ok) throw new Error(`Could not reach the server: ${discovery.error ?? "unknown error"}`);
		if (discovery.models.length === 0) throw new Error("The server reported no models");

		const envName = existing?.apiKey !== undefined ? configValueEnvName(typeof existing.apiKey === "string" ? existing.apiKey : undefined) : null;
		const resolvedEnvName = envName ?? providerEnvName(id);
		if (typeof input.apiKey === "string" && input.apiKey.length > 0) {
			await deps.credentials.set(resolvedEnvName, input.apiKey);
		}
		const storedKey = deps.env[resolvedEnvName];
		const hasKey = typeof storedKey === "string" && storedKey.length > 0;
		providers[id] = {
			name: label,
			baseUrl: normalized.baseUrl,
			api: DEFAULT_CUSTOM_API,
			...(hasKey ? { apiKey: `$${resolvedEnvName}` } : {}),
			models: discovery.models.map((model) => ({ id: model.id, name: model.name })),
		};
		await writeModelsJson(modelsPath, { ...raw, providers });
		// Reload models.json into the runtime so the new provider appears in list()
		// and its auth state is composed (offline; no catalog network refresh).
		await (await runtimePromise).refresh({ allowNetwork: false });
		return list();
	}

	async function remove(id: string): Promise<readonly ProviderSummary[]> {
		const raw = await readModelsJson(modelsPath);
		const providers = modelsJsonProviders(raw);
		const entry = providers[id];
		if (!isJsonObject(entry)) throw new Error(`Unknown local/custom provider: ${id}`);
		const envName = configValueEnvName(typeof entry.apiKey === "string" ? entry.apiKey : undefined);
		delete providers[id];
		await writeModelsJson(modelsPath, { ...raw, providers });
		const removal = envName ?? providerEnvName(id);
		try {
			await deps.credentials.remove(removal);
		} catch (error) {
			console.warn(`[providers] could not clear stored key ${removal}: ${error instanceof Error ? error.message : String(error)}`);
		}
		await (await runtimePromise).refresh({ allowNetwork: false });
		return list();
	}

	/**
	 * Pass/fail for a saved provider; why a check failed stays in Pi, the UI
	 * only shows the result.
	 *
	 * Built-in providers: the Pi runtime must resolve the credential (`getAuth`,
	 * which also refreshes OAuth), then a tiny completion goes to the cheapest
	 * catalog models first. A provider's `/models` is no health check (most
	 * built-ins answer 404/403 there, OpenRouter answers 200 without a key), and
	 * one model can be deprecated, plan-restricted, or free-tier-only while the
	 * connection is fine, so a few models are tried and any answer passes.
	 *
	 * Local/custom servers have no Pi credential or price list and loading a
	 * model just to check a connection is heavy, so they pass when the server
	 * answers its model listing.
	 */
	async function test(id: string): Promise<ProviderConnectionResult> {
		try {
			const summary = (await list()).find((provider) => provider.id === id);
			if (summary === undefined) return { ok: false };
			if (summary.kind !== "runtime") {
				if (summary.baseUrl === null) return { ok: false };
				const stored = summary.apiKeyEnv === null ? undefined : deps.env[summary.apiKeyEnv];
				return { ok: (await probe(summary.baseUrl, stored === undefined || stored.length === 0 ? undefined : stored)).ok };
			}
			const runtime = await runtimePromise;
			if ((await runtime.getAuth(id)) === undefined) return { ok: false };
			const models = rankConnectionProbeModels(runtime.getModels(id)).slice(0, CONNECTION_PROBE_ATTEMPTS);
			if (models.length === 0) return { ok: true };
			const signal = AbortSignal.timeout(deps.timeoutMs ?? CONNECTION_TEST_TIMEOUT_MS);
			for (const model of models) {
				try {
					const result = await runtime.completeSimple(
						model,
						{ messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }] },
						{ maxTokens: 16, sessionId: CONNECTION_PROBE_SESSION_ID, signal },
					);
					// `length` is an answer: reasoning models spend the whole 16-token budget thinking.
					if (result.stopReason !== "error" && result.stopReason !== "aborted") return { ok: true };
				} catch {
					// A model-level failure; try the next one.
				}
				if (signal.aborted) break;
			}
			return { ok: false };
		} catch {
			return { ok: false };
		}
	}

	return {
		list,
		start,
		respond,
		cancel,
		logout,
		discover,
		upsert,
		remove,
		test,
		warmEnv: async () => {
			for (const bridge of ENV_BRIDGES) await injectEnv(bridge.providerId);
		},
		syncAutoragCatalog: async () => {
			// Only with an account key: a signed-out provider must make no network call.
			const key = await readDazziPlanCredential(agentDir);
			if (key === null) return;
			const runtime = await runtimePromise;
			try {
				// One provider, with the network on: the librarian provider fetches
				// `/v1/models` with the plan credential the account sign-in stored
				// in `auth.json` and persists the snapshot; a failure keeps the old one.
				await runtime.refresh({ allowNetwork: true, providers: [AUTORAG_PROVIDER_ID], force: true });
			} catch (error) {
				console.warn("[providers] could not refresh the AutoRAG catalog:", error);
			}
		},
		dispose: async () => {
			for (const sessionId of [...sessions.keys()]) await cancel(sessionId);
			for (const [envName, record] of injected) {
				if (deps.env[envName] === record.value) delete deps.env[envName];
				injected.delete(envName);
			}
		},
	};
}

function uniqueProviderId(providers: Record<string, unknown>, kind: "local" | "custom", label: string): string {
	const base = `${kind}-${slugify(label)}`;
	if (providers[base] === undefined) return base;
	for (let index = 2; index < 1000; index += 1) {
		const candidate = `${base}-${index}`;
		if (providers[candidate] === undefined) return candidate;
	}
	return `${base}-${randomUUID().slice(0, 8)}`;
}

function parseOpenAiModels(payload: unknown): DiscoveredModel[] {
	if (!isJsonObject(payload) || !Array.isArray(payload.data)) return [];
	const models: DiscoveredModel[] = [];
	for (const entry of payload.data) {
		if (!isJsonObject(entry) || typeof entry.id !== "string" || entry.id.length === 0) continue;
		models.push({ id: entry.id, name: typeof entry.name === "string" ? entry.name : entry.id, api: DEFAULT_CUSTOM_API });
	}
	return models;
}

function parseOllamaTags(payload: unknown): DiscoveredModel[] {
	if (!isJsonObject(payload) || !Array.isArray(payload.models)) return [];
	const models: DiscoveredModel[] = [];
	for (const entry of payload.models) {
		if (!isJsonObject(entry)) continue;
		const id = typeof entry.name === "string" ? entry.name : typeof entry.model === "string" ? entry.model : undefined;
		if (id === undefined || id.length === 0) continue;
		models.push({ id, name: id, api: DEFAULT_CUSTOM_API });
	}
	return models;
}
