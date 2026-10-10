import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_API_KEY_ENV, ACCOUNT_CHANNELS, type AccountStatus } from "../src/shared/account-contract";
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
	credits: { used_cents: 12, limit_cents: 50, period: "2026-W41" },
	limits: { requests_per_minute: 10 },
	embeddings: false,
	billing: { air: true, pro: true, portal: false },
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
			if (request.headers.authorization !== "Bearer dz_fakekey") {
				reply(response, 401, { error: { message: "Invalid or revoked API key.", type: "invalid_request_error", code: "invalid_api_key" } });
				return;
			}
			if (path === "/v1/account" && request.method === "GET") return reply(response, 200, fake.account);
			if (path === "/v1/models" && request.method === "GET") return reply(response, 200, CATALOG);
			if (path === "/v1/account/checkout" && request.method === "POST") {
				const body = await readBody(request);
				return reply(response, 200, { url: `https://checkout.example/${String(body.plan)}` });
			}
			if (path === "/v1/account/portal" && request.method === "POST") return reply(response, 200, { url: "https://portal.example/session" });
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
		if (!url.includes("/desktop/authorize")) return;
		const callback = mutate(await fake.approve(url));
		void fetch(callback).catch(() => undefined);
	};
}

function build(openExternal = makeBrowser(), overrides: { signInTimeoutMs?: number; fetch?: typeof fetch } = {}): AccountService {
	return createAccountService({
		env,
		credentials: creds.service as never,
		cachePath: join(root, "account.json"),
		configPath: join(root, "config.json"),
		openExternal,
		send: (channel, payload) => {
			if (channel === ACCOUNT_CHANNELS.changed) events.push(payload as AccountStatus);
		},
		...overrides,
	});
}

beforeEach(async () => {
	fake = await startFakeServer();
	root = await mkdtemp(join(tmpdir(), "autorag-account-"));
	env = { AUTORAG_BASE_URL: fake.url };
	creds = credentialFake(env);
	events = [];
	opened = [];
	service = build();
});

afterEach(async () => {
	await fake.close();
	await rm(root, { recursive: true, force: true });
});

describe("sign in", () => {
	it("completes the browser PKCE flow, stores the key encrypted, and loads the account", async () => {
		const status = await service.signIn();

		expect(status.state).toBe("signedIn");
		expect(status.source).toBe("stored");
		expect(status.account).toMatchObject({
			email: "user@example.com",
			plan: "free",
			creditsUsedCents: 12,
			creditsLimitCents: 50,
			requestsPerMinute: 10,
			billing: { air: true, pro: true, portal: false },
		});
		expect(creds.store.get(ACCOUNT_API_KEY_ENV)).toBe("dz_fakekey");
		const authorize = new URL(opened[0] ?? "");
		expect(authorize.origin).toBe(fake.url);
		expect(authorize.searchParams.get("client")).toBe("app");
		expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authorize.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/u);
		expect(fake.requests.find((request) => request.path === "/v1/account")?.auth).toBe("Bearer dz_fakekey");
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
		expect(creds.store.size).toBe(0);
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
		expect(creds.store.size).toBe(0);
	});

	it("times out when the browser never comes back", async () => {
		service = build(async () => undefined, { signInTimeoutMs: 50 });

		const status = await service.signIn();

		expect(status.state).toBe("signedOut");
		expect(status.error).toMatch(/timed out/iu);
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
		expect(await service.status()).toMatchObject({ state: "signedOut", source: null, account: null, baseUrl: fake.url });
	});

	it("picks up a headless AUTORAG_API_KEY and refuses to remove it", async () => {
		env[ACCOUNT_API_KEY_ENV] = "dz_fakekey";

		const refreshed = await service.refresh();
		expect(refreshed).toMatchObject({ state: "signedIn", source: "env" });
		expect(refreshed.account?.email).toBe("user@example.com");

		expect((await service.signOut()).state).toBe("signedIn");
	});

	it("maps trial, scheduled cancel and the period end", async () => {
		await service.signIn();
		fake.account = { ...FREE_ACCOUNT, plan: "pro", status: "scheduled_cancel", cancel_scheduled: true, period_end: "2026-11-01T00:00:00.000Z", limits: { requests_per_minute: 240 }, billing: { air: true, pro: true, portal: true } };

		const status = await service.refresh();

		expect(status.account).toMatchObject({ plan: "pro", cancelScheduled: true, trialing: false, periodEnd: "2026-11-01T00:00:00.000Z", requestsPerMinute: 240 });
		expect(status.account?.billing.portal).toBe(true);
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
		expect(creds.store.size).toBe(0);
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
		expect(creds.store.size).toBe(0);
		expect((await build().status()).account).toBeNull();
	});
});

describe("hosted billing", () => {
	it("opens the hosted checkout for the chosen plan in the browser", async () => {
		await service.signIn();

		await service.checkout("pro");

		expect(opened.at(-1)).toBe("https://checkout.example/pro");
	});

	it("surfaces the server's refusal and opens nothing", async () => {
		await service.signIn();
		fake.failNext.set("/v1/account/checkout", { status: 409, body: { error: { message: "You already have an active subscription", type: "invalid_request_error", code: "already_subscribed" } } });
		const before = opened.length;

		await expect(service.checkout("air")).rejects.toThrow("You already have an active subscription");
		expect(opened).toHaveLength(before);
	});

	it("opens the billing portal", async () => {
		await service.signIn();

		await service.portal();

		expect(opened.at(-1)).toBe("https://portal.example/session");
	});

	it("refuses to start billing when signed out", async () => {
		await expect(service.checkout("pro")).rejects.toThrow(/sign in/iu);
	});

	it("never opens a URL that is not https", async () => {
		await service.signIn();
		fake.failNext.set("/v1/account/portal", { status: 200, body: { url: "file:///etc/passwd" } });

		await expect(service.portal()).rejects.toThrow(/https/iu);
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
			provider: "autorag",
			id: result.modelId,
			name: result.modelName,
			baseUrl: `${fake.url}/v1`,
			api: "openai-responses",
			apiKeyEnv: ACCOUNT_API_KEY_ENV,
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
		expect(config.queryDecomposition.model).toMatchObject({ provider: "autorag", id: "vendor/cheap", baseUrl: `${fake.url}/v1`, apiKeyEnv: ACCOUNT_API_KEY_ENV });
	});

	it("needs a signed-in account", async () => {
		await expect(service.useManagedModel()).rejects.toThrow(/sign in/iu);
	});
});
