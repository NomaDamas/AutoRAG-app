import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { readRawConfigObject, writeConfigObject } from "@autorag/librarian/core";
import {
	ACCOUNT_API_KEY_ENV,
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
import { isJsonObject } from "../shared/settings-contract";
import type { ProviderCredentialService } from "./provider-credentials";

/**
 * The main-process half of the AutoRAG account: browser sign-in (OAuth 2.0
 * authorization code + PKCE over a loopback redirect, RFC 8252), the stored
 * API key, the account/plan read, hosted checkout and billing portal, and
 * pointing the shared AutoRAG config at the account's managed models.
 *
 * The API key is the only secret. It lives in the encrypted credential store
 * (`credentials.enc.json`) and the process environment, exactly like a BYOK
 * key, so the librarian resolves it with the same `apiKeyEnv` mechanism; it
 * never reaches the renderer, the config file, or a log line.
 */

const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_VERSION = 1;
const PLAN_IDS: Readonly<Record<string, AccountPlanId>> = { free: "free", air: "air", pro: "pro" };

export interface AccountServiceDeps {
	readonly env: NodeJS.ProcessEnv;
	readonly credentials: Pick<ProviderCredentialService, "list" | "set" | "remove">;
	/** `userData/account.json`: the last account the server confirmed (no secrets). */
	readonly cachePath: string;
	/** The shared AutoRAG config the managed model is written into. */
	readonly configPath: string;
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
	portal(): Promise<void>;
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
	return typeof error?.message === "string" && error.message.length > 0 ? error.message : `The AutoRAG service answered HTTP ${response.status}.`;
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

const CALLBACK_PAGE = `<!doctype html><meta charset="utf-8"><title>AutoRAG</title>
<body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<p>AutoRAG에 로그인했습니다. 이 탭을 닫아도 됩니다.<br>Signed in to AutoRAG. You can close this tab.</p></body>`;

export function createAccountService(deps: AccountServiceDeps): AccountService {
	const doFetch = deps.fetch ?? globalThis.fetch;
	/** Last server-confirmed account; undefined until first read from the cache file. */
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
	 * The key in use and where it comes from; null when absent or rejected by the
	 * server. The credential store skips a stored entry while the environment
	 * already holds the name, so the effective source (not mere presence of an
	 * entry) decides whether the app can sign this key out.
	 */
	async function currentKey(): Promise<{ readonly key: string; readonly source: "stored" | "env" } | null> {
		const key = deps.env[ACCOUNT_API_KEY_ENV];
		if (typeof key !== "string" || key.length === 0 || key === revokedKey) return null;
		const [row] = await deps.credentials.list([ACCOUNT_API_KEY_ENV]);
		return { key, source: row?.source === "stored" ? "stored" : "env" };
	}

	async function buildStatus(): Promise<AccountStatus> {
		const key = await currentKey();
		const base = { baseUrl: baseUrl(), error: lastError };
		if (key === null) return { ...base, state: flow === null ? "signedOut" : "signingIn", source: null, account: null, offline: false };
		return { ...base, state: "signedIn", source: key.source, account: await readCache(), offline };
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
		if (key === null) throw new Error("Sign in to your AutoRAG account first.");
		let response: ApiResponse;
		try {
			response = await call(path, { ...init, key: key.key });
		} catch (error) {
			throw error instanceof OfflineError ? new Error("Cannot reach the AutoRAG service. Check your connection and try again.") : error;
		}
		if (response.status < 200 || response.status >= 300) throw new Error(errorMessageOf(response));
		return response.body;
	}

	async function openHostedUrl(path: string, body?: unknown): Promise<void> {
		const result = await callSignedIn(path, { method: "POST", ...(body === undefined ? {} : { body }) });
		const url = isJsonObject(result) && typeof result.url === "string" ? result.url : "";
		if (!url.startsWith("https://")) throw new Error("The AutoRAG service did not return a secure https address.");
		await deps.openExternal(url);
	}

	async function refresh(): Promise<AccountStatus> {
		const key = await currentKey();
		if (key === null) return publish();
		try {
			const response = await call("/v1/account", { key: key.key });
			if (response.status === 401) {
				revokedKey = key.key;
				lastError = errorMessageOf(response);
				if (key.source === "stored") await deps.credentials.remove(ACCOUNT_API_KEY_ENV);
				await writeCache(null);
			} else if (response.status >= 200 && response.status < 300) {
				const account = parseAccount(response.body);
				if (account === null) {
					lastError = "The AutoRAG service returned an account this app cannot read.";
				} else {
					await writeCache(account);
					lastError = null;
					// Best effort: the model picker lists the plan's models from this catalog.
					await deps.onSignedIn?.().catch((error: unknown) => {
						console.warn("[account] onSignedIn hook failed:", error);
					});
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
		return publish();
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
				response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Invalid sign-in state.");
				return;
			}
			const code = url.searchParams.get("code");
			if (url.searchParams.get("error") !== null) resolve({ kind: "denied" });
			else if (code !== null && code.length > 0) resolve({ kind: "code", code });
			else {
				response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Missing sign-in code.");
				return;
			}
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(CALLBACK_PAGE);
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
				lastError = "Sign-in timed out. Try again.";
			} else if (result.kind === "code") {
				const response = await call("/api/desktop/token", { method: "POST", body: { code: result.code, code_verifier: verifier, redirect_uri: redirectUri } });
				const token = isJsonObject(response.body) ? response.body.access_token : undefined;
				if (response.status !== 200 || typeof token !== "string" || token.length === 0) {
					lastError = errorMessageOf(response);
				} else {
					await deps.credentials.set(ACCOUNT_API_KEY_ENV, token);
					revokedKey = null;
					lastError = null;
					await adoptManagedModelIfUnset();
				}
			}
		} catch (error) {
			lastError = error instanceof OfflineError ? "Cannot reach the AutoRAG service. Check your connection and try again." : error instanceof Error ? error.message : String(error);
		} finally {
			flow = null;
		}
		return refresh();
	}

	/**
	 * Points the shared config at the signed-in account's models. The server
	 * decides the catalog and its order, so the first entry is the recommended
	 * chat model; question decomposition runs on the cheapest one.
	 */
	async function applyManagedModel(): Promise<ManagedModelResult> {
		const catalog = parseCatalog(await callSignedIn("/v1/models", {}));
		const main = catalog[0];
		const cheapest = catalog.reduce<CatalogModel | undefined>((best, model) => (best === undefined || model.price < best.price ? model : best), undefined);
		if (main === undefined || cheapest === undefined) throw new Error("Your AutoRAG plan lists no models.");
		const reference = (model: CatalogModel): Record<string, unknown> => ({
			provider: AUTORAG_PROVIDER_ID,
			id: model.id,
			name: model.name,
			baseUrl: `${baseUrl()}/v1`,
			api: "openai-responses",
			apiKeyEnv: ACCOUNT_API_KEY_ENV,
			reasoning: model.reasoning,
			input: [...model.input],
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		});
		const raw = existsSync(deps.configPath) ? readRawConfigObject(deps.configPath) : {};
		const next: Record<string, unknown> = { ...raw, model: reference(main) };
		// The librarian's default decomposition model is on OpenRouter, which an
		// account holder has no key for. An explicit choice (`false` or another
		// provider) stays; the OpenRouter default moves to the account's models.
		const decomposition = raw.queryDecomposition;
		const decompositionModel = isJsonObject(decomposition) && isJsonObject(decomposition.model) ? decomposition.model : null;
		if (decomposition === undefined || (decomposition !== false && (decompositionModel === null || decompositionModel.provider === "openrouter" || decompositionModel.provider === AUTORAG_PROVIDER_ID))) {
			next.queryDecomposition = { model: reference(cheapest) };
		}
		writeConfigObject(deps.configPath, next);
		return { modelId: main.id, modelName: main.name };
	}

	/**
	 * Right after a successful sign-in: adopt the account's models unless the
	 * user already chose another provider's model. Never fails the sign-in.
	 */
	async function adoptManagedModelIfUnset(): Promise<void> {
		try {
			const raw = existsSync(deps.configPath) ? readRawConfigObject(deps.configPath) : {};
			if (shouldAdoptManagedModel(raw)) await applyManagedModel();
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
			if (key?.source === "stored") {
				await deps.credentials.remove(ACCOUNT_API_KEY_ENV);
				await writeCache(null);
				lastError = null;
				offline = false;
			}
			return publish();
		},
		checkout: (plan) => openHostedUrl("/v1/account/checkout", { plan }),
		portal: () => openHostedUrl("/v1/account/portal"),
		useManagedModel: () => applyManagedModel(),
	};
}
