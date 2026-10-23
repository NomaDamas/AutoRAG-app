import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { readRawConfigObject, writeConfigObject } from "@autorag/librarian/core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	ACCOUNT_CHANNELS,
	AUTORAG_PROVIDER_ID,
	DEFAULT_ACCOUNT_BASE_URL,
	shouldAdoptManagedModel,
	type AccountPlanId,
	type AccountSnapshot,
	type AccountStatus,
	type ManagedModelResult,
	type PaidPlanId,
} from "../shared/account-contract";
import { i18n, t } from "../shared/i18n/core";
import { isJsonObject } from "../shared/settings-contract";
import { managedRoleUpdates, shouldAdoptManagedDecomposition, shouldAdoptManagedRoles } from "../shared/ai-roles";
import type { ProviderCredentialService } from "./provider-credentials";
import { clearDazziPlanCredential, readDazziPlanCredential, storeDazziPlanCredential } from "./dazzi-plan-credential";

/**
 * The main-process half of the AutoRAG account: browser sign-in (OAuth 2.0
 * authorization code + PKCE over a loopback redirect, RFC 8252), the stored
 * API key, the account/plan read, hosted checkout and billing portal, and
 * pointing the shared AutoRAG config at the account's managed models.
 *
 * The API key is the only secret. It lives in Pi's `auth.json` as the `dazzi`
 * credential, the one place the librarian reads the hosted plan from; it never
 * reaches the renderer, the config file, or a log line.
 */

const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_VERSION = 1;
const PLAN_IDS: Readonly<Record<string, AccountPlanId>> = { free: "free", air: "air", pro: "pro", max: "max" };

export interface AccountServiceDeps {
	readonly env: NodeJS.ProcessEnv;
	readonly credentials: Pick<ProviderCredentialService, "list" | "set" | "remove">;
	/** `userData/account.json`: the last account the server confirmed (no secrets). */
	readonly cachePath: string;
	/** The shared AutoRAG config the managed model is written into. */
	readonly configPath: string;
	/** Pi's agent home: where the hosted plan's credential is bridged into `auth.json`. */
	readonly agentDir?: string;
	readonly openExternal: (url: string) => Promise<void>;
	readonly send: (channel: string, payload: unknown) => void;
	readonly fetch?: typeof globalThis.fetch;
	readonly signInTimeoutMs?: number;
	/** Runs after the server confirmed the account (sign-in and every refresh); must not throw to callers. */
	readonly onSignedIn?: () => Promise<void>;
}

export interface AccountService {
	status(): Promise<AccountStatus>;
	refresh(): Promise<AccountStatus>;
	signIn(): Promise<AccountStatus>;
	cancelSignIn(): Promise<AccountStatus>;
	signOut(): Promise<AccountStatus>;
	checkout(plan: PaidPlanId): Promise<void>;
	useManagedModel(): Promise<ManagedModelResult>;
	/** Aborts a sign-in in flight so its loopback listener closes (app quit). */
	dispose(): Promise<void>;
}

interface ApiResponse {
	readonly status: number;
	readonly body: unknown;
}

interface CatalogModel {
	readonly id: string;
	readonly name: string;
	readonly contextWindow: number;
	readonly maxTokens: number;
	readonly input: readonly ("text" | "image")[];
	readonly reasoning: boolean;
	/** USD per million input + output tokens: the ordering the cheapest-model pick uses. */
	readonly price: number;
}

type CallbackResult =
	| { readonly kind: "code"; readonly code: string }
	| { readonly kind: "denied" | "timeout" | "cancelled" };

/** The server could not be reached at all (as opposed to answering with an error). */
class OfflineError extends Error {}

function readNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function errorMessageOf(response: ApiResponse): string {
	const error = isJsonObject(response.body) && isJsonObject(response.body.error) ? response.body.error : null;
	return typeof error?.message === "string" && error.message.length > 0 ? error.message : t("main.account.httpStatus", { status: response.status });
}

/** Maps the server's `GET /v1/account` body; null when it is not an account. */
function parseAccount(body: unknown): AccountSnapshot | null {
	if (!isJsonObject(body) || typeof body.email !== "string" || typeof body.plan !== "string") return null;
	const plan = PLAN_IDS[body.plan];
	if (plan === undefined) return null;
	const credits = isJsonObject(body.credits) ? body.credits : {};
	const limits = isJsonObject(body.limits) ? body.limits : {};
	const billing = isJsonObject(body.billing) ? body.billing : {};
	return {
		email: body.email,
		plan,
		status: typeof body.status === "string" ? body.status : "active",
		trialing: body.trialing === true,
		cancelScheduled: body.cancel_scheduled === true,
		periodEnd: typeof body.period_end === "string" ? body.period_end : null,
		creditsUsedCents: readNumber(credits.used_cents, 0),
		creditsLimitCents: readNumber(credits.limit_cents, 0),
		creditPeriod: typeof credits.period === "string" ? credits.period : "",
		// Older servers omit the flag; embeddings were always Pro-and-up.
		embeddings: typeof body.embeddings === "boolean" ? body.embeddings : plan === "pro" || plan === "max",
		requestsPerMinute: readNumber(limits.requests_per_minute, 0),
		billing: { air: billing.air === true, pro: billing.pro === true, portal: billing.portal === true },
	};
}

function parseCatalog(body: unknown): CatalogModel[] {
	const data = isJsonObject(body) && Array.isArray(body.data) ? body.data : [];
	const models: CatalogModel[] = [];
	for (const entry of data) {
		if (!isJsonObject(entry) || typeof entry.id !== "string" || entry.id.length === 0) continue;
		const pricing = isJsonObject(entry.pricing) ? entry.pricing : {};
		const modalities = Array.isArray(entry.input_modalities) ? entry.input_modalities : ["text"];
		const input = modalities.filter((value): value is "text" | "image" => value === "text" || value === "image");
		models.push({
			id: entry.id,
			name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id,
			contextWindow: readNumber(entry.context_window, 128_000),
			maxTokens: readNumber(entry.max_output_tokens, 16_384),
			input: input.length > 0 ? input : ["text"],
			reasoning: entry.reasoning === true,
			price: readNumber(pricing.input, Number.POSITIVE_INFINITY) + readNumber(pricing.output, Number.POSITIVE_INFINITY),
		});
	}
	return models;
}

function base64Url(bytes: Buffer): string {
	return bytes.toString("base64url");
}

/** The page the browser lands on after sign-in, in the interface language the app is showing. */
function callbackPage(): string {
	return `<!doctype html><html lang="${i18n.language}"><meta charset="utf-8"><title>Dazzi</title>
<body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<p>${t("main.account.callbackDone")}</p></body></html>`;
}

export function createAccountService(deps: AccountServiceDeps): AccountService {
	const doFetch = deps.fetch ?? globalThis.fetch;
	const agentDir = deps.agentDir ?? getAgentDir();
	/** Whether the shared config embeds through the Dazzi cloud embedder (which reuses the account token). */
	const isDazziCloudEmbedderConfigured = (): boolean => {
		if (!existsSync(deps.configPath)) return false;
		try {
			const raw = readRawConfigObject(deps.configPath);
			const minSync = isJsonObject(raw.minSync) ? raw.minSync : undefined;
			const embedder = minSync !== undefined && isJsonObject(minSync.embedder) ? minSync.embedder : undefined;
			return embedder?.id === "openai:qwen/qwen3-embedding-0.6b" && embedder.apiKeyEnv === "OPENAI_API_KEY";
		} catch {
			return false;
		}
	};
	/** The cloud embedder authenticates with the same token under the OpenAI key name. */
	const syncCloudEmbedderKey = async (token: string): Promise<void> => {
		if (isDazziCloudEmbedderConfigured() && deps.env.OPENAI_API_KEY !== token) {
			try {
				await deps.credentials.set("OPENAI_API_KEY", token);
			} catch {
				deps.env.OPENAI_API_KEY = token;
			}
		}
	};
	const forgetPlanCredential = async (revokedOrSignedOutToken: string): Promise<void> => {
		try {
			await clearDazziPlanCredential(agentDir);
		} catch (error) {
			console.warn("[account] could not remove the plan credential from auth.json:", error);
		}
		if (deps.env.OPENAI_API_KEY === revokedOrSignedOutToken) {
			await deps.credentials.remove("OPENAI_API_KEY").catch(() => undefined);
		}
	};
	let cached: AccountSnapshot | null | undefined;
	let offline = false;
	let lastError: string | null = null;
	/** A key the server rejected; an environment key cannot be removed, so it is remembered instead. */
	let revokedKey: string | null = null;
	let flow: { readonly promise: Promise<AccountStatus>; readonly abort: AbortController } | null = null;

	function baseUrl(): string {
		const configured = deps.env.AUTORAG_BASE_URL?.trim();
		return (configured !== undefined && configured.length > 0 ? configured : DEFAULT_ACCOUNT_BASE_URL).replace(/\/+$/u, "");
	}

	async function readCache(): Promise<AccountSnapshot | null> {
		if (cached !== undefined) return cached;
		cached = null;
		try {
			const parsed: unknown = JSON.parse(await readFile(deps.cachePath, "utf8"));
			if (isJsonObject(parsed) && parsed.version === CACHE_VERSION && parsed.baseUrl === baseUrl()) cached = parseAccount(parsed.account);
		} catch {
			// No cache yet, or a damaged one: the next refresh rebuilds it.
		}
		return cached;
	}

	/** Cache writes run one at a time: overlapping refreshes must not share a temporary file. */
	let cacheQueue: Promise<unknown> = Promise.resolve();
	function writeCache(account: AccountSnapshot | null): Promise<void> {
		cached = account;
		const run = async (): Promise<void> => {
			if (account === null) {
				await rm(deps.cachePath, { force: true });
				return;
			}
			await mkdir(dirname(deps.cachePath), { recursive: true });
			const temporary = `${deps.cachePath}.${process.pid}.${randomUUID()}.tmp`;
			const wire = {
				email: account.email,
				plan: account.plan,
				status: account.status,
				trialing: account.trialing,
				cancel_scheduled: account.cancelScheduled,
				period_end: account.periodEnd,
				credits: { used_cents: account.creditsUsedCents, limit_cents: account.creditsLimitCents, period: account.creditPeriod },
				embeddings: account.embeddings,
				limits: { requests_per_minute: account.requestsPerMinute },
				billing: account.billing,
			};
			await writeFile(temporary, `${JSON.stringify({ version: CACHE_VERSION, baseUrl: baseUrl(), account: wire })}\n`, { encoding: "utf8", mode: 0o600 });
			await rename(temporary, deps.cachePath);
		};
		const result = cacheQueue.then(run, run);
		cacheQueue = result.catch(() => undefined);
		return result;
	}

	/**
	 * The account key in use; null when absent or rejected by the server. The
	 * plan credential in Pi's `auth.json` is the only place it lives, so the app
	 * and the librarian can never disagree about whether the user is signed in.
	 */
	async function currentKey(): Promise<string | null> {
		const key = await readDazziPlanCredential(agentDir);
		return key === null || key === revokedKey ? null : key;
	}

	async function buildStatus(): Promise<AccountStatus> {
		const key = await currentKey();
		const base = { baseUrl: baseUrl(), error: lastError };
		if (key === null) return { ...base, state: flow === null ? "signedOut" : "signingIn", account: null, offline: false };
		return { ...base, state: "signedIn", account: await readCache(), offline };
	}

	async function publish(): Promise<AccountStatus> {
		const status = await buildStatus();
		deps.send(ACCOUNT_CHANNELS.changed, status);
		return status;
	}

	async function call(path: string, init: { readonly method?: string; readonly key?: string; readonly body?: unknown }): Promise<ApiResponse> {
		let response: Response;
		try {
			response = await doFetch(`${baseUrl()}${path}`, {
				method: init.method ?? "GET",
				headers: {
					Accept: "application/json",
					...(init.key === undefined ? {} : { Authorization: `Bearer ${init.key}` }),
					...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			throw new OfflineError(error instanceof Error ? error.message : String(error));
		}
		return { status: response.status, body: await response.json().catch(() => null) };
	}

	/** An authenticated call that throws the server's own message on any failure. */
	async function callSignedIn(path: string, init: { readonly method?: string; readonly body?: unknown }): Promise<unknown> {
		const key = await currentKey();
		if (key === null) throw new Error(t("main.account.signInFirst"));
		let response: ApiResponse;
		try {
			response = await call(path, { ...init, key });
		} catch (error) {
			throw error instanceof OfflineError ? new Error(t("main.account.unreachable")) : error;
		}
		if (response.status < 200 || response.status >= 300) throw new Error(errorMessageOf(response));
		return response.body;
	}

	async function openHostedUrl(path: string, body?: unknown): Promise<void> {
		const result = await callSignedIn(path, { method: "POST", ...(body === undefined ? {} : { body }) });
		const url = isJsonObject(result) && typeof result.url === "string" ? result.url : "";
		if (!url.startsWith("https://")) throw new Error(t("main.account.insecureUrl"));
		await deps.openExternal(url);
	}

	async function refresh(): Promise<AccountStatus> {
		const key = await currentKey();
		if (key === null) return publish();
		try {
			const response = await call("/v1/account", { key });
			if (response.status === 401) {
				revokedKey = key;
				lastError = errorMessageOf(response);
				await forgetPlanCredential(key);
				await writeCache(null);
			} else if (response.status >= 200 && response.status < 300) {
				const account = parseAccount(response.body);
				if (account === null) {
					lastError = t("main.account.unreadableAccount");
				} else {
					await writeCache(account);
					await syncCloudEmbedderKey(key);
					lastError = null;
				}
				offline = false;
			} else {
				lastError = errorMessageOf(response);
				offline = false;
			}
		} catch (error) {
			if (!(error instanceof OfflineError)) throw error;
			offline = true;
			lastError = null;
		}
		const status = await publish();
		// Best effort and off the critical path: the model picker lists the plan's
		// models from this catalog, but a slow server must not hold the status back.
		if (status.state === "signedIn" && status.account !== null && !offline && lastError === null) {
			void deps.onSignedIn?.().catch((error: unknown) => {
				console.warn("[account] onSignedIn hook failed:", error);
			});
		}
		return status;
	}

	/** Runs the loopback listener until the browser calls back, the user cancels, or the wait times out. */
	async function awaitCallback(state: string, listening: (redirectUri: string) => Promise<void>, signal: AbortSignal): Promise<CallbackResult> {
		const { promise, resolve } = Promise.withResolvers<CallbackResult>();
		const server: Server = createServer((request, response) => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			if (url.pathname !== "/callback") {
				response.writeHead(404).end();
				return;
			}
			if (url.searchParams.get("state") !== state) {
				response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end(t("main.account.invalidState"));
				return;
			}
			const code = url.searchParams.get("code");
			if (url.searchParams.get("error") !== null) resolve({ kind: "denied" });
			else if (code !== null && code.length > 0) resolve({ kind: "code", code });
			else {
				response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end(t("main.account.missingCode"));
				return;
			}
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(callbackPage());
		});
		const timer = setTimeout(() => resolve({ kind: "timeout" }), deps.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS);
		const onAbort = (): void => resolve({ kind: "cancelled" });
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			const ready = Promise.withResolvers<void>();
			server.once("error", ready.reject);
			server.listen(0, "127.0.0.1", ready.resolve);
			await ready.promise;
			await listening(`http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`);
			return await promise;
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			server.close();
			server.closeAllConnections();
		}
	}

	async function runSignIn(abort: AbortController): Promise<AccountStatus> {
		const verifier = base64Url(randomBytes(32));
		const challenge = base64Url(createHash("sha256").update(verifier).digest());
		const state = base64Url(randomBytes(16));
		let redirectUri = "";
		try {
			const result = await awaitCallback(
				state,
				async (uri) => {
					redirectUri = uri;
					const authorize = new URL(`${baseUrl()}/desktop/authorize`);
					authorize.searchParams.set("client", "app");
					authorize.searchParams.set("redirect_uri", uri);
					authorize.searchParams.set("state", state);
					authorize.searchParams.set("code_challenge", challenge);
					authorize.searchParams.set("code_challenge_method", "S256");
					await deps.openExternal(authorize.toString());
				},
				abort.signal,
			);
			if (result.kind === "timeout") {
				lastError = t("main.account.signInTimedOut");
			} else if (result.kind === "code") {
				const response = await call("/api/desktop/token", { method: "POST", body: { code: result.code, code_verifier: verifier, redirect_uri: redirectUri } });
				const token = isJsonObject(response.body) ? response.body.access_token : undefined;
				if (response.status !== 200 || typeof token !== "string" || token.length === 0) {
					lastError = errorMessageOf(response);
				} else {
					await storeDazziPlanCredential(agentDir, token);
					await syncCloudEmbedderKey(token);
					revokedKey = null;
					lastError = null;
					await adoptManagedModelIfUnset();
				}
			}
		} catch (error) {
			lastError = error instanceof OfflineError ? t("main.account.unreachable") : error instanceof Error ? error.message : String(error);
		} finally {
			flow = null;
		}
		return refresh();
	}

	/** Model ids the server lists for a non-chat operation (`jev`, `rerank`); empty when unavailable. */
	async function operationModelIds(operation: "jev" | "rerank"): Promise<readonly { readonly id: string }[]> {
		try {
			return parseCatalog(await callSignedIn(`/v1/models?operation=${operation}`, {}));
		} catch {
			return [];
		}
	}

	/**
	 * Points the shared config at the signed-in account's models. The server
	 * decides the catalog and its order, so the first entry is the recommended
	 * chat model; question decomposition runs on the cheapest one.
	 *
	 * Every network call finishes before the config is read, so the read, the
	 * merge and the write run back to back and never undo a change made elsewhere
	 * while the lists were loading. `onlyUntouchedDecomposition` is the automatic
	 * (sign-in) mode: it replaces the decomposition model only when it is absent,
	 * already AutoRAG, or the librarian's untouched default; the explicit button
	 * also replaces a deliberately chosen OpenRouter one.
	 */
	async function applyManagedModel(options: { readonly onlyUntouchedDecomposition?: boolean } = {}): Promise<ManagedModelResult> {
		const activeKey = await currentKey();
		if (activeKey !== null) await syncCloudEmbedderKey(activeKey);
		const catalog = parseCatalog(await callSignedIn("/v1/models", {}));
		const main = catalog[0];
		const cheapest = catalog.reduce<CatalogModel | undefined>((best, model) => (best === undefined || model.price < best.price ? model : best), undefined);
		if (main === undefined || cheapest === undefined) throw new Error(t("main.account.noModels"));
		// A list the server cannot give leaves that role alone and never fails the chat model.
		const [jevIds, rerankIds] = await Promise.all([operationModelIds("jev"), operationModelIds("rerank")]);
		const reference = (model: CatalogModel): Record<string, unknown> => ({
			provider: AUTORAG_PROVIDER_ID,
			id: model.id,
			name: model.name,
			baseUrl: `${baseUrl()}/v1`,
			api: "openai-responses",
			// No `apiKeyEnv`: the plan's credential is the `auth.json` entry the
			// sign-in bridged (librarian 2.10.2 rejects an env-name leaf for dazzi).
			reasoning: model.reasoning,
			input: [...model.input],
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		});
		const raw = existsSync(deps.configPath) ? readRawConfigObject(deps.configPath) : {};
		const next: Record<string, unknown> = { ...raw, model: reference(main) };
		// The librarian's default decomposition model is on OpenRouter, which an
		// account holder has no key for.
		const decomposition = raw.queryDecomposition;
		const decompositionModel = isJsonObject(decomposition) && isJsonObject(decomposition.model) ? decomposition.model : null;
		const replaceDecomposition =
			options.onlyUntouchedDecomposition === true
				? shouldAdoptManagedDecomposition(decomposition)
				: decomposition === undefined || (decomposition !== false && (decompositionModel === null || decompositionModel.provider === "openrouter" || decompositionModel.provider === AUTORAG_PROVIDER_ID));
		if (replaceDecomposition) next.queryDecomposition = { model: reference(cheapest) };
		// Jev and rerank are adopted per role: only when the config names nothing
		// for it (or the librarian's untouched OpenRouter default), or already names
		// the plan without anything the user switched off or tuned.
		Object.assign(next, managedRoleUpdates(shouldAdoptManagedRoles(raw), jevIds, rerankIds, raw));
		writeConfigObject(deps.configPath, next);
		return { modelId: main.id, modelName: main.name };
	}

	/**
	 * Right after a successful sign-in: adopt the account's models unless the
	 * user already chose another provider's model. Never fails the sign-in.
	 * Only untouched defaults are replaced here; the explicit button replaces any.
	 */
	async function adoptManagedModelIfUnset(): Promise<void> {
		try {
			const raw = existsSync(deps.configPath) ? readRawConfigObject(deps.configPath) : {};
			if (shouldAdoptManagedModel(raw)) await applyManagedModel({ onlyUntouchedDecomposition: true });
		} catch (error) {
			console.warn("[account] could not set the account's models as the default:", error);
		}
	}

	return {
		status: buildStatus,
		refresh,
		signIn: () => {
			if (flow !== null) return flow.promise;
			lastError = null;
			const abort = new AbortController();
			const promise = runSignIn(abort);
			flow = { promise, abort };
			void publish();
			return promise;
		},
		dispose: async () => {
			flow?.abort.abort();
			await flow?.promise.catch(() => undefined);
		},
		cancelSignIn: async () => {
			flow?.abort.abort();
			await flow?.promise;
			return buildStatus();
		},
		signOut: async () => {
			const key = await currentKey();
			if (key !== null) {
				await forgetPlanCredential(key);
				await writeCache(null);
				lastError = null;
				offline = false;
			}
			return publish();
		},
		checkout: (plan) => openHostedUrl("/v1/account/checkout", { plan }),
		useManagedModel: () => applyManagedModel(),
	};
}
