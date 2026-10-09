import { createHash } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeOsLaunchRequest, type OsLaunchRequest } from "../shared/os-request-contract";

/**
 * Hands a menu request from the short-lived process the OS started to the
 * running app. The running app listens on a per-profile local socket (a unix
 * socket under the temp dir, a named pipe on Windows); the launched process
 * connects, sends one JSON request, waits for the acknowledgement, and exits.
 *
 * Electron's `requestSingleInstanceLock` is deliberately not used: it would
 * stop a second clone sharing the default profile from starting at all, and
 * only requests (never ordinary launches) need to find the running app.
 */

const ACK = "ok";
/** A request is a few hundred paths at most; anything bigger is not ours. */
const MAX_REQUEST_BYTES = 1024 * 1024;
const CONNECT_TIMEOUT_MS = 2000;

/** The socket path or pipe name for one profile. Unix socket paths are capped near 100 bytes, so it is hashed. */
export function osRequestEndpoint(userDataDir: string, platform: NodeJS.Platform = process.platform): string {
	const id = createHash("sha256").update(userDataDir).digest("hex").slice(0, 16);
	return platform === "win32" ? `\\\\.\\pipe\\autorag-os-${id}` : join(tmpdir(), `autorag-os-${id}.sock`);
}

/** Send `request` to the app listening on `endpoint`; false when nobody is listening or it did not acknowledge. */
export function sendOsRequest(endpoint: string, request: OsLaunchRequest): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = connect(endpoint);
	let reply = "";
	socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy());
	socket.on("connect", () => socket.end(JSON.stringify(request)));
	socket.on("data", (chunk) => {
		reply += chunk.toString("utf8");
	});
	socket.on("error", () => resolve(false));
	socket.on("close", () => resolve(reply === ACK));
	return promise;
}

/** Whether something accepts connections on `endpoint`. */
function isListening(endpoint: string): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = connect(endpoint);
	socket.on("connect", () => {
		socket.destroy();
		resolve(true);
	});
	socket.on("error", () => resolve(false));
	return promise;
}

export interface OsRequestListener {
	close(): Promise<void>;
}

/**
 * Accept requests on `endpoint`. Resolves null when another process already
 * listens there (a second clone on the same profile), which is not an error:
 * that clone simply does not receive menu requests.
 */
export async function listenForOsRequests(
	endpoint: string,
	onRequest: (request: OsLaunchRequest) => void,
	platform: NodeJS.Platform = process.platform,
): Promise<OsRequestListener | null> {
	if (platform !== "win32") {
		if (await isListening(endpoint)) return null;
		// Nobody answered: a socket file left by a crashed run would block `listen`.
		await unlink(endpoint).catch(() => undefined);
	}
	const server: Server = createServer((socket) => {
		const chunks: Buffer[] = [];
		let size = 0;
		socket.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_REQUEST_BYTES) {
				socket.destroy();
				return;
			}
			chunks.push(chunk);
		});
		socket.on("end", () => {
			// An empty connection is a liveness probe, not a request.
			if (size === 0) return;
			let request: OsLaunchRequest | null = null;
			try {
				request = normalizeOsLaunchRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				// Not JSON: handled like an invalid request.
			}
			// No acknowledgement for a rejected request: the sender then knows nothing took it.
			if (request === null) return;
			onRequest(request);
			socket.end(ACK);
		});
		socket.on("error", () => undefined);
	});
	const listening = Promise.withResolvers<boolean>();
	server.once("error", () => listening.resolve(false));
	server.listen(endpoint, () => listening.resolve(true));
	if (!(await listening.promise)) return null;
	if (platform !== "win32") await chmod(endpoint, 0o600).catch(() => undefined);
	return {
		close() {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			return closed.promise;
		},
	};
}
