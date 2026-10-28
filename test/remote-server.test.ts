import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REMOTE_ROUTES, type RemoteCall } from "../src/shared/remote-contract";
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
		expect(await response.text()).toBe("preview-bytes");
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
});
