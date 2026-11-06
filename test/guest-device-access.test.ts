import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAppLanguage } from "../src/shared/i18n/core";
import { ACCOUNT_CHANNELS, type AccountStatus } from "../src/shared/account-contract";
import { createAccountService, type AccountService } from "../src/main/account-service";
import { hashDeviceSeed, resolveAnonymousDeviceId } from "../src/main/device-id";
import {
	clearDazziGuestCredential,
	GUEST_TOKEN_PREFIX,
	isGuestDazziToken,
	readDazziGuestCredential,
	readDazziPlanCredential,
	storeDazziGuestCredential,
	storeDazziPlanCredential,
} from "../src/main/dazzi-plan-credential";

const DEVICE_ID = "a".repeat(64);
const GUEST_TOKEN = `${GUEST_TOKEN_PREFIX}guestkey`;
const USER_TOKEN = "dz_userkey";

const CATALOG = {
	object: "list",
	data: [
		{ id: "vendor/pricey", name: "Pricey", context_window: 200000, max_output_tokens: 32000, input_modalities: ["text"], reasoning: true, pricing: { input: 3, output: 15 } },
		{ id: "vendor/cheap", name: "Cheap", context_window: 1000000, max_output_tokens: 16000, input_modalities: ["text", "image"], reasoning: false, pricing: { input: 0.1, output: 0.5 } },
	],
};

interface RecordedRequest {
	readonly method: string;
	readonly path: string;
	readonly auth: string | undefined;
	readonly body: Record<string, unknown>;
}

interface FakeServer {
	readonly url: string;
	readonly close: () => Promise<void>;
	readonly requests: RecordedRequest[];
	guestCredits: { used_cents: number; limit_cents: number };
	guestCreditsUsed: number;
	guestLimit: number;
	guestTokenValid: boolean;
	claimedDevice: string | null;
	approve(authorizeUrl: string): string;
}

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
	const requests: RecordedRequest[] = [];
	const fake: FakeServer = {
		url: "",
		close: async () => undefined,
		requests,
		guestCredits: { used_cents: 0, limit_cents: 100 },
		guestCreditsUsed: 0,
		guestLimit: 100,
		guestTokenValid: true,
		claimedDevice: null,
		approve: () => "",
	};
	const server: Server = createServer((request, response) => {
		void (async () => {
			const url = new URL(request.url ?? "/", "http://fake");
			const path = url.pathname;
			requests.push({ method: request.method ?? "GET", path, auth: request.headers.authorization, body: await readBody(request) });
			if (path === "/api/desktop/guest" && request.method === "POST") {
				const body = requests.at(-1)?.body ?? {};
				if (body.device_id === fake.claimedDevice) {
					reply(response, 403, { error: { message: "This device's trial was already claimed.", type: "invalid_request_error", code: "guest_already_claimed" } });
					return;
				}
				reply(response, 200, { access_token: GUEST_TOKEN, token_type: "Bearer", guest: true, credits: { used_cents: fake.guestCreditsUsed, limit_cents: fake.guestLimit } });
				return;
			}
			if (path === "/v1/guest" && request.method === "GET") {
				if (request.headers.authorization !== `Bearer ${GUEST_TOKEN}` || !fake.guestTokenValid) {
					reply(response, 401, { error: { message: "Invalid API key.", type: "invalid_request_error", code: "invalid_api_key" } });
					return;
				}
				reply(response, 200, { guest: true, credits: { used_cents: fake.guestCreditsUsed, limit_cents: fake.guestLimit }, limits: { requests_per_minute: 6 } });
				return;
			}
			if (path === "/api/desktop/token" && request.method === "POST") {
				reply(response, 200, { access_token: USER_TOKEN, token_type: "Bearer", email: "user@example.com", carried_credit_cents: 0 });
				return;
			}
			if (path === "/api/desktop/email/send" && request.method === "POST") {
				reply(response, 200, { ok: true, expires_in_seconds: 600 });
				return;
			}
			if (path === "/api/desktop/email/verify" && request.method === "POST") {
				reply(response, 200, { access_token: USER_TOKEN, token_type: "Bearer", email: "user@example.com", carried_credit_cents: 0 });
				return;
			}
			const auth = request.headers.authorization;
			if (auth !== `Bearer ${GUEST_TOKEN}` && auth !== `Bearer ${USER_TOKEN}`) {
				reply(response, 401, { error: { message: "Invalid or revoked API key.", type: "invalid_request_error", code: "invalid_api_key" } });
				return;
			}
			if (path === "/v1/models" && request.method === "GET") {
				const operation = url.searchParams.get("operation");
				if (operation === null) return reply(response, 200, CATALOG);
				const ids = operation === "jev" ? ["jev-1.13"] : operation === "rerank" ? ["vendor/rerank-a"] : [];
				return reply(response, 200, { object: "list", data: ids.map((id) => ({ id, object: "model" })) });
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
		approve: (authorizeUrl: string) => {
			const params = new URL(authorizeUrl).searchParams;
			const redirect = new URL(params.get("redirect_uri") ?? "");
			redirect.searchParams.set("code", "test-code");
			redirect.searchParams.set("state", params.get("state") ?? "");
			return redirect.toString();
		},
	});
}

function credentialFake(env: NodeJS.ProcessEnv): { list: () => Promise<never[]>; set: (n: string, s: string) => Promise<never[]>; remove: (n: string) => Promise<never[]> } {
	return {
		list: async () => [],
		set: async (envName, secret) => {
			env[envName] = secret;
			return [];
		},
		remove: async (envName) => {
			delete env[envName];
			return [];
		},
	};
}

let fake: FakeServer;
let root: string;
let env: NodeJS.ProcessEnv;
let opened: string[];
let service: AccountService;

function build(overrides: { deviceId?: () => Promise<string>; onSignedIn?: () => Promise<void> } = {}): AccountService {
	return createAccountService({
		env,
		credentials: credentialFake(env) as never,
		cachePath: join(root, "account.json"),
		configPath: join(root, "config.json"),
		agentDir: root,
		deviceId: overrides.deviceId ?? (async () => DEVICE_ID),
		openExternal: async (url) => {
			opened.push(url);
			if (!url.includes("/desktop/authorize")) return;
			const callback = fake.approve(url);
			void fetch(callback).catch(() => undefined);
		},
		send: () => undefined,
		...(overrides.onSignedIn === undefined ? {} : { onSignedIn: overrides.onSignedIn }),
	});
}

async function readAuth(): Promise<Record<string, { access?: string; guest?: boolean }>> {
	try {
		return JSON.parse(await readFile(join(root, "auth.json"), "utf8")) as Record<string, { access?: string; guest?: boolean }>;
	} catch {
		return {};
	}
}

async function readConfig(): Promise<Record<string, unknown>> {
	try {
		return JSON.parse(await readFile(join(root, "config.json"), "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

beforeEach(async () => {
	await setAppLanguage("en");
	fake = await startFakeServer();
	root = await mkdtemp(join(tmpdir(), "autorag-guest-"));
	env = { AUTORAG_BASE_URL: fake.url };
	opened = [];
	service = build();
});

afterEach(async () => {
	await setAppLanguage("ko");
	await fake.close();
	await rm(root, { recursive: true, force: true });
});

describe("resolveAnonymousDeviceId", () => {
	it("hashes the seed under the device namespace, trimmed and lowercased", () => {
		const id = hashDeviceSeed("  AbC-123  ");
		expect(id).toBe(hashDeviceSeed("abc-123"));
		expect(id).toMatch(/^[0-9a-f]{64}$/u);
	});

	it("parses the macOS IOPlatformUUID", async () => {
		const seen: string[] = [];
		const id = await resolveAnonymousDeviceId({
			platform: "darwin",
			home: root,
			env: {},
			packaged: true,
			runCommand: async (cmd, args) => {
				seen.push(`${cmd} ${args.join(" ")}`);
				return `    | |   "IOPlatformUUID" = "8B4A1C9E-DEAD-BEEF-0000-1234567890AB"\n`;
			},
		});
		expect(seen[0]).toBe("/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice");
		expect(id).toBe(hashDeviceSeed("8B4A1C9E-DEAD-BEEF-0000-1234567890AB"));
	});

	it("parses the Windows MachineGuid", async () => {
		const id = await resolveAnonymousDeviceId({
			platform: "win32",
			home: root,
			env: {},
			packaged: true,
			runCommand: async () => `    MachineGuid    REG_SZ    1234abcd-5678-efgh-90ij\n`,
		});
		expect(id).toBe(hashDeviceSeed("1234abcd-5678-efgh-90ij"));
	});

	it("falls back to a persisted random seed when the probe fails", async () => {
		const options = {
			platform: "freebsd" as NodeJS.Platform,
			home: root,
			env: {},
			packaged: true,
		};
		const first = await resolveAnonymousDeviceId(options);
		const second = await resolveAnonymousDeviceId(options);
		expect(first).toBe(second);
		expect(first).toMatch(/^[0-9a-f]{64}$/u);
		const seedPath = join(root, ".autorag", "device-seed");
		const seed = (await readFile(seedPath, "utf8")).trim();
		expect(hashDeviceSeed(seed)).toBe(first);
		expect((await stat(seedPath)).mode & 0o777).toBe(0o600);
	});

	it("honors AUTORAG_DEV_DEVICE_SEED only when unpackaged", async () => {
		const unpackaged = await resolveAnonymousDeviceId({
			platform: "freebsd",
			home: root,
			env: { AUTORAG_DEV_DEVICE_SEED: " Sandbox " },
			packaged: false,
		});
		expect(unpackaged).toBe(hashDeviceSeed("sandbox"));
		const packaged = await resolveAnonymousDeviceId({
			platform: "freebsd",
			home: root,
			env: { AUTORAG_DEV_DEVICE_SEED: " Sandbox " },
			packaged: true,
		});
		expect(packaged).not.toBe(unpackaged);
	});
});

describe("dazzi plan credential guest slot", () => {
	it("keeps a guest token out of the signed-in slot while the librarian still reads it", async () => {
		expect(await storeDazziGuestCredential(root, GUEST_TOKEN)).toBe(true);
		expect(isGuestDazziToken(GUEST_TOKEN)).toBe(true);
		expect(await readDazziPlanCredential(root)).toBeNull();
		expect(await readDazziGuestCredential(root)).toBe(GUEST_TOKEN);
	});

	it("never overwrites a real user key with a guest token", async () => {
		await storeDazziPlanCredential(root, USER_TOKEN);
		expect(await storeDazziGuestCredential(root, GUEST_TOKEN)).toBe(false);
		expect(await readDazziPlanCredential(root)).toBe(USER_TOKEN);
		expect(await readDazziGuestCredential(root)).toBeNull();
		expect((await readAuth()).dazzi?.access).toBe(USER_TOKEN);
	});

	it("clears only a matching guest token and never a real key", async () => {
		await storeDazziGuestCredential(root, GUEST_TOKEN);
		await clearDazziGuestCredential(root, `${GUEST_TOKEN}other`);
		expect(await readDazziGuestCredential(root)).toBe(GUEST_TOKEN);
		await clearDazziGuestCredential(root, GUEST_TOKEN);
		expect(await readDazziGuestCredential(root)).toBeNull();

		await storeDazziPlanCredential(root, USER_TOKEN);
		await clearDazziGuestCredential(root, USER_TOKEN);
		expect(await readDazziPlanCredential(root)).toBe(USER_TOKEN);
		expect((await readAuth()).dazzi?.access).toBe(USER_TOKEN);
	});
});

describe("ensureGuestAccess", () => {
	it("provisions a guest token, adopts the plan's models, and shares one in-flight run", async () => {
		let signedIn = 0;
		service = build({ onSignedIn: async () => void (signedIn += 1) });

		const [first, second] = await Promise.all([service.ensureGuestAccess(), service.ensureGuestAccess()]);
		expect(first).toBe(true);
		expect(second).toBe(true);
		expect(fake.requests.filter((request) => request.path === "/api/desktop/guest")).toHaveLength(1);
		const provision = fake.requests.find((request) => request.path === "/api/desktop/guest");
		expect(provision?.body).toMatchObject({ device_id: DEVICE_ID, client: "app" });
		expect(await readDazziGuestCredential(root)).toBe(GUEST_TOKEN);
		const config = (await readConfig()).model as Record<string, unknown>;
		expect(config.provider).toBe("dazzi");
		expect(config.id).toBe("vendor/pricey");
		expect(signedIn).toBeGreaterThanOrEqual(1);

		// A second call validates the stored guest token instead of provisioning again.
		expect(await service.ensureGuestAccess()).toBe(true);
		expect(fake.requests.filter((request) => request.path === "/api/desktop/guest")).toHaveLength(1);
	});

	it("keeps the user's own provider and makes no network call", async () => {
		await storeByokConfig();
		service = build();
		expect(await service.ensureGuestAccess()).toBe(false);
		expect(fake.requests).toHaveLength(0);
		expect(await readDazziGuestCredential(root)).toBeNull();
	});

	it("drops a rejected guest token and re-provisions once", async () => {
		await storeDazziGuestCredential(root, GUEST_TOKEN);
		fake.guestTokenValid = false;
		service = build();
		expect(await service.ensureGuestAccess()).toBe(true);
		expect(fake.requests.some((request) => request.path === "/v1/guest")).toBe(true);
		expect(fake.requests.filter((request) => request.path === "/api/desktop/guest")).toHaveLength(1);
		expect(await readDazziGuestCredential(root)).toBe(GUEST_TOKEN);
	});

	it("returns quietly when the server cannot be reached", async () => {
		await fake.close();
		service = build();
		expect(await service.ensureGuestAccess()).toBe(false);
	});
});

describe("guestQuotaStatus", () => {
	it("is inactive once signed in", async () => {
		await storeDazziPlanCredential(root, USER_TOKEN);
		expect(await service.guestQuotaStatus()).toBe("inactive");
	});

	it("is ok while the device trial has room", async () => {
		expect(await service.guestQuotaStatus()).toBe("ok");
	});

	it("is exhausted when the device trial is used up", async () => {
		fake.guestCreditsUsed = 100;
		expect(await service.guestQuotaStatus()).toBe("exhausted");
	});

	it("is claimed when the device trial belongs to an account", async () => {
		fake.claimedDevice = DEVICE_ID;
		expect(await service.guestQuotaStatus()).toBe("claimed");
	});
});

describe("device id carry-over on sign-in", () => {
	it("forwards device_id on the OAuth token exchange and replaces the guest slot", async () => {
		await storeDazziGuestCredential(root, GUEST_TOKEN);
		service = build();
		const status = await service.signIn();
		expect(status.state).toBe("signedIn");
		const exchange = fake.requests.find((request) => request.path === "/api/desktop/token");
		expect(exchange?.body).toMatchObject({ device_id: DEVICE_ID });
		expect((await readAuth()).dazzi?.access).toBe(USER_TOKEN);
		expect(await readDazziGuestCredential(root)).toBeNull();
	});

	it("forwards device_id on the email OTP verify and replaces the guest slot", async () => {
		await storeDazziGuestCredential(root, GUEST_TOKEN);
		service = build();
		await service.sendEmailOtp("person@example.com");
		const status = await service.verifyEmailOtp("person@example.com", "054810");
		expect(status.state).toBe("signedIn");
		const verify = fake.requests.find((request) => request.path === "/api/desktop/email/verify");
		expect(verify?.body).toMatchObject({ device_id: DEVICE_ID, email: "person@example.com" });
		expect((await readAuth()).dazzi?.access).toBe(USER_TOKEN);
	});

	it("never blocks sign-in when the device id cannot be resolved", async () => {
		service = build({
			deviceId: async () => {
				throw new Error("probe failed");
			},
		});
		const status = await service.signIn();
		expect(status.state).toBe("signedIn");
		const exchange = fake.requests.find((request) => request.path === "/api/desktop/token");
		expect(exchange?.body).not.toHaveProperty("device_id");
	});
});

describe("account status while a guest token is stored", () => {
	it("stays signedOut with a guest credential in auth.json", async () => {
		const events: AccountStatus[] = [];
		service = createAccountService({
			env,
			credentials: credentialFake(env) as never,
			cachePath: join(root, "account.json"),
			configPath: join(root, "config.json"),
			agentDir: root,
			deviceId: async () => DEVICE_ID,
			openExternal: async () => undefined,
			send: (channel: string, payload: unknown) => {
				if (channel === ACCOUNT_CHANNELS.changed) events.push(payload as AccountStatus);
			},
		});
		await storeDazziGuestCredential(root, GUEST_TOKEN);
		const status = await service.refresh();
		expect(status.state).toBe("signedOut");
		expect(status.account).toBeNull();
		// Signing out (a no-op while signed out) must not drop the guest credential.
		await service.signOut();
		expect(await readDazziGuestCredential(root)).toBe(GUEST_TOKEN);
	});
});

async function storeByokConfig(): Promise<void> {
	await writeFile(join(root, "config.json"), `${JSON.stringify({ model: { provider: "openrouter", id: "vendor/model" } }, null, 2)}\n`, "utf8");
}
