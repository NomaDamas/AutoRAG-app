import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REMOTE_CSRF_HEADER, REMOTE_ROUTES, type RemoteCall } from "../src/shared/remote-contract";
import { DeviceStore } from "../src/main/remote/devices";
import { createRemoteServer, type RemoteServer } from "../src/main/remote/server";

const directories: string[] = [];
const running: RemoteServer[] = [];

afterEach(async () => {
	await Promise.all(running.splice(0).map((server) => server.stop()));
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function rendererRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "remote-server-root-"));
	directories.push(root);
	await mkdir(join(root, "assets"), { recursive: true });
	await writeFile(
		join(root, "index.html"),
		`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' blob: autorag-preview:" /></head><body><script type="module" src="/assets/index.js"></script></body></html>`,
	);
	await writeFile(join(root, "assets", "index.js"), "console.log(1)");
	return root;
}

interface Fixture {
	readonly origin: string;
	readonly server: RemoteServer;
	readonly pushes: unknown[];
	readonly sessions: string[];
}

async function start(overrides: Partial<Parameters<typeof createRemoteServer>[0]> = {}): Promise<Fixture> {
	const root = await rendererRoot();
	const pushes: unknown[] = [];
	const sessions: string[] = [];
	const server = createRemoteServer({
		rendererRoot: root,
		token: "secret-token",
		host: "127.0.0.1",
		port: 0,
		bootstrapScript: "window.autorag = {};",
		dispatch: async (call: RemoteCall) => {
			if (call.method === "boom") throw new Error("finder refused");
			return { target: call.target, method: call.method, args: call.args };
		},
		preview: async () => new Response("preview-bytes", { status: 200, headers: { "content-type": "text/plain" } }),
		thumbnail: () => ({ status: 200, contentType: "image/png", body: new Uint8Array([1, 2, 3]) }),
		upload: async (folder, name, body) => {
			await writeFile(join(folder, name), body);
		},
		download: async () => ({ status: 404, contentType: null, body: null }),
		onSessionOpen: (sessionId) => sessions.push(sessionId),
		log: () => {},
		...overrides,
	});
	running.push(server);
	const started = await server.start();
	return { origin: started.origin, server, pushes, sessions };
}

describe("remote server", () => {
	it("refuses every request without the session token", async () => {
		// Given a running remote server.
		const { origin } = await start();

		// When a request arrives with no token and with a wrong token.
		const missing = await fetch(`${origin}${REMOTE_ROUTES.call}`, { method: "POST", body: "{}" });
		const wrong = await fetch(`${origin}/index.html?token=nope`);

		// Then both are refused.
		expect(missing.status).toBe(403);
		expect(wrong.status).toBe(403);
	});

	it("serves the rewritten index with the bootstrap injected before the bundle", async () => {
		// Given a running server with its token.
		const { origin } = await start();

		// When the page is fetched.
		const response = await fetch(`${origin}/?token=secret-token`);
		const body = await response.text();

		// Then the bootstrap runs first and the CSP allows same-origin HTTP.
		expect(response.status).toBe(200);
		expect(body.indexOf(REMOTE_ROUTES.bootstrap)).toBeLessThan(body.indexOf("/assets/index.js"));
		expect(body).toContain("connect-src 'self' blob: http:");
	});

	it("serves the bootstrap script", async () => {
		// Given a running server.
		const { origin } = await start();

		// When the bootstrap route is fetched.
		const response = await fetch(`${origin}${REMOTE_ROUTES.bootstrap}?token=secret-token`);

		// Then the injected script comes back as JavaScript.
		expect(response.headers.get("content-type")).toContain("javascript");
		expect(await response.text()).toContain("window.autorag");
	});

	it("dispatches a bridge call and returns its value", async () => {
		// Given a running server.
		const { origin } = await start();

		// When a filesystem call arrives with the token.
		const response = await fetch(`${origin}${REMOTE_ROUTES.call}?token=secret-token`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-remote-session": "s1" },
			body: JSON.stringify({ target: "fs", method: "listDir", args: ["/tmp"] }),
		});

		// Then the dispatched value comes back for that session.
		expect(await response.json()).toEqual({ ok: true, value: { target: "fs", method: "listDir", args: ["/tmp"] } });
	});

	it("carries a dispatcher's error back as a typed failure, not a lost request", async () => {
		// Given a running server whose dispatcher throws for one method.
		const { origin } = await start();

		// When that method is called.
		const response = await fetch(`${origin}${REMOTE_ROUTES.call}?token=secret-token`, {
			method: "POST",
			body: JSON.stringify({ target: "fs", method: "boom", args: [] }),
		});

		// Then the caller sees the verbatim reason and the request still answers 200.
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: false, error: "finder refused" });
	});

	it("streams pushes to the session that opened the event stream", async () => {
		// Given a running server with one browser session listening.
		const { origin, server, sessions } = await start();
		const response = await fetch(`${origin}${REMOTE_ROUTES.events}?token=secret-token&session=browser-1`);
		const reader = response.body?.getReader();
		expect(sessions).toEqual(["browser-1"]);
		await new Promise((resolve) => setTimeout(resolve, 20));

		// When the app pushes one event.
		server.broadcast({ channel: "search:event", payload: { type: "progress" } });

		// Then it arrives on the stream as one SSE data frame.
		const decoder = new TextDecoder();
		let seen = "";
		const deadline = Date.now() + 2000;
		while (!seen.includes('data: {"channel":"search:event","payload":{"type":"progress"}}') && Date.now() < deadline) {
			const chunk = await reader?.read();
			seen += decoder.decode(chunk?.value ?? new Uint8Array(), { stream: true });
		}
		expect(seen).toContain('data: {"channel":"search:event","payload":{"type":"progress"}}');
		await reader?.cancel();
	});

	it("serves preview bytes through the same reader the desktop uses", async () => {
		// Given a running server.
		const { origin } = await start();

		// When a preview is requested with an encoded path.
		const response = await fetch(`${origin}${REMOTE_ROUTES.preview}?path=%2Ftmp%2Fa.png&token=secret-token`);

		// Then the preview body comes back.
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(await response.text()).toBe("preview-bytes");
	});

	it("sandboxes SVG previews so embedded scripts cannot run on the remote origin", async () => {
		const { origin } = await start({
			preview: async () => new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml" } }),
		});
		const response = await fetch(`${origin}${REMOTE_ROUTES.preview}?path=%2Ftmp%2Fa.svg&token=secret-token`);
		expect(response.headers.get("content-security-policy")).toContain("sandbox");
	});

	it("writes an uploaded file into the requested folder", async () => {
		// Given a destination folder and a running server.
		const folder = await mkdtemp(join(tmpdir(), "remote-upload-"));
		directories.push(folder);
		const { origin } = await start();

		// When a browser uploads one file.
		const response = await fetch(`${origin}${REMOTE_ROUTES.upload}?folder=${encodeURIComponent(folder)}&name=notes.txt&token=secret-token`, {
			method: "POST",
			body: "hello",
		});

		// Then it is written under its own name.
		expect(await response.json()).toEqual({ ok: true });
		expect(await (await import("node:fs/promises")).readFile(join(folder, "notes.txt"), "utf8")).toBe("hello");
	});

	it("serves the AccessGate HTML at GET / for unauthenticated browsers while still refusing GET /index.html and /remote/call with 403", async () => {
		const dir = await mkdtemp(join(tmpdir(), "remote-devices-srv-"));
		directories.push(dir);
		const devices = new DeviceStore(dir);
		const { origin } = await start({ devices });

		const gate = await fetch(`${origin}/`, { headers: { accept: "text/html" } });
		const html = await gate.text();
		expect(gate.status).toBe(200);
		expect(html).toContain('data-testid="remote-access-gate"');

		const health = await fetch(`${origin}${REMOTE_ROUTES.health}`);
		expect(await health.json()).toEqual({ ok: true, authenticated: false, reason: "pairing_required" });

		const directCall = await fetch(`${origin}${REMOTE_ROUTES.call}`, { method: "POST", body: "{}" });
		expect(directCall.status).toBe(403);
	});

	it("pairs a browser via 6-digit code into an HttpOnly dazzi_device cookie and immediately closes its SSE stream on revoke", async () => {
		const dir = await mkdtemp(join(tmpdir(), "remote-devices-pair-"));
		directories.push(dir);
		const devices = new DeviceStore(dir);
		const { origin } = await start({ devices });

		const pairing = devices.startPairing();
		const pairRes = await fetch(`${origin}${REMOTE_ROUTES.pair}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[REMOTE_CSRF_HEADER]: "1",
			},
			body: JSON.stringify({ code: pairing.code, label: "iPhone · Safari" }),
		});
		expect(pairRes.status).toBe(204);
		const setCookie = pairRes.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("dazzi_device=");
		expect(setCookie).toContain("HttpOnly");
		const cookiePair = setCookie.split(";")[0]!;

		// Cookie alone authenticates GET /, /remote/health, /remote/call, and /remote/events without ?token=
		const rootRes = await fetch(`${origin}/`, { headers: { cookie: cookiePair } });
		expect(rootRes.status).toBe(200);
		expect(await rootRes.text()).toContain(REMOTE_ROUTES.bootstrap);

		const healthRes = await fetch(`${origin}${REMOTE_ROUTES.health}`, { headers: { cookie: cookiePair } });
		expect(await healthRes.json()).toMatchObject({ ok: true, authenticated: true, via: "device" });

		const callRes = await fetch(`${origin}${REMOTE_ROUTES.call}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				cookie: cookiePair,
				origin,
			},
			body: JSON.stringify({ target: "fs", method: "listDir", args: ["/tmp"] }),
		});
		expect(await callRes.json()).toEqual({ ok: true, value: { target: "fs", method: "listDir", args: ["/tmp"] } });

		// Cross-site POST with device cookie is refused by CSRF same-origin guard
		const csrfRes = await fetch(`${origin}${REMOTE_ROUTES.call}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				cookie: cookiePair,
				origin: "https://attacker.example",
			},
			body: JSON.stringify({ target: "fs", method: "listDir", args: ["/tmp"] }),
		});
		expect(csrfRes.status).toBe(403);

		// Open SSE stream with the device cookie, then revoke the device and verify stream terminates immediately
		const sseRes = await fetch(`${origin}${REMOTE_ROUTES.events}?session=dev-1`, { headers: { cookie: cookiePair } });
		expect(sseRes.status).toBe(200);
		const reader = sseRes.body!.getReader();
		await reader.read(); // initial retry frame

		const enrolledId = devices.list(null)[0]!.id;
		expect(devices.revoke(enrolledId)).toBe(true);

		// Stream closes on revoke
		const closed = await reader.read();
		expect(closed.done).toBe(true);

		// Subsequent requests with the revoked cookie are refused
		const afterRevoke = await fetch(`${origin}${REMOTE_ROUTES.call}`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie: cookiePair, origin },
			body: JSON.stringify({ target: "fs", method: "listDir", args: ["/tmp"] }),
		});
		expect(afterRevoke.status).toBe(403);
	});

	it("authenticates POST /remote/auth with the session token and rate-limits brute-force guesses", async () => {
		const { origin } = await start();

		for (let i = 0; i < 5; i++) {
			const bad = await fetch(`${origin}${REMOTE_ROUTES.auth}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: "wrong-token" }),
			});
			expect(bad.status).toBe(401);
		}
		const throttled = await fetch(`${origin}${REMOTE_ROUTES.auth}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: "wrong-token" }),
		});
		expect(throttled.status).toBe(429);
	});

});
