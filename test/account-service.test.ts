import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAppLanguage } from "../src/shared/i18n/core";
import { ACCOUNT_CHANNELS, type AccountStatus } from "../src/shared/account-contract";
import { createAccountService, type AccountService } from "../src/main/account-service";

/**
 * A stand-in for the hosted AutoRAG service. It verifies the PKCE proof the way
 * the real token endpoint does, so a client that sends a wrong verifier, state,
 * or redirect URI fails here too.
 */
interface FakeServer {
	readonly url: string;
	readonly close: () => Promise<void>;
	/** Mutable account the `/v1/account` endpoint reports. */
	account: Record<string, unknown>;
	/** Status codes to answer with instead of the normal body (consumed per path). */
	failNext: Map<string, { status: number; body: unknown }>;
	readonly issued: Map<string, { challenge: string; redirectUri: string }>;
	readonly requests: { method: string; path: string; auth: string | undefined }[];
	approve(authorizeUrl: string): Promise<string>;
}

const FREE_ACCOUNT = {
	email: "user@example.com",
	plan: "free",
	status: "active",
	trialing: false,
	cancel_scheduled: false,
	period_end: null,
	credits: { used_cents: 12, limit_cents: 50, period: "2026-W41", resets_at: "2026-10-27T07:15:01.883Z" },
	limits: { requests_per_minute: 10 },
	embeddings: false,
	billing: { air: true, pro: true, max: true, portal: false },
};

const CATALOG = {
	object: "list",
	data: [
		{ id: "vendor/pricey", name: "Pricey", context_window: 200000, max_output_tokens: 32000, input_modalities: ["text"], reasoning: true, pricing: { input: 3, output: 15 } },
		{ id: "vendor/cheap", name: "Cheap", context_window: 1000000, max_output_tokens: 16000, input_modalities: ["text", "image"], reasoning: false, pricing: { input: 0.1, output: 0.5 } },
	],
};

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	const text = Buffer.concat(chunks).toString("utf8");
	return text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>);
}

function reply(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json" });
	response.end(JSON.stringify(body));
}

async function startFakeServer(): Promise<FakeServer> {
	const issued = new Map<string, { challenge: string; redirectUri: string }>();
	const requests: FakeServer["requests"] = [];
	const fake: FakeServer = {
		url: "",
		close: async () => undefined,
		account: { ...FREE_ACCOUNT },
		failNext: new Map(),
		issued,
		requests,
		approve: async () => "",
	};
	const server: Server = createServer((request, response) => {
		void (async () => {
			const path = new URL(request.url ?? "/", "http://fake").pathname;
			requests.push({ method: request.method ?? "GET", path, auth: request.headers.authorization });
			const failure = fake.failNext.get(path);
			if (failure !== undefined) {
				fake.failNext.delete(path);
				reply(response, failure.status, failure.body);
				return;
			}
			if (path === "/api/desktop/token" && request.method === "POST") {
				const body = await readBody(request);
				const code = issued.get(String(body.code));
				issued.delete(String(body.code));
				const verifier = String(body.code_verifier);
				const proof = createHash("sha256").update(verifier).digest("base64url");
				if (code === undefined || code.challenge !== proof || code.redirectUri !== body.redirect_uri) {
					reply(response, 400, { error: { message: "The code is invalid.", type: "invalid_request_error", code: "invalid_grant" } });
					return;
				}
				reply(response, 200, { access_token: "dz_fakekey", token_type: "Bearer", email: "user@example.com" });
				return;
			}
			if (path === "/api/desktop/email/send" && request.method === "POST") {
				const body = await readBody(request);
				if (typeof body.email !== "string" || !body.email.includes("@")) {
					reply(response, 400, { error: { message: "Enter a valid email address.", type: "invalid_request_error", code: "invalid_email" } });
					return;
				}
				reply(response, 200, { ok: true, expires_in_seconds: 600, length: 6 });
				return;
			}
			if (path === "/api/desktop/email/verify" && request.method === "POST") {
				const body = await readBody(request);
				if (body.otp !== "054810") {
					reply(response, 400, { error: { message: "That code is incorrect. Check it and try again.", type: "invalid_request_error", code: "INVALID_OTP" } });
					return;
				}
				reply(response, 200, { access_token: "dz_fakekey", token_type: "Bearer", email: String(body.email) });
				return;
			}
			if (request.headers.authorization !== "Bearer dz_fakekey") {
				reply(response, 401, { error: { message: "Invalid or revoked API key.", type: "invalid_request_error", code: "invalid_api_key" } });
				return;
			}
			if (path === "/v1/account" && request.method === "GET") return reply(response, 200, fake.account);
			if (path === "/v1/models" && request.method === "GET") {
				const operation = new URL(request.url ?? "/", "http://fake").searchParams.get("operation");
				if (operation === null) return reply(response, 200, CATALOG);
				const failure = fake.failNext.get(`/v1/models?operation=${operation}`);
				if (failure !== undefined) {
					fake.failNext.delete(`/v1/models?operation=${operation}`);
					return reply(response, failure.status, failure.body);
				}
				const ids = operation === "jev" ? ["jev-1.13"] : operation === "rerank" ? ["vendor/rerank-a", "vendor/rerank-b"] : [];
				return reply(response, 200, { object: "list", data: ids.map((id) => ({ id, object: "model" })) });
			}
			if (path === "/v1/account/checkout" && request.method === "POST") {
				const body = await readBody(request);
				const discount = typeof body.discount_code === "string" ? `?discount=${body.discount_code}` : "";
				return reply(response, 200, { url: `https://checkout.example/${String(body.plan)}${discount}` });
			}
			reply(response, 404, { error: { message: "not found", type: "invalid_request_error", code: "not_found" } });
		})();
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const port = (server.address() as AddressInfo).port;
	return Object.assign(fake, {
		url: `http://127.0.0.1:${port}`,
		close: async () => {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			server.closeAllConnections();
			await closed.promise;
		},
		approve: async (authorizeUrl: string) => {
			const params = new URL(authorizeUrl).searchParams;
			const code = randomUUID();
			issued.set(code, { challenge: params.get("code_challenge") ?? "", redirectUri: params.get("redirect_uri") ?? "" });
			const redirect = new URL(params.get("redirect_uri") ?? "");
			redirect.searchParams.set("code", code);
			redirect.searchParams.set("state", params.get("state") ?? "");
			return redirect.toString();
		},
	});
}

interface CredentialFake {
	readonly store: Map<string, string>;
	readonly service: {
		list(names?: readonly string[]): Promise<readonly { envName: string; stored: boolean; source: "stored" | "env" | "none" }[]>;
		set(envName: string, secret: string): Promise<readonly never[]>;
		remove(envName: string): Promise<readonly never[]>;
	};
}

function credentialFake(env: NodeJS.ProcessEnv): CredentialFake {
	const store = new Map<string, string>();
	return {
		store,
		service: {
			list: async (names = []) =>
				names.map((envName) => ({
					envName,
					stored: store.has(envName),
					source: store.has(envName) ? ("stored" as const) : env[envName] !== undefined ? ("env" as const) : ("none" as const),
				})),
			set: async (envName, secret) => {
				store.set(envName, secret);
				env[envName] = secret;
				return [];
			},
			remove: async (envName) => {
				store.delete(envName);
				delete env[envName];
				return [];
			},
		},
	};
}

let fake: FakeServer;
let root: string;
let env: NodeJS.ProcessEnv;
let creds: CredentialFake;
let events: AccountStatus[];
let opened: string[];
let service: AccountService;

/** The browser: opens the authorize URL, "approves" it, and lands on the loopback callback. */
function makeBrowser(mutate: (callback: string) => string = (callback) => callback): (url: string) => Promise<void> {
	return async (url) => {
		opened.push(url);
		if (!url.includes("/desktop/authorize") && !url.includes("/api/desktop/oauth")) return;
		const callback = mutate(await fake.approve(url));
		void fetch(callback).catch(() => undefined);
	};
}

function build(openExternal = makeBrowser(), overrides: { signInTimeoutMs?: number; fetch?: typeof fetch; onSignedIn?: () => Promise<void> } = {}): AccountService {
	return createAccountService({
		env,
		credentials: creds.service as never,
		cachePath: join(root, "account.json"),
		configPath: join(root, "config.json"),
		// The plan credential bridges into Pi's `auth.json` here; a temp dir
		// keeps the developer's real agent home out of the test.
		agentDir: root,
		openExternal,
		send: (channel, payload) => {
			if (channel === ACCOUNT_CHANNELS.changed) events.push(payload as AccountStatus);
		},
		...overrides,
	});
}

beforeEach(async () => {
	await setAppLanguage("en");
	fake = await startFakeServer();
	root = await mkdtemp(join(tmpdir(), "autorag-account-"));
	env = { AUTORAG_BASE_URL: fake.url };
	creds = credentialFake(env);
	events = [];
	opened = [];
	service = build();
});

afterEach(async () => {
	await setAppLanguage("ko");
	await fake.close();
	await rm(root, { recursive: true, force: true });
});

describe("sign in", () => {
	it("completes the browser PKCE flow, stores the key encrypted, and loads the account", async () => {
		const status = await service.signIn();

		expect(status.state).toBe("signedIn");
		expect(status.account).toMatchObject({
			email: "user@example.com",
			plan: "free",
			creditsUsedCents: 12,
			creditsLimitCents: 50,
			// The server's own reset instant, not a calendar guess: its week starts when the account's period did.
			creditsResetsAt: "2026-10-27T07:15:01.883Z",
			requestsPerMinute: 10,
			billing: { air: true, pro: true, max: true, portal: false },
		});
		expect(creds.store.size).toBe(0);
		// The same token is bridged into Pi's `auth.json` as the plan credential
		// the librarian (2.10.2) reads for chat, catalog, Jev, and rerank.
		const stored = JSON.parse(await readFile(join(root, "auth.json"), "utf8")) as Record<string, { type: string; access: string }>;
		expect(stored.dazzi).toMatchObject({ type: "oauth", access: "dz_fakekey" });
		const authorize = new URL(opened[0] ?? "");
		expect(authorize.origin).toBe(fake.url);
		expect(authorize.searchParams.get("client")).toBe("app");
		expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authorize.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/u);
		expect(fake.requests.find((request) => request.path === "/v1/account")?.auth).toBe("Bearer dz_fakekey");
	});

	it("opens /api/desktop/oauth directly for Google and GitHub onboarding sign-in", async () => {
		await service.signIn({ provider: "google" });
		await service.signOut();
		await service.signIn({ provider: "github" });

		const googleUrl = new URL(opened[0] ?? "");
		expect(googleUrl.pathname).toBe("/api/desktop/oauth");
		expect(googleUrl.searchParams.get("provider")).toBe("google");
		expect(googleUrl.searchParams.get("client")).toBe("app");

		const githubUrl = new URL(opened[1] ?? "");
		expect(githubUrl.pathname).toBe("/api/desktop/oauth");
		expect(githubUrl.searchParams.get("provider")).toBe("github");
	});

	it("surfaces non-cancellation OAuth callback errors instead of silently cancelling", async () => {
		service = build(async (url) => {
			opened.push(url);
			const params = new URL(url).searchParams;
			const callback = new URL(params.get("redirect_uri") ?? "");
			callback.searchParams.set("error", "EMAIL_ALIAS_EXISTS");
			callback.searchParams.set("error_description", "An account for this mailbox already exists.");
			callback.searchParams.set("state", params.get("state") ?? "");
			void fetch(callback).catch(() => undefined);
		});

		const status = await service.signIn({ provider: "google" });
		expect(status).toMatchObject({ state: "signedOut", error: "An account for this mailbox already exists." });
	});

	it("completes native in-app Email OTP sign-in without opening the browser", async () => {
		const sent = await service.sendEmailOtp("  person@example.com  ");
		expect(sent).toEqual({ ok: true, email: "person@example.com", expiresInSeconds: 600 });

		const wrong = await service.verifyEmailOtp("person@example.com", "000000");
		expect(wrong).toMatchObject({ state: "signedOut", error: "That code is incorrect. Check it and try again." });

		const verified = await service.verifyEmailOtp("person@example.com", "054810");
		expect(verified.state).toBe("signedIn");
		expect(verified.account?.email).toBe("user@example.com");
		expect(opened).toEqual([]);
		const stored = JSON.parse(await readFile(join(root, "auth.json"), "utf8")) as Record<string, { type: string; access: string }>;
		expect(stored.dazzi).toMatchObject({ type: "oauth", access: "dz_fakekey" });
	});

	it("never exposes the key through status or events", async () => {
		const status = await service.signIn();

		expect(JSON.stringify(status)).not.toContain("dz_fakekey");
		expect(JSON.stringify(events)).not.toContain("dz_fakekey");
		expect(events.some((event) => event.state === "signingIn")).toBe(true);
		expect(events.at(-1)?.state).toBe("signedIn");
	});

	it("treats a denied consent as a cancel, not an error", async () => {
		service = build(async (url) => {
			opened.push(url);
			const params = new URL(url).searchParams;
			const callback = new URL(params.get("redirect_uri") ?? "");
			callback.searchParams.set("error", "access_denied");
			callback.searchParams.set("state", params.get("state") ?? "");
			void fetch(callback).catch(() => undefined);
		});

		const status = await service.signIn();

		expect(status).toMatchObject({ state: "signedOut", error: null });
	});

	it("ignores a callback with the wrong state and keeps waiting for the real one", async () => {
		service = build(async (url) => {
			opened.push(url);
			const real = await fake.approve(url);
			const forged = new URL(real);
			forged.searchParams.set("state", "forged");
			await fetch(forged).then((response) => expect(response.status).toBe(400));
			void fetch(real).catch(() => undefined);
		});

		const status = await service.signIn();

		expect(status.state).toBe("signedIn");
	});

	it("reports the server's words when the code exchange fails", async () => {
		fake.failNext.set("/api/desktop/token", { status: 400, body: { error: { message: "The code expired.", type: "invalid_request_error", code: "invalid_grant" } } });

		const status = await service.signIn();

		expect(status).toMatchObject({ state: "signedOut", error: "The code expired." });
	});

	it("times out when the browser never comes back", async () => {
		service = build(async () => undefined, { signInTimeoutMs: 50 });

		const status = await service.signIn();

		expect(status.state).toBe("signedOut");
		expect(status.error).toMatch(/timed out/iu);
	});

	it("reports its own failures in the interface language", async () => {
		await setAppLanguage("ja");
		service = build(async () => undefined, { signInTimeoutMs: 50 });

		const timedOut = await service.signIn();
		expect(timedOut.error).toMatch(/[\u3040-\u30ff]/u);
		expect(timedOut.error).not.toMatch(/timed out/iu);

		await expect(service.checkout("pro")).rejects.toThrow(/[\u3040-\u30ff]/u);
	});

	it("shows the browser a sign-in confirmation in the interface language only", async () => {
		await setAppLanguage("zh");
		let page = "";
		service = build(async (url) => {
			opened.push(url);
			const callback = await fake.approve(url);
			page = await (await fetch(callback)).text();
		});

		await service.signIn();

		expect(page).toContain("已登录 Dazzi");
		expect(page).not.toMatch(/[\uac00-\ud7a3]/u);
		expect(page).not.toContain("Signed in to Dazzi");
		expect(page).toContain('lang="zh"');
	});

	it("can be cancelled while the browser is open", async () => {
		const browserOpened = Promise.withResolvers<void>();
		service = build(async () => browserOpened.resolve());

		const pending = service.signIn();
		await browserOpened.promise;
		const cancelled = await service.cancelSignIn();

		expect(cancelled.state).toBe("signedOut");
		expect((await pending).state).toBe("signedOut");
	});

	it("shares one flow between concurrent calls", async () => {
		await Promise.all([service.signIn(), service.signIn()]);

		expect(opened.filter((url) => url.includes("/desktop/authorize"))).toHaveLength(1);
	});
});

describe("status and refresh", () => {
	it("is signed out without a key", async () => {
		expect(await service.status()).toMatchObject({ state: "signedOut", account: null, baseUrl: fake.url });
	});

	it("picks up a plan credential already in auth.json and signs it out by removing it", async () => {
		await writeFile(join(root, "auth.json"), JSON.stringify({ dazzi: { type: "oauth", access: "dz_fakekey", refresh: "", expires: Number.MAX_SAFE_INTEGER }, openrouter: { type: "api_key", key: "or" } }));

		const refreshed = await service.refresh();
		expect(refreshed).toMatchObject({ state: "signedIn" });
		expect(refreshed.account?.email).toBe("user@example.com");

		expect((await service.signOut()).state).toBe("signedOut");
		const auth = JSON.parse(await readFile(join(root, "auth.json"), "utf8")) as Record<string, unknown>;
		expect(auth).toEqual({ openrouter: { type: "api_key", key: "or" } });
	});

	it("maps trial, scheduled cancel and the period end", async () => {
		await service.signIn();
		fake.account = { ...FREE_ACCOUNT, plan: "pro", status: "scheduled_cancel", cancel_scheduled: true, period_end: "2026-11-01T00:00:00.000Z", limits: { requests_per_minute: 240 }, billing: { air: true, pro: true, max: true, portal: true } };

		const status = await service.refresh();

		expect(status.account).toMatchObject({ plan: "pro", cancelScheduled: true, trialing: false, periodEnd: "2026-11-01T00:00:00.000Z", requestsPerMinute: 240 });
		expect(status.account?.billing.portal).toBe(true);
	});

	it("reports embeddings from the server's flag, and understands the Max plan", async () => {
		await service.signIn();
		expect((await service.refresh()).account).toMatchObject({ plan: "free", embeddings: false });

		fake.account = { ...FREE_ACCOUNT, plan: "max", embeddings: true };
		expect((await service.refresh()).account).toMatchObject({ plan: "max", embeddings: true });

		fake.account = { ...FREE_ACCOUNT, plan: "air", embeddings: false };
		expect((await service.refresh()).account).toMatchObject({ plan: "air", embeddings: false });
	});

	it("keeps the last known account and flags offline when the server is unreachable", async () => {
		await service.signIn();
		const offline = build(makeBrowser(), {
			fetch: (async () => {
				throw new TypeError("fetch failed");
			}) as typeof fetch,
		});

		const status = await offline.refresh();

		expect(status).toMatchObject({ state: "signedIn", offline: true, error: null });
		expect(status.account?.email).toBe("user@example.com");
	});

	it("remembers the account across restarts", async () => {
		await service.signIn();

		const restarted = build();

		expect((await restarted.status()).account?.plan).toBe("free");
	});

	it("drops a revoked key", async () => {
		await service.signIn();
		fake.failNext.set("/v1/account", { status: 401, body: { error: { message: "Invalid or revoked API key.", type: "invalid_request_error", code: "invalid_api_key" } } });

		const status = await service.refresh();

		expect(status).toMatchObject({ state: "signedOut", account: null, error: "Invalid or revoked API key." });
	});

	it("keeps the account on a server error", async () => {
		await service.signIn();
		fake.failNext.set("/v1/account", { status: 500, body: { error: { message: "boom", type: "server_error", code: "internal" } } });

		const status = await service.refresh();

		expect(status).toMatchObject({ state: "signedIn", error: "boom" });
		expect(status.account?.email).toBe("user@example.com");
	});
});

describe("sign out", () => {
	it("removes the stored key and the cached account", async () => {
		await service.signIn();

		const status = await service.signOut();

		expect(status).toMatchObject({ state: "signedOut", account: null });
		const auth = JSON.parse(await readFile(join(root, "auth.json"), "utf8")) as Record<string, unknown>;
		expect("dazzi" in auth).toBe(false);
		expect((await build().status()).account).toBeNull();
	});
});

describe("review follow-ups for the default model", () => {
	const readConfig = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(join(root, "config.json"), "utf8")) as Record<string, unknown>;
	/** The provider of the configured decomposition model, read through checked narrowing. */
	const decompositionProvider = (config: Record<string, unknown>): unknown => {
		const block = config.queryDecomposition;
		if (typeof block !== "object" || block === null || !("model" in block)) return undefined;
		const model = block.model;
		return typeof model === "object" && model !== null && "provider" in model ? model.provider : undefined;
	};

	it("does not hold sign-in or a refresh back on a slow catalog sync", async () => {
		const never = Promise.withResolvers<void>();
		service = build(undefined, { onSignedIn: () => never.promise });

		const status = await service.signIn();
		const refreshed = await service.refresh();

		expect(status.state).toBe("signedIn");
		expect(refreshed.account?.email).toBe("user@example.com");
		never.resolve();
	});

	it("does not undo a config change made while the model lists are being fetched", async () => {
		await writeFile(join(root, "config.json"), JSON.stringify({ searchPaths: ["/before"] }), "utf8");
		const jevList = Promise.withResolvers<void>();
		const slow = build(undefined, {
			fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
				if (String(input).includes("operation=jev")) {
					await writeFile(join(root, "config.json"), JSON.stringify({ searchPaths: ["/changed-meanwhile"] }), "utf8");
					jevList.resolve();
				}
				return fetch(input, init);
			}) as typeof fetch,
		});

		await slow.signIn();
		await jevList.promise;

		expect((await readConfig()).searchPaths).toEqual(["/changed-meanwhile"]);
	});

	it("keeps an AutoRAG reranker the user switched off or tuned across a new sign-in", async () => {
		await writeFile(join(root, "config.json"), JSON.stringify({ rerank: { provider: "dazzi", enabled: false }, jev: { backend: "dazzi", confidenceThreshold: 0.8 } }), "utf8");

		await service.signIn();

		const config = await readConfig();
		expect(config.rerank).toEqual({ provider: "dazzi", enabled: false });
		expect(config.jev).toEqual({ backend: "dazzi", confidenceThreshold: 0.8 });
	});

	it("keeps a deliberately chosen OpenRouter decomposition model, but replaces the librarian's untouched one", async () => {
		await writeFile(join(root, "config.json"), JSON.stringify({ queryDecomposition: { model: { provider: "openrouter", id: "anthropic/claude-haiku-5.5" } } }), "utf8");
		await service.signIn();
		expect((await readConfig()).queryDecomposition).toEqual({ model: { provider: "openrouter", id: "anthropic/claude-haiku-5.5" } });

		await service.signOut();
		await writeFile(join(root, "config.json"), JSON.stringify({ queryDecomposition: { model: { provider: "openrouter", id: "qwen/qwen3.7-flash" } } }), "utf8");
		await service.signIn();
		expect(decompositionProvider(await readConfig())).toBe("dazzi");
	});

	it("lets the explicit button still replace any decomposition model", async () => {
		await service.signIn();
		await writeFile(join(root, "config.json"), JSON.stringify({ model: { provider: "dazzi", id: "x" }, queryDecomposition: { model: { provider: "openrouter", id: "anthropic/claude-haiku-5.5" } } }), "utf8");

		await service.useManagedModel();

		expect(decompositionProvider(await readConfig())).toBe("dazzi");
	});
});

describe("model catalog sync hook", () => {
	it("runs after sign-in succeeds and on a later refresh of a signed-in account", async () => {
		const synced: string[] = [];
		service = build(undefined, { onSignedIn: async () => void synced.push("sync") });

		await service.signIn();
		await service.refresh();

		expect(synced).toEqual(["sync", "sync"]);
	});

	it("never runs while signed out, and never breaks sign-in when it throws", async () => {
		const synced: string[] = [];
		const signedOut = build(undefined, { onSignedIn: async () => void synced.push("sync") });
		await signedOut.refresh();
		expect(synced).toEqual([]);

		service = build(undefined, {
			onSignedIn: async () => {
				throw new Error("boom");
			},
		});
		expect((await service.signIn()).state).toBe("signedIn");
	});

	it("does not run when the server rejects the key", async () => {
		const synced: string[] = [];
		service = build(undefined, { onSignedIn: async () => void synced.push("sync") });
		await service.signIn();
		synced.length = 0;
		fake.failNext.set("/v1/account", { status: 401, body: { error: { message: "Invalid or revoked API key.", type: "invalid_request_error", code: "invalid_api_key" } } });

		await service.refresh();

		expect(synced).toEqual([]);
	});
});

describe("Jev and rerank after sign-in", () => {
	const readConfig = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(join(root, "config.json"), "utf8")) as Record<string, unknown>;

	it("points Jev and rerank at the plan when the config names neither", async () => {
		await writeFile(join(root, "config.json"), JSON.stringify({ searchPaths: ["/docs"] }), "utf8");

		await service.signIn();

		const config = await readConfig();
		expect(config.jev).toEqual({ backend: "dazzi", model: "jev-1.13" });
		expect(config.rerank).toEqual({ enabled: true, provider: "dazzi", model: "vendor/rerank-a" });
	});

	it("replaces the librarian's untouched OpenRouter defaults, which an account holder has no key for", async () => {
		await writeFile(
			join(root, "config.json"),
			JSON.stringify({ jev: { backend: "openrouter" }, rerank: { provider: "openrouter", model: "voyageai/rerank-3-lite", apiKeyEnv: "OPENROUTER_API_KEY", topN: 25 } }),
			"utf8",
		);

		await service.signIn();

		const config = await readConfig();
		expect(config.jev).toMatchObject({ backend: "dazzi" });
		expect(config.rerank).toMatchObject({ provider: "dazzi" });
	});

	it("keeps a role the user turned off or pointed at another provider", async () => {
		await writeFile(join(root, "config.json"), JSON.stringify({ jev: false, rerank: { provider: "openrouter", model: "voyageai/rerank-3" } }), "utf8");

		await service.signIn();

		const config = await readConfig();
		expect(config.jev).toBe(false);
		expect(config.rerank).toEqual({ provider: "openrouter", model: "voyageai/rerank-3" });
	});

	it("still adopts the chat model when the Jev and rerank lists cannot be read", async () => {
		fake.failNext.set("/v1/models?operation=jev", { status: 500, body: { error: { message: "boom", type: "server_error", code: "internal" } } });
		fake.failNext.set("/v1/models?operation=rerank", { status: 500, body: { error: { message: "boom", type: "server_error", code: "internal" } } });

		await service.signIn();

		const config = await readConfig();
		expect(config.model).toMatchObject({ provider: "dazzi" });
		expect(config.jev).toBeUndefined();
		expect(config.rerank).toBeUndefined();
	});
});

describe("default model after sign-in", () => {
	const readConfig = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(join(root, "config.json"), "utf8")) as Record<string, unknown>;

	it("points a config with no model at the account's models as soon as sign-in succeeds", async () => {
		await writeFile(join(root, "config.json"), JSON.stringify({ searchPaths: ["/docs"] }), "utf8");

		await service.signIn();

		const config = await readConfig();
		expect(config.searchPaths).toEqual(["/docs"]);
		expect(config.model).toMatchObject({ provider: "dazzi", id: "vendor/pricey", baseUrl: `${fake.url}/v1` });
		// The plan's credential is the bridged `auth.json` entry, never an env leaf.
		expect("apiKeyEnv" in (config.model as Record<string, unknown>)).toBe(false);
	});

	it("creates the config when none exists", async () => {
		await service.signIn();

		expect((await readConfig()).model).toMatchObject({ provider: "dazzi" });
	});

	it("leaves a model the user picked from another provider alone", async () => {
		await writeFile(join(root, "config.json"), JSON.stringify({ model: { provider: "anthropic", id: "claude-haiku-5.5" } }), "utf8");

		await service.signIn();

		expect((await readConfig()).model).toEqual({ provider: "anthropic", id: "claude-haiku-5.5" });
	});

	it("re-adopts when the configured model is already an AutoRAG one (a later login refreshes it)", async () => {
		await writeFile(join(root, "config.json"), JSON.stringify({ model: { provider: "dazzi", id: "retired/model" } }), "utf8");

		await service.signIn();

		expect((await readConfig()).model).toMatchObject({ provider: "dazzi", id: "vendor/pricey" });
	});

	it("does not touch the config on a plain refresh or when the catalog cannot be read", async () => {
		await service.signIn();
		await writeFile(join(root, "config.json"), JSON.stringify({ model: { provider: "openai-compatible", id: "mine" } }), "utf8");
		fake.failNext.set("/v1/account", { status: 200, body: FREE_ACCOUNT });

		await service.refresh();

		expect((await readConfig()).model).toEqual({ provider: "openai-compatible", id: "mine" });
	});

	it("still signs in when the model list is unavailable", async () => {
		fake.failNext.set("/v1/models", { status: 500, body: { error: { message: "boom", type: "server_error", code: "internal" } } });

		const status = await service.signIn();

		expect(status.state).toBe("signedIn");
	});
});

describe("review follow-ups", () => {
	it("survives concurrent refreshes writing the cache", async () => {
		await service.signIn();

		const results = await Promise.allSettled(Array.from({ length: 8 }, () => service.refresh()));

		expect(results.map((result) => result.status)).toEqual(Array(8).fill("fulfilled"));
		expect((await build().status()).account?.email).toBe("user@example.com");
	});

	it("closes the loopback listener when the app quits mid sign-in", async () => {
		const browserOpened = Promise.withResolvers<string>();
		service = build(async (url) => browserOpened.resolve(url));

		const pending = service.signIn();
		const redirect = new URL(new URL(await browserOpened.promise).searchParams.get("redirect_uri") ?? "");
		await service.dispose();

		expect((await pending).state).toBe("signedOut");
		await expect(fetch(redirect)).rejects.toThrow();
	});
});

describe("hosted billing", () => {
	it("opens the hosted checkout for the chosen plan in the browser", async () => {
		await service.signIn();

		await service.checkout("pro");

		expect(opened.at(-1)).toBe("https://checkout.example/pro");
	});

	it("checks out Max like any other paid plan", async () => {
		await service.signIn();

		await service.checkout("max");

		expect(opened.at(-1)).toBe("https://checkout.example/max");
	});

	it("sends the promo code with the checkout, and nothing when there is none", async () => {
		await service.signIn();

		await service.checkout("pro", "WELCOME-7");
		expect(opened.at(-1)).toBe("https://checkout.example/pro?discount=WELCOME-7");

		await service.checkout("pro", "   ");
		expect(opened.at(-1)).toBe("https://checkout.example/pro");
	});

	it("refuses a malformed promo code without calling the server", async () => {
		await service.signIn();
		const before = fake.requests.length;

		await expect(service.checkout("air", "two words")).rejects.toThrow();

		expect(fake.requests).toHaveLength(before);
	});

	it("surfaces the server's refusal of a promo code", async () => {
		await service.signIn();
		fake.failNext.set("/v1/account/checkout", { status: 400, body: { error: { message: "That promo code is not valid for this plan", type: "invalid_request_error", code: "invalid_discount_code" } } });

		await expect(service.checkout("pro", "NOPE")).rejects.toThrow("That promo code is not valid for this plan");
	});

	it("surfaces the server's refusal and opens nothing", async () => {
		await service.signIn();
		fake.failNext.set("/v1/account/checkout", { status: 409, body: { error: { message: "You already have an active subscription", type: "invalid_request_error", code: "already_subscribed" } } });
		const before = opened.length;

		await expect(service.checkout("air")).rejects.toThrow("You already have an active subscription");
		expect(opened).toHaveLength(before);
	});

	it("refuses to start billing when signed out", async () => {
		await expect(service.checkout("pro")).rejects.toThrow(/sign in/iu);
	});
});

describe("managed model", () => {
	it("points the shared config at the account's endpoint, keeping unrelated settings", async () => {
		await service.signIn();
		await writeFile(join(root, "config.json"), JSON.stringify({ searchPaths: ["/docs"], model: { provider: "old", id: "old" } }), "utf8");

		const result = await service.useManagedModel();

		const config = JSON.parse(await readFile(join(root, "config.json"), "utf8")) as Record<string, unknown>;
		expect(config.searchPaths).toEqual(["/docs"]);
		expect(config.model).toEqual({
			provider: "dazzi",
			id: result.modelId,
			name: result.modelName,
			baseUrl: `${fake.url}/v1`,
			api: "openai-responses",
			reasoning: expect.any(Boolean),
			input: expect.any(Array),
			contextWindow: expect.any(Number),
			maxTokens: expect.any(Number),
		});
		expect(JSON.stringify(config)).not.toContain("dz_fakekey");
	});

	it("decomposes questions on the cheapest model of the same account instead of an unreachable OpenRouter default", async () => {
		await service.signIn();

		await service.useManagedModel();

		const config = JSON.parse(await readFile(join(root, "config.json"), "utf8")) as { queryDecomposition: { model: Record<string, unknown> } };
		expect(config.queryDecomposition.model).toMatchObject({ provider: "dazzi", id: "vendor/cheap", baseUrl: `${fake.url}/v1` });
	});

	it("needs a signed-in account", async () => {
		await expect(service.useManagedModel()).rejects.toThrow(/sign in/iu);
	});
});
