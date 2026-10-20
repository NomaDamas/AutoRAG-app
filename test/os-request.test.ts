import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listenForOsRequests, osRequestEndpoint, sendOsRequest } from "../src/main/os-request-channel";
import { createOsRequestService, diskKindOf } from "../src/main/os-request-service";
import { normalizeOsLaunchRequest, parseOsRequestArgv, type OsLaunchRequest } from "../src/shared/os-request-contract";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("parseOsRequestArgv", () => {
	it("reads the action and every path, in order", () => {
		expect(
			parseOsRequestArgv(["/App", "--autorag-request=ask", "--autorag-path=/a/one.pdf", "--autorag-path=/a/two dir"]),
		).toEqual({ action: "ask", paths: ["/a/one.pdf", "/a/two dir"] });
	});

	it("is null for an ordinary launch, an unknown action, or no absolute path", () => {
		expect(parseOsRequestArgv(["/App", "--inspect=1"])).toBeNull();
		expect(parseOsRequestArgv(["--autorag-request=delete", "--autorag-path=/a"])).toBeNull();
		expect(parseOsRequestArgv(["--autorag-request=ask"])).toBeNull();
		expect(parseOsRequestArgv(["--autorag-request=ask", "--autorag-path=relative/file"])).toBeNull();
	});

	it("reads the open action the dazzi command sends", () => {
		expect(parseOsRequestArgv(["/App", "--autorag-request=open", "--autorag-path=/work/a", "--autorag-path=/work/b.md"])).toEqual({
			action: "open",
			paths: ["/work/a", "/work/b.md"],
		});
	});

	it("keeps Windows drive and UNC paths and drops the stray quote Explorer leaves on a drive root", () => {
		expect(
			parseOsRequestArgv(["--autorag-request=reveal", "--autorag-path=D:\\", '--autorag-path=D:\\"', "--autorag-path=\\\\srv\\share\\f.txt"]),
		).toEqual({ action: "reveal", paths: ["D:\\", "\\\\srv\\share\\f.txt"] });
	});
});

describe("normalizeOsLaunchRequest", () => {
	it("rejects a request that is not an action plus a list of strings", () => {
		expect(normalizeOsLaunchRequest(null)).toBeNull();
		expect(normalizeOsLaunchRequest({ action: "ask", paths: "/a" })).toBeNull();
		expect(normalizeOsLaunchRequest({ action: "ask", paths: ["/a", 7] })).toBeNull();
		expect(normalizeOsLaunchRequest({ action: "ask", paths: ["/a\0b"] })).toBeNull();
		expect(normalizeOsLaunchRequest({ action: "ask", paths: Array.from({ length: 201 }, (_, i) => `/f${i}`) })).toBeNull();
	});

	it("drops relative paths and duplicates", () => {
		expect(normalizeOsLaunchRequest({ action: "ask", paths: ["/a", "rel", "/a", "/b"] })).toEqual({ action: "ask", paths: ["/a", "/b"] });
	});
});

describe("createOsRequestService", () => {
	it("attaches only the paths that exist, with their real kind, and notifies once", async () => {
		const dir = await mkdtemp(join(tmpdir(), "os-req-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		await writeFile(join(dir, "note.txt"), "x");
		await mkdir(join(dir, "folder"));
		let queued = 0;
		const service = createOsRequestService({ kindOf: diskKindOf, onQueued: () => (queued += 1) });
		await service.push({ action: "ask", paths: [join(dir, "note.txt"), join(dir, "gone.txt"), join(dir, "folder")] });
		expect(queued).toBe(1);
		expect(service.take()).toEqual([
			{
				action: "ask",
				attachments: [
					{ kind: "file", id: join(dir, "note.txt"), name: "note.txt" },
					{ kind: "folder", id: join(dir, "folder"), name: "folder" },
				],
			},
		]);
		expect(service.take()).toEqual([]);
	});

	it("queues nothing when no path survives", async () => {
		let queued = 0;
		const service = createOsRequestService({ kindOf: async () => null, onQueued: () => (queued += 1) });
		await service.push({ action: "reveal", paths: ["/nowhere"] });
		expect(queued).toBe(0);
		expect(service.take()).toEqual([]);
	});

	it("reveal keeps the first existing path only", async () => {
		const service = createOsRequestService({ kindOf: async (path) => (path === "/a" ? null : "file"), onQueued: () => undefined });
		await service.push({ action: "reveal", paths: ["/a", "/b", "/c"] });
		expect(service.take()).toEqual([{ action: "reveal", path: "/b" }]);
	});
});

describe("createOsRequestService open", () => {
	it("keeps every existing path with its kind, in order, and drops the missing ones", async () => {
		let queued = 0;
		const kinds: Record<string, "file" | "folder"> = { "/work/dir": "folder", "/work/a.md": "file" };
		const service = createOsRequestService({ kindOf: async (path) => kinds[path] ?? null, onQueued: () => (queued += 1) });
		await service.push({ action: "open", paths: ["/work/dir", "/work/gone", "/work/a.md"] });
		expect(queued).toBe(1);
		expect(service.take()).toEqual([
			{
				action: "open",
				targets: [
					{ path: "/work/dir", kind: "folder" },
					{ path: "/work/a.md", kind: "file" },
				],
			},
		]);
	});

	it("queues nothing when none of the paths exist", async () => {
		let queued = 0;
		const service = createOsRequestService({ kindOf: async () => null, onQueued: () => (queued += 1) });
		await service.push({ action: "open", paths: ["/nowhere"] });
		expect(queued).toBe(0);
		expect(service.take()).toEqual([]);
	});
});

describe("os request channel", () => {
	async function listening(received: OsLaunchRequest[]): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "os-ch-"));
		const endpoint = osRequestEndpoint(dir);
		const listener = await listenForOsRequests(endpoint, (request) => received.push(request));
		expect(listener).not.toBeNull();
		cleanups.push(async () => {
			await listener?.close();
			await rm(dir, { recursive: true, force: true });
		});
		return endpoint;
	}

	it("delivers a request to the listening app and gets the acknowledgement", async () => {
		const received: OsLaunchRequest[] = [];
		const endpoint = await listening(received);
		const request: OsLaunchRequest = { action: "ask", paths: ["/a/한글 파일.pdf"] };
		expect(await sendOsRequest(endpoint, request)).toBe(true);
		expect(received).toEqual([request]);
	});

	it("reports false when nobody listens, so the caller starts the app itself", async () => {
		const dir = await mkdtemp(join(tmpdir(), "os-ch-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		expect(await sendOsRequest(osRequestEndpoint(dir), { action: "ask", paths: ["/a"] })).toBe(false);
	});

	it("does not take over an endpoint another app already serves, and still serves the first", async () => {
		const received: OsLaunchRequest[] = [];
		const endpoint = await listening(received);
		expect(await listenForOsRequests(endpoint, () => undefined)).toBeNull();
		expect(await sendOsRequest(endpoint, { action: "reveal", paths: ["/a"] })).toBe(true);
		expect(received).toHaveLength(1);
	});

	it("ignores a malformed payload without acknowledging it", async () => {
		const received: OsLaunchRequest[] = [];
		const endpoint = await listening(received);
		const { promise, resolve } = Promise.withResolvers<string>();
		let reply = "";
		const socket = connect(endpoint);
		socket.on("connect", () => socket.end('{"action":"rm","paths":["/"]}'));
		socket.on("data", (chunk) => {
			reply += chunk.toString("utf8");
		});
		socket.on("close", () => resolve(reply));
		expect(await promise).toBe("");
		expect(received).toEqual([]);
	});

	it("keeps endpoints for different profiles apart and short enough for a unix socket", () => {
		const a = osRequestEndpoint("/Users/x/Library/Application Support/AutoRAG", "darwin");
		const b = osRequestEndpoint("/tmp/other-profile", "darwin");
		expect(a).not.toBe(b);
		expect(a.length).toBeLessThan(100);
		expect(osRequestEndpoint("C:\\Users\\x\\AppData\\Roaming\\AutoRAG", "win32")).toMatch(/^\\\\\.\\pipe\\autorag-os-[0-9a-f]{16}$/u);
	});
});
