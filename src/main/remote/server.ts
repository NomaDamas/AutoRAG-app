import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { extname } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { AddressInfo } from "node:net";
import { REMOTE_ROUTES, REMOTE_TOKEN_HEADER, type RemoteCall, type RemotePush } from "../../shared/remote-contract";
import { readRemoteStatic, REMOTE_BOOTSTRAP_PATH, rewriteIndexHtml } from "./static";

/**
 * The opt-in remote server: while enabled it serves the same renderer bundle
 * the desktop window loads, plus the bridge endpoints a browser needs. It never
 * runs unless the setting is on, and every request is refused without the
 * session token. Native-only actions are answered by the dispatcher (not here).
 */

export interface RemoteStaticResponse {
	readonly status: number;
	readonly contentType: string | null;
	readonly body: Uint8Array | null;
}

export interface RemoteServerDeps {
	/** `out/renderer`: the bundle the desktop window loads. */
	readonly rendererRoot: string;
	readonly token: string;
	readonly host: string;
	readonly port: number;
	/** The bootstrap script defining `window.autorag`, built for this session. */
	readonly bootstrapScript: string;
	/** One bridge method, already authorized by the token. */
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

function tokenMatches(expected: string, received: string | null): boolean {
	if (received === null) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(received);
	return a.length === b.length && timingSafeEqual(a, b);
}

const SESSION_COOKIE = "dazzi_remote";

/** The token may ride the header (bootstrap fetches), the query (first entry, downloads) or the session cookie the first entry sets. */
function tokenFrom(request: IncomingMessage, url: URL): string | null {
	const header = request.headers[REMOTE_TOKEN_HEADER];
	if (typeof header === "string") return header;
	const query = url.searchParams.get("token");
	if (query !== null) return query;
	const cookie = request.headers.cookie;
	if (typeof cookie !== "string") return null;
	for (const part of cookie.split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name === SESSION_COOKIE) return rest.join("=") || null;
	}
	return null;
}

function send(response: ServerResponse, status: number, contentType: string | null, body: Uint8Array | null, cacheControl = "no-store"): void {
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

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
		total += buffer.byteLength;
		if (total > MAX_BODY_BYTES) throw new Error("remote request body too large");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}

export function createRemoteServer(deps: RemoteServerDeps): RemoteServer {
	let server: Server | null = null;
	const sessions = new Map<string, (payload: RemotePush) => void>();

	const handleEvents = (request: IncomingMessage, response: ServerResponse, sessionId: string): void => {
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
		request.on("close", () => {
			clearInterval(keepAlive);
			sessions.delete(sessionId);
			deps.onSessionClose?.(sessionId);
		});
	};

	const sessionIdFrom = (request: IncomingMessage, url: URL): string =>
		typeof request.headers["x-remote-session"] === "string" ? request.headers["x-remote-session"] : (url.searchParams.get("session") ?? "default");

	const handleCall = async (request: IncomingMessage, response: ServerResponse, sessionId: string): Promise<void> => {
		const body = await readBody(request);
		let parsed: unknown;
		try {
			parsed = JSON.parse(Buffer.from(body).toString("utf8"));
		} catch (error) {
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
		if (!tokenMatches(deps.token, tokenFrom(request, url))) {
			send(response, 403, "text/plain; charset=utf-8", Buffer.from("remote access token required"));
			return;
		}
		const sessionId = sessionIdFrom(request, url);
		if (url.pathname === REMOTE_ROUTES.bootstrap && request.method === "GET") {
			send(response, 200, "text/javascript; charset=utf-8", Buffer.from(deps.bootstrapScript));
			return;
		}
		if (url.pathname === REMOTE_ROUTES.events && request.method === "GET") {
			handleEvents(request, response, sessionId);
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
				// A browser must save the file, not render it: an attachment
				// disposition is what makes every content type land as a download.
				response.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filePath.split(/[/\\]/).pop() ?? "download")}`);
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
			// The page's own subresources (bootstrap, fonts, chunks) carry no query
			// token, so the first authenticated entry pins the session as a cookie.
			response.setHeader("set-cookie", `${SESSION_COOKIE}=${deps.token}; Path=/; HttpOnly; SameSite=Strict`);
			send(response, 200, file.contentType, Buffer.from(rewritten));
			return;
		}
		const file = await readRemoteStatic(deps.rendererRoot, relative);
		if (file === null) {
			send(response, 404, null, null);
			return;
		}
		// Hashed asset names never change contents, so they may be cached hard; HTML must not be.
		send(response, 200, file.contentType, file.body, extname(relative) === ".html" ? "no-store" : "public, max-age=31536000, immutable");
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
