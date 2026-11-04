import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { AddressInfo } from "node:net";
import {
	REMOTE_ROUTES,
	REMOTE_TOKEN_HEADER,
	type RemoteAccessRefusal,
	type RemoteAccessVia,
	type RemoteCall,
	type RemotePush,
} from "../../shared/remote-contract";
import type { AppSettings } from "../../shared/settings-contract";
import {
	DEVICE_TOKEN_COOKIE,
	SESSION_TOKEN_COOKIE,
	buildDeviceCookie,
	buildSessionCookie,
	clearCookieHeader,
	constantTimeTokenMatches,
	createAuthRateLimiter,
	isSameOriginMutation,
	isSecureIncomingRequest,
	parseCookieHeader,
} from "./auth";
import type { DeviceStore } from "./devices";
import { renderAccessGateHtml } from "./gate";
import { readRemoteStatic, REMOTE_BOOTSTRAP_PATH, rewriteIndexHtml } from "./static";

/**
 * The opt-in remote server: while enabled it serves the same renderer bundle
 * the desktop window loads, plus the bridge endpoints a browser needs.
 *
 * Authentication modes (adapted from Ovis `devswha/ovis`):
 * 1. Session token (`x-remote-token` header, `?token=` query, or `dazzi_remote` HttpOnly cookie).
 * 2. Paired device credential (`dazzi_device` HttpOnly cookie backed by SHA-256 hash in `DeviceStore`).
 *
 * Unauthenticated `GET /` renders the self-contained AccessGate (`gate.ts`) so a phone or
 * remote browser can scan a `?pair=CODE` QR code, type a 6-digit pairing code, or unlock with
 * the access token. Every other unauthenticated route returns 403.
 */

export interface RemoteStaticResponse {
	readonly status: number;
	readonly contentType: string | null;
	readonly body: Uint8Array | null;
}

export interface RemoteAuthenticatedContext {
	readonly via: RemoteAccessVia;
	readonly deviceId: string | null;
	readonly includeQueryToken: boolean;
}

export interface RemoteServerDeps {
	/** `out/renderer`: the bundle the desktop window loads. */
	readonly rendererRoot: string;
	readonly token: string;
	readonly host: string;
	readonly port: number;
	/** Fallback static bootstrap script (or dynamic per-session builder via `bootstrapScriptFor`). */
	readonly bootstrapScript: string;
	readonly bootstrapScriptFor?: (auth: RemoteAuthenticatedContext) => Promise<string> | string;
	readonly devices?: DeviceStore;
	readonly gatePrefs?: () => Promise<{ readonly language: AppSettings["language"]; readonly appearance: AppSettings["appearance"] }>;
	/** The Dazzi mark drawn on the AccessGate, as a `data:` URL. */
	readonly gateLogoDataUrl?: string;
	/** One bridge method, already authorized. */
	readonly dispatch: (call: RemoteCall, sessionId: string) => Promise<unknown>;
	/** A browser session's push stream opened or closed (its worker client's lifetime). */
	readonly onSessionOpen?: (sessionId: string) => void;
	readonly onSessionClose?: (sessionId: string) => void;
	/** Preview bytes with HTTP range support, reusing the desktop's own reader. */
	readonly preview: (filePath: string, range: string | null) => Promise<Response>;
	/** Thumbnail bytes, reusing the desktop's own icon cache. */
	readonly thumbnail: (query: URLSearchParams) => RemoteStaticResponse;
	/** One dropped browser file, written into a host folder. */
	readonly upload: (folder: string, name: string, bytes: Uint8Array) => Promise<void>;
	/** One host file as a browser download; `null` when it is missing. */
	readonly download: (filePath: string) => Promise<RemoteStaticResponse>;
	readonly log: (message: string) => void;
}

export interface RemoteServer {
	start(): Promise<{ readonly port: number; readonly origin: string }>;
	stop(): Promise<void>;
	/** Send one push to every open browser session. */
	broadcast(payload: RemotePush): void;
	/** Send one push to a single browser session (its own watcher's change batches). */
	sendToSession(sessionId: string, payload: RemotePush): void;
}

const MAX_BODY_BYTES = 512 * 1024 * 1024;
const SMALL_AUTH_BODY_BYTES = 16 * 1024;

function send(
	response: ServerResponse,
	status: number,
	contentType: string | null,
	body: Uint8Array | null,
	cacheControl = "no-store",
): void {
	response.statusCode = status;
	if (contentType !== null) response.setHeader("content-type", contentType);
	response.setHeader("cache-control", cacheControl);
	if (body === null) {
		response.end();
		return;
	}
	response.setHeader("content-length", String(body.byteLength));
	response.end(Buffer.from(body));
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
	send(response, status, "application/json; charset=utf-8", Buffer.from(JSON.stringify(payload)));
}

async function readBody(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Uint8Array> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
		total += buffer.byteLength;
		if (total > maxBytes) throw new Error("remote request body too large");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}

type RequestAuthDecision =
	| ({ readonly authenticated: true } & RemoteAuthenticatedContext)
	| { readonly authenticated: false; readonly reason: RemoteAccessRefusal; readonly throttledSeconds?: number };

export function createRemoteServer(deps: RemoteServerDeps): RemoteServer {
	let server: Server | null = null;
	const sessions = new Map<string, (payload: RemotePush) => void>();
	const rateLimiter = createAuthRateLimiter();

	const firstHeader = (value: string | string[] | undefined): string | null =>
		typeof value === "string" ? value : Array.isArray(value) ? (value[0] ?? null) : null;

	const decideRequestAuth = (request: IncomingMessage, url: URL): RequestAuthDecision => {
		const client = rateLimiter.clientKey(request.socket?.remoteAddress, request.headers["x-forwarded-for"]);
		const cookies = parseCookieHeader(request.headers.cookie);

		// 1. Explicit header or query token, or session token cookie (`dazzi_remote`)
		const headerToken = firstHeader(request.headers[REMOTE_TOKEN_HEADER]);
		const queryToken = url.searchParams.get("token");
		const cookieToken = cookies.get(SESSION_TOKEN_COOKIE) ?? null;
		const presentedToken = headerToken ?? queryToken ?? cookieToken;

		if (presentedToken !== null) {
			const wait = rateLimiter.waitSeconds("presented", client);
			if (wait > 0) {
				return { authenticated: false, reason: "pairing_required", throttledSeconds: wait };
			}
			if (constantTimeTokenMatches(deps.token, presentedToken)) {
				rateLimiter.admit(client);
				return {
					authenticated: true,
					via: "token",
					deviceId: null,
					includeQueryToken: headerToken !== null || queryToken !== null,
				};
			}
			rateLimiter.recordFailure("presented", client);
			// If header or query token was explicitly wrong, fail immediately instead of falling back.
			if (headerToken !== null || queryToken !== null) {
				return { authenticated: false, reason: "pairing_required" };
			}
		}

		// 2. Paired device cookie (`dazzi_device`)
		const deviceCookie = cookies.get(DEVICE_TOKEN_COOKIE);
		if (deviceCookie !== undefined && deps.devices !== undefined) {
			const matched = deps.devices.match(deviceCookie);
			if (matched !== null) {
				return {
					authenticated: true,
					via: "device",
					deviceId: matched.id,
					includeQueryToken: false,
				};
			}
		}

		return { authenticated: false, reason: "pairing_required" };
	};

	const handlePair = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		if (request.method !== "POST") {
			send(response, 405, "text/plain; charset=utf-8", Buffer.from("method not allowed"));
			return;
		}
		if (!isSameOriginMutation(request)) {
			sendJson(response, 403, { ok: false, error: "cross-origin pairing refused" });
			return;
		}
		if (deps.devices === undefined) {
			sendJson(response, 503, { ok: false, error: "device pairing unavailable" });
			return;
		}
		if (deps.devices.error !== null) {
			sendJson(response, 503, { ok: false, error: "device registry unavailable" });
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(Buffer.from(await readBody(request, SMALL_AUTH_BODY_BYTES)).toString("utf8"));
		} catch {
			sendJson(response, 400, { ok: false, error: "invalid json" });
			return;
		}
		if (typeof parsed !== "object" || parsed === null || !("code" in parsed) || typeof parsed.code !== "string") {
			sendJson(response, 400, { ok: false, error: "code is required" });
			return;
		}
		const label = "label" in parsed ? parsed.label : undefined;
		const paired = deps.devices.pair(parsed.code, label);
		if (paired === null) {
			sendJson(response, 401, { ok: false, error: "invalid or expired pairing code" });
			return;
		}
		const secure = isSecureIncomingRequest(request.headers);
		response.setHeader("set-cookie", buildDeviceCookie(paired.token, secure));
		send(response, 204, null, null);
	};

	const handleAuth = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		if (request.method === "DELETE") {
			if (!isSameOriginMutation(request)) {
				sendJson(response, 403, { ok: false, error: "cross-origin sign-out refused" });
				return;
			}
			response.setHeader("set-cookie", [
				clearCookieHeader(SESSION_TOKEN_COOKIE),
				clearCookieHeader(DEVICE_TOKEN_COOKIE),
			]);
			send(response, 204, null, null);
			return;
		}
		if (request.method !== "POST") {
			send(response, 405, "text/plain; charset=utf-8", Buffer.from("method not allowed"));
			return;
		}
		if (!isSameOriginMutation(request)) {
			sendJson(response, 403, { ok: false, error: "cross-origin sign-in refused" });
			return;
		}
		const client = rateLimiter.clientKey(request.socket?.remoteAddress, request.headers["x-forwarded-for"]);
		const waitBefore = rateLimiter.waitSeconds("sign-in", client);
		if (waitBefore > 0) {
			response.setHeader("retry-after", String(waitBefore));
			sendJson(response, 429, { ok: false, error: `too many attempts; wait ${waitBefore}s` });
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(Buffer.from(await readBody(request, SMALL_AUTH_BODY_BYTES)).toString("utf8"));
		} catch {
			sendJson(response, 400, { ok: false, error: "invalid json" });
			return;
		}
		if (typeof parsed !== "object" || parsed === null || !("token" in parsed) || typeof parsed.token !== "string") {
			sendJson(response, 400, { ok: false, error: "token is required" });
			return;
		}
		const waitAfter = rateLimiter.waitSeconds("sign-in", client);
		if (waitAfter > 0) {
			response.setHeader("retry-after", String(waitAfter));
			sendJson(response, 429, { ok: false, error: `too many attempts; wait ${waitAfter}s` });
			return;
		}
		if (!constantTimeTokenMatches(deps.token, parsed.token)) {
			rateLimiter.recordFailure("sign-in", client);
			sendJson(response, 401, { ok: false, error: "token does not match" });
			return;
		}
		rateLimiter.admit(client);
		const secure = isSecureIncomingRequest(request.headers);
		response.setHeader("set-cookie", buildSessionCookie(deps.token, secure));
		send(response, 204, null, null);
	};

	const handleEvents = (
		request: IncomingMessage,
		response: ServerResponse,
		sessionId: string,
		auth: RemoteAuthenticatedContext,
	): void => {
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-store",
			connection: "keep-alive",
		});
		response.write("retry: 1000\n\n");
		sessions.set(sessionId, (payload) => {
			response.write(`data: ${JSON.stringify(payload)}\n\n`);
		});
		deps.onSessionOpen?.(sessionId);
		const keepAlive = setInterval(() => response.write(": ping\n\n"), 15_000);
		let cleanedUp = false;
		let unsubscribeRevoke: (() => void) | null = null;
		const cleanup = (): void => {
			if (cleanedUp) return;
			cleanedUp = true;
			clearInterval(keepAlive);
			unsubscribeRevoke?.();
			unsubscribeRevoke = null;
			sessions.delete(sessionId);
			deps.onSessionClose?.(sessionId);
		};
		if (auth.deviceId !== null && deps.devices !== undefined) {
			unsubscribeRevoke = deps.devices.onRevoke(auth.deviceId, () => {
				cleanup();
				response.end();
			});
		}
		request.on("close", cleanup);
	};

	const sessionIdFrom = (request: IncomingMessage, url: URL): string =>
		typeof request.headers["x-remote-session"] === "string"
			? request.headers["x-remote-session"]
			: (url.searchParams.get("session") ?? "default");

	const handleCall = async (request: IncomingMessage, response: ServerResponse, sessionId: string): Promise<void> => {
		const body = await readBody(request);
		let parsed: unknown;
		try {
			parsed = JSON.parse(Buffer.from(body).toString("utf8"));
		} catch {
			send(response, 400, "application/json", Buffer.from(JSON.stringify({ ok: false, error: "invalid json" })));
			return;
		}
		if (typeof parsed !== "object" || parsed === null || !("target" in parsed) || !("method" in parsed)) {
			send(response, 400, "application/json", Buffer.from(JSON.stringify({ ok: false, error: "invalid call" })));
			return;
		}
		const call = parsed as RemoteCall;
		try {
			const value = await deps.dispatch(call, sessionId);
			send(response, 200, "application/json", Buffer.from(JSON.stringify({ ok: true, value })));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
			send(response, 200, "application/json", Buffer.from(JSON.stringify({ ok: false, error: message, code })));
		}
	};

	const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const url = new URL(request.url ?? "/", "http://remote.local");

		// Public pairing & auth endpoints
		if (url.pathname === REMOTE_ROUTES.pair) {
			await handlePair(request, response);
			return;
		}
		if (url.pathname === REMOTE_ROUTES.auth) {
			await handleAuth(request, response);
			return;
		}

		const auth = decideRequestAuth(request, url);

		if (url.pathname === REMOTE_ROUTES.health && request.method === "GET") {
			if (auth.authenticated) {
				sendJson(response, 200, { ok: true, authenticated: true, via: auth.via });
			} else {
				sendJson(response, 200, { ok: true, authenticated: false, reason: auth.reason });
			}
			return;
		}

		if (!auth.authenticated) {
			if (auth.throttledSeconds !== undefined) {
				response.setHeader("retry-after", String(auth.throttledSeconds));
				send(response, 429, "text/plain; charset=utf-8", Buffer.from("too many wrong tokens"));
				return;
			}
			// Render the interactive AccessGate at GET / when no wrong ?token= was given and pairing/auth is supported.
			if (
				request.method === "GET" &&
				url.pathname === "/" &&
				!url.searchParams.has("token") &&
				(deps.devices !== undefined || deps.gatePrefs !== undefined)
			) {
				const prefs = (await deps.gatePrefs?.()) ?? { language: "ko" as const, appearance: "light" as const };
				const html = renderAccessGateHtml({
					language: prefs.language,
					appearance: prefs.appearance,
					reason: auth.reason,
					logoDataUrl: deps.gateLogoDataUrl ?? null,
				});
				send(response, 200, "text/html; charset=utf-8", Buffer.from(html));
				return;
			}
			send(response, 403, "text/plain; charset=utf-8", Buffer.from("remote access token required"));
			return;
		}

		// Protect authenticated state-changing endpoints against cross-site request forgery
		if (!isSameOriginMutation(request)) {
			send(response, 403, "text/plain; charset=utf-8", Buffer.from("cross-origin request refused"));
			return;
		}

		const sessionId = sessionIdFrom(request, url);
		if (url.pathname === REMOTE_ROUTES.bootstrap && request.method === "GET") {
			const script = deps.bootstrapScriptFor ? await deps.bootstrapScriptFor(auth) : deps.bootstrapScript;
			send(response, 200, "text/javascript; charset=utf-8", Buffer.from(script));
			return;
		}
		if (url.pathname === REMOTE_ROUTES.events && request.method === "GET") {
			handleEvents(request, response, sessionId, auth);
			return;
		}
		if (url.pathname === REMOTE_ROUTES.call && request.method === "POST") {
			await handleCall(request, response, sessionId);
			return;
		}
		if (url.pathname === REMOTE_ROUTES.thumb && request.method === "GET") {
			const result = deps.thumbnail(url.searchParams);
			send(response, result.status, result.contentType, result.body);
			return;
		}
		if (url.pathname === REMOTE_ROUTES.preview && request.method === "GET") {
			const filePath = url.searchParams.get("path");
			if (filePath === null || filePath.length === 0) {
				send(response, 400, "text/plain; charset=utf-8", Buffer.from("path required"));
				return;
			}
			const range = request.headers.range;
			const result = await deps.preview(filePath, typeof range === "string" ? range : null);
			response.statusCode = result.status;
			for (const [name, value] of result.headers) response.setHeader(name, value);
			response.setHeader("cache-control", "no-store");
			response.setHeader("x-content-type-options", "nosniff");
			if (result.headers.get("content-type")?.startsWith("image/svg+xml") === true) {
				response.setHeader("content-security-policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
			}
			if (result.body === null) {
				response.end();
				return;
			}
			Readable.fromWeb(result.body as WebReadableStream<Uint8Array>).pipe(response);
			return;
		}
		if (url.pathname === REMOTE_ROUTES.download && request.method === "GET") {
			const filePath = url.searchParams.get("path");
			if (filePath === null || filePath.length === 0) {
				send(response, 400, "text/plain; charset=utf-8", Buffer.from("path required"));
				return;
			}
			const result = await deps.download(filePath);
			if (result.status === 200) {
				response.setHeader(
					"content-disposition",
					`attachment; filename*=UTF-8''${encodeURIComponent(filePath.split(/[/\\]/).pop() ?? "download")}`,
				);
			}
			send(response, result.status, result.contentType, result.body);
			return;
		}
		if (url.pathname === REMOTE_ROUTES.upload && request.method === "POST") {
			const folder = url.searchParams.get("folder");
			const name = url.searchParams.get("name");
			if (folder === null || name === null || name.length === 0) {
				send(response, 400, "text/plain; charset=utf-8", Buffer.from("folder and name required"));
				return;
			}
			try {
				await deps.upload(folder, name, await readBody(request));
				send(response, 200, "application/json", Buffer.from(JSON.stringify({ ok: true })));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				send(response, 400, "application/json", Buffer.from(JSON.stringify({ ok: false, error: message })));
			}
			return;
		}
		if (request.method !== "GET") {
			send(response, 405, "text/plain; charset=utf-8", Buffer.from("method not allowed"));
			return;
		}
		const relative = url.pathname === "/" ? "index.html" : url.pathname;
		if (relative === "index.html") {
			const file = await readRemoteStatic(deps.rendererRoot, "/index.html");
			if (file === null) {
				send(response, 404, null, null);
				return;
			}
			const rewritten = rewriteIndexHtml(Buffer.from(file.body).toString("utf8"));
			if (auth.via === "token" && url.searchParams.has("token")) {
				const secure = isSecureIncomingRequest(request.headers);
				response.setHeader("set-cookie", buildSessionCookie(deps.token, secure));
			}
			send(response, 200, file.contentType, Buffer.from(rewritten));
			return;
		}
		const file = await readRemoteStatic(deps.rendererRoot, relative);
		if (file === null) {
			send(response, 404, null, null);
			return;
		}
		send(
			response,
			200,
			file.contentType,
			file.body,
			extname(relative) === ".html" ? "no-store" : "public, max-age=31536000, immutable",
		);
	};

	return {
		async start() {
			server = createServer((request, response) => {
				void handle(request, response).catch((error: unknown) => {
					deps.log(`remote request failed: ${error instanceof Error ? error.message : String(error)}`);
					if (!response.headersSent) send(response, 500, "text/plain; charset=utf-8", Buffer.from("remote error"));
					else response.end();
				});
			});
			await new Promise<void>((resolve, reject) => {
				server?.once("error", reject);
				server?.listen(deps.port, deps.host, () => resolve());
			});
			const address = server.address() as AddressInfo;
			return { port: address.port, origin: `http://${deps.host === "0.0.0.0" ? "localhost" : deps.host}:${address.port}` };
		},
		broadcast(payload) {
			for (const sink of sessions.values()) sink(payload);
		},
		sendToSession(sessionId, payload) {
			sessions.get(sessionId)?.(payload);
		},
		async stop() {
			sessions.clear();
			const current = server;
			server = null;
			if (current === null) return;
			await new Promise<void>((resolve) => current.close(() => resolve()));
		},
	};
}

export { REMOTE_BOOTSTRAP_PATH };
