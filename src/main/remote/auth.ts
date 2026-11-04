/**
 * Remote authentication primitives, cookie helpers, per-client + per-proxy
 * brute-force rate limiting, and same-origin CSRF checks, adapted from Ovis
 * (`devswha/ovis`, MIT).
 */
import type { IncomingHttpHeaders } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { REMOTE_CSRF_HEADER, REMOTE_TOKEN_HEADER } from "../../shared/remote-contract";

export const SESSION_TOKEN_COOKIE = "dazzi_remote";
export const DEVICE_TOKEN_COOKIE = "dazzi_device";
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export function constantTimeTokenMatches(expected: string, received: string | null | undefined): boolean {
	if (!expected || !received) return false;
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(received, "utf8");
	return a.length === b.length && timingSafeEqual(a, b);
}

export function isLoopbackAddress(address: string | null | undefined): boolean {
	if (!address) return false;
	return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

export function parseCookieHeader(header: string | string[] | undefined): Map<string, string> {
	const cookies = new Map<string, string>();
	const text = Array.isArray(header) ? header.join("; ") : header;
	if (!text) return cookies;
	for (const pair of text.split(";")) {
		const sep = pair.indexOf("=");
		if (sep <= 0) continue;
		const name = pair.slice(0, sep).trim();
		if (!name) continue;
		const rawValue = pair.slice(sep + 1).trim();
		try {
			cookies.set(name, decodeURIComponent(rawValue));
		} catch (error) {
			if (error instanceof URIError) {
				cookies.set(name, rawValue);
				continue;
			}
			throw error;
		}
	}
	return cookies;
}

export function isSecureIncomingRequest(headers: IncomingHttpHeaders, encryptedSocket = false): boolean {
	if (encryptedSocket) return true;
	const proto = headers["x-forwarded-proto"];
	const first = (Array.isArray(proto) ? proto[0] : proto)?.split(",")[0]?.trim().toLowerCase();
	return first === "https";
}

export function buildSessionCookie(token: string, secure: boolean): string {
	return `${SESSION_TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function buildDeviceCookie(token: string, secure: boolean): string {
	return `${DEVICE_TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${DEVICE_COOKIE_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`;
}

export function clearCookieHeader(name: string): string {
	return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/**
 * Same-origin CSRF check for state-changing requests (`POST`, `PATCH`, `DELETE`).
 * Protects cookie-authenticated sessions (`dazzi_device`, `dazzi_remote`) from
 * cross-site form/fetch attacks.
 */
export function isSameOriginMutation(request: {
	readonly method?: string | undefined;
	readonly headers: IncomingHttpHeaders;
}): boolean {
	const method = (request.method ?? "GET").toUpperCase();
	if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;

	const fetchSite = request.headers["sec-fetch-site"];
	const site = Array.isArray(fetchSite) ? fetchSite[0] : fetchSite;
	if (site && site !== "same-origin" && site !== "none") return false;

	const originHeader = request.headers.origin;
	const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
	if (!origin) {
		// Cookieless direct API callers using header token or custom CSRF header are allowed.
		if (typeof request.headers[REMOTE_TOKEN_HEADER] === "string") return true;
		if (request.headers[REMOTE_CSRF_HEADER] === "1") return true;
		const cookies = parseCookieHeader(request.headers.cookie);
		return !cookies.has(SESSION_TOKEN_COOKIE) && !cookies.has(DEVICE_TOKEN_COOKIE);
	}

	const hostHeader = request.headers.host;
	const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
	if (!host) return false;
	try {
		const parsedOrigin = new URL(origin);
		const expectedProto = isSecureIncomingRequest(request.headers) ? "https:" : "http:";
		// Compare authority (`host`) strictly; allow http or https when matching host behind a TLS proxy.
		if (parsedOrigin.host.toLowerCase() !== host.toLowerCase()) return false;
		return parsedOrigin.protocol === expectedProto || parsedOrigin.protocol === "https:";
	} catch {
		return false;
	}
}

export type AuthChannel = "sign-in" | "presented";

const AUTH_FAILURE_BUDGET = 5;
const AUTH_BACKOFF_MS = 1_000;
const AUTH_BACKOFF_MAX_MS = 60_000;
const AUTH_CLIENTS_MAX = 1024;
const SHARED_FAILURES = AUTH_FAILURE_BUDGET * 10;
const SHARED_WINDOW_MS = 10 * 60_000;
const ADMITTED_FOR_MS = 30 * 24 * 60 * 60_000;

export interface AuthRateLimiter {
	clientKey(peerAddress: string | null | undefined, xForwardedFor: string | string[] | undefined): string | null;
	waitSeconds(channel: AuthChannel, client: string | null, now?: number): number;
	recordFailure(channel: AuthChannel, client: string | null, now?: number): void;
	admit(client: string | null, now?: number): void;
}

export function createAuthRateLimiter(): AuthRateLimiter {
	const attempts = new Map<string, { failures: number; until: number }>();
	const sharedFailures = new Map<string, number[]>();
	const admitted = new Map<string, number>();

	const sharedProxyKey = (channel: AuthChannel, client: string | null): string | null => {
		const via = client?.lastIndexOf(" via ") ?? -1;
		return client === null || via < 0 ? null : `${channel} via ${client.slice(via + " via ".length)}`;
	};

	const ownWaitSeconds = (key: string, now: number): number => {
		const entry = attempts.get(key);
		const left = entry === undefined ? 0 : entry.until - now;
		return left <= 0 ? 0 : Math.ceil(left / 1000);
	};

	const sharedWaitSeconds = (channel: AuthChannel, client: string | null, now: number): number => {
		const key = sharedProxyKey(channel, client);
		if (key === null || client === null) return 0;
		const admittedAt = admitted.get(client);
		if (admittedAt !== undefined && now - admittedAt < ADMITTED_FOR_MS) return 0;
		const recent = (sharedFailures.get(key) ?? []).filter((at) => now - at < SHARED_WINDOW_MS);
		if (recent.length < SHARED_FAILURES) return 0;
		const oldest = recent[recent.length - SHARED_FAILURES] ?? now;
		return Math.max(0, Math.ceil((oldest + SHARED_WINDOW_MS - now) / 1000));
	};

	return {
		clientKey(peerAddress, xForwardedFor) {
			if (!peerAddress) return null;
			if (!isLoopbackAddress(peerAddress)) return peerAddress;
			const rawXff = Array.isArray(xForwardedFor) ? xForwardedFor.join(",") : xForwardedFor;
			const lastEntry = rawXff?.split(",").at(-1)?.trim();
			return lastEntry ? `${lastEntry} via ${peerAddress}` : peerAddress;
		},

		waitSeconds(channel, client, now = Date.now()) {
			if (client === null) return 0;
			return Math.max(ownWaitSeconds(`${channel} ${client}`, now), sharedWaitSeconds(channel, client, now));
		},

		recordFailure(channel, client, now = Date.now()) {
			if (client === null) return;
			const key = `${channel} ${client}`;
			const failures = (attempts.get(key)?.failures ?? 0) + 1;
			const wait =
				failures < AUTH_FAILURE_BUDGET
					? 0
					: Math.min(AUTH_BACKOFF_MS * 2 ** (failures - AUTH_FAILURE_BUDGET), AUTH_BACKOFF_MAX_MS);
			attempts.set(key, { failures, until: wait === 0 ? 0 : now + wait });
			if (attempts.size > AUTH_CLIENTS_MAX) {
				for (const [k, entry] of attempts) {
					if (attempts.size <= AUTH_CLIENTS_MAX / 2) break;
					if (entry.until !== 0 && entry.until > now) continue;
					attempts.delete(k);
				}
				while (attempts.size > AUTH_CLIENTS_MAX) {
					const oldest = attempts.keys().next().value;
					if (oldest === undefined) break;
					attempts.delete(oldest);
				}
			}

			const proxyKey = sharedProxyKey(channel, client);
			if (proxyKey !== null) {
				const recent = (sharedFailures.get(proxyKey) ?? []).filter((at) => now - at < SHARED_WINDOW_MS);
				recent.push(now);
				sharedFailures.delete(proxyKey);
				sharedFailures.set(proxyKey, recent.slice(-SHARED_FAILURES));
				if (sharedFailures.size > AUTH_CLIENTS_MAX) {
					const oldest = sharedFailures.keys().next().value;
					if (oldest !== undefined) sharedFailures.delete(oldest);
				}
			}
		},

		admit(client, now = Date.now()) {
			if (client === null) return;
			attempts.delete(`sign-in ${client}`);
			attempts.delete(`presented ${client}`);
			admitted.delete(client);
			admitted.set(client, now);
			if (admitted.size > AUTH_CLIENTS_MAX) {
				const oldest = admitted.keys().next().value;
				if (oldest !== undefined) admitted.delete(oldest);
			}
		},
	};
}
