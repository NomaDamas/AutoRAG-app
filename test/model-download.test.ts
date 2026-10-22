import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createModelDownloadService,
	minSyncModelCacheRoot,
	modelFilesPresent,
	type ModelSpec,
} from "../src/main/model-download";
import type { ModelDownloadStatus } from "../src/shared/model-download-contract";

const sha = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex");

const CONTENTS: Record<string, Buffer> = {
	"config.json": Buffer.from('{"hidden_size":1024}'),
	"tokenizer.json": Buffer.from("t".repeat(5_000)),
	"model.safetensors": Buffer.from(Array.from({ length: 200_000 }, (_, index) => (index * 31 + 7) % 251)),
};

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "autorag-model-download-"));
	dirs.push(dir);
	return dir;
}

interface Hub {
	spec: ModelSpec;
	readonly requests: { readonly path: string; readonly range: string | undefined }[];
	/** Serve this body instead of the real one for a file. */
	readonly override: Record<string, Buffer>;
	/** When set, the safetensors answer stops halfway and waits for the client to leave. */
	stallSafetensors: boolean;
	/** When set, Range is ignored and the whole file answers 200. */
	ignoreRange: boolean;
}

async function startHub(): Promise<Hub> {
	const hub: Hub = {
		spec: { repoDir: "", revision: "", baseUrl: "", files: [] },
		requests: [],
		override: {},
		stallSafetensors: false,
		ignoreRange: false,
	};
	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const name = (request.url ?? "").slice(1);
		const range = request.headers.range;
		hub.requests.push({ path: name, range });
		const body = hub.override[name] ?? CONTENTS[name];
		if (body === undefined) {
			response.statusCode = 404;
			response.end();
			return;
		}
		let start = 0;
		const match = !hub.ignoreRange && range !== undefined ? /^bytes=(\d+)-$/.exec(range) : null;
		if (match !== null) start = Number(match[1]);
		if (start > 0) {
			if (start >= body.length) {
				response.statusCode = 416;
				response.end();
				return;
			}
			response.statusCode = 206;
			response.setHeader("content-range", `bytes ${start}-${body.length - 1}/${body.length}`);
		}
		const slice = body.subarray(start);
		response.setHeader("content-length", slice.length);
		if (hub.stallSafetensors && name === "model.safetensors") {
			response.write(slice.subarray(0, Math.floor(slice.length / 2)));
			// Never finishes: the client has to cancel.
			return;
		}
		response.end(slice);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	hub.spec = {
		repoDir: "models--Test--Model",
		revision: "abc123",
		baseUrl: `http://127.0.0.1:${port}`,
		files: Object.entries(CONTENTS).map(([name, body]) => ({ name, sha256: sha(body), bytes: body.length })),
	};
	return hub;
}

const snapshot = (cacheRoot: string, spec: ModelSpec, name: string): string => join(cacheRoot, spec.repoDir, "snapshots", spec.revision, name);

const TOTAL = Object.values(CONTENTS).reduce((sum, body) => sum + body.length, 0);

describe("minSyncModelCacheRoot", () => {
	it("resolves MinSync's native model cache root on macOS and Windows", () => {
		expect(minSyncModelCacheRoot({ platform: "darwin", home: "/Users/me", env: {} })).toBe(join("/Users/me", ".cache", "minsync", "models"));
		expect(minSyncModelCacheRoot({ platform: "win32", home: "C:\\Users\\me", env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" } })).toBe(
			join("C:\\Users\\me\\AppData\\Local", "minsync", "models"),
		);
		expect(minSyncModelCacheRoot({ platform: "darwin", home: "/Users/me", env: { FASTEMBED_CACHE_DIR: "/custom/cache" } })).toBe("/custom/cache");
	});
});

describe("createModelDownloadService", () => {
	it("downloads every file into the Hugging Face cache layout, verified, with progress ending at the full size", async () => {
		const hub = await startHub();
		const cacheRoot = temp();
		const seen: ModelDownloadStatus[] = [];
		const service = createModelDownloadService({ cacheRoot, spec: hub.spec, onChange: (status) => seen.push(status) });

		expect(service.status()).toMatchObject({ state: "absent", bytesDone: 0, bytesTotal: TOTAL, error: null });
		await service.start();
		const done = await service.settled();

		expect(done).toMatchObject({ state: "ready", bytesDone: TOTAL, bytesTotal: TOTAL, error: null });
		for (const [name, body] of Object.entries(CONTENTS)) expect(readFileSync(snapshot(cacheRoot, hub.spec, name))).toEqual(body);
		expect(readFileSync(join(cacheRoot, hub.spec.repoDir, "refs", "main"), "utf8")).toBe("abc123");
		expect(modelFilesPresent(cacheRoot, hub.spec)).toBe(true);
		expect(seen.some((status) => status.state === "downloading")).toBe(true);
		const bytes = seen.map((status) => status.bytesDone);
		expect(bytes).toEqual([...bytes].sort((a, b) => a - b));
		expect(seen.at(-1)?.state).toBe("ready");
	});

	it("resumes a partial file with a Range request instead of starting over", async () => {
		const hub = await startHub();
		const cacheRoot = temp();
		const target = snapshot(cacheRoot, hub.spec, "model.safetensors");
		mkdirSync(join(target, ".."), { recursive: true });
		const full = CONTENTS["model.safetensors"] as Buffer;
		writeFileSync(`${target}.download`, full.subarray(0, 80_000));
		const service = createModelDownloadService({ cacheRoot, spec: hub.spec });

		await service.start();
		const done = await service.settled();

		expect(done.state).toBe("ready");
		expect(readFileSync(target)).toEqual(full);
		expect(hub.requests.find((request) => request.path === "model.safetensors")?.range).toBe("bytes=80000-");
		expect(existsSync(`${target}.download`)).toBe(false);
	});

	it("restarts the file when the server ignores Range and answers the whole body", async () => {
		const hub = await startHub();
		hub.ignoreRange = true;
		const cacheRoot = temp();
		const target = snapshot(cacheRoot, hub.spec, "model.safetensors");
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(`${target}.download`, (CONTENTS["model.safetensors"] as Buffer).subarray(0, 50_000));
		const service = createModelDownloadService({ cacheRoot, spec: hub.spec });

		await service.start();

		expect((await service.settled()).state).toBe("ready");
		expect(readFileSync(target)).toEqual(CONTENTS["model.safetensors"]);
	});

	it("rejects a file whose bytes do not match the pinned SHA-256 and keeps nothing in the cache", async () => {
		const hub = await startHub();
		const wrong = Buffer.from(CONTENTS["model.safetensors"] as Buffer);
		wrong[10] = (wrong[10] ?? 0) ^ 0xff;
		hub.override["model.safetensors"] = wrong;
		const cacheRoot = temp();
		const service = createModelDownloadService({ cacheRoot, spec: hub.spec });

		await service.start();
		const done = await service.settled();

		expect(done.state).toBe("failed");
		expect(done.error).toMatch(/model\.safetensors/);
		const target = snapshot(cacheRoot, hub.spec, "model.safetensors");
		expect(existsSync(target)).toBe(false);
		expect(existsSync(`${target}.download`)).toBe(false);
		expect(modelFilesPresent(cacheRoot, hub.spec)).toBe(false);
		expect(existsSync(join(cacheRoot, hub.spec.repoDir, "refs", "main"))).toBe(false);
	});

	it("reports an HTTP error and recovers on the next start", async () => {
		const hub = await startHub();
		const missing = { ...hub.spec, files: [...hub.spec.files, { name: "extra.bin", sha256: sha(Buffer.from("x")), bytes: 1 }] };
		const cacheRoot = temp();
		const service = createModelDownloadService({ cacheRoot, spec: missing });

		await service.start();
		const failed = await service.settled();
		expect(failed.state).toBe("failed");
		expect(failed.error).toMatch(/404/);

		hub.override["extra.bin"] = Buffer.from("x");
		await service.start();
		expect((await service.settled()).state).toBe("ready");
	});

	it("cancel stops a running download, returns to absent, and keeps the partial file for the next start", async () => {
		const hub = await startHub();
		hub.stallSafetensors = true;
		const cacheRoot = temp();
		const service = createModelDownloadService({ cacheRoot, spec: hub.spec });

		await service.start();
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline && !(service.status().file === "model.safetensors" && service.status().bytesDone > 5_000 + 20 + 1000)) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const cancelled = await service.cancel();
		await service.settled();

		expect(cancelled.state).toBe("absent");
		expect(service.status()).toMatchObject({ state: "absent", error: null });
		const part = `${snapshot(cacheRoot, hub.spec, "model.safetensors")}.download`;
		expect(statSync(part).size).toBeGreaterThan(0);

		hub.stallSafetensors = false;
		await service.start();
		expect((await service.settled()).state).toBe("ready");
		expect(readFileSync(snapshot(cacheRoot, hub.spec, "model.safetensors"))).toEqual(CONTENTS["model.safetensors"]);
	});

	it("joins a download already running instead of fetching twice", async () => {
		const hub = await startHub();
		const service = createModelDownloadService({ cacheRoot: temp(), spec: hub.spec });

		await Promise.all([service.start(), service.start()]);
		await service.settled();

		expect(hub.requests.filter((request) => request.path === "config.json")).toHaveLength(1);
	});

	it("does not touch the network when the model is already complete", async () => {
		const hub = await startHub();
		const cacheRoot = temp();
		const first = createModelDownloadService({ cacheRoot, spec: hub.spec });
		await first.start();
		await first.settled();
		hub.requests.length = 0;

		const second = createModelDownloadService({ cacheRoot, spec: hub.spec });
		expect(second.status().state).toBe("ready");
		await second.start();
		expect((await second.settled()).state).toBe("ready");
		expect(hub.requests).toEqual([]);
	});

	it("notices a model deleted from disk instead of reporting ready forever", async () => {
		const hub = await startHub();
		const cacheRoot = temp();
		const service = createModelDownloadService({ cacheRoot, spec: hub.spec });
		await service.start();
		await service.settled();
		expect(service.status().state).toBe("ready");

		rmSync(join(cacheRoot, hub.spec.repoDir), { recursive: true, force: true });

		expect(service.status()).toMatchObject({ state: "absent", bytesDone: 0 });
	});

	it("treats a file of the wrong size as missing and fetches it again", async () => {
		const hub = await startHub();
		const cacheRoot = temp();
		const first = createModelDownloadService({ cacheRoot, spec: hub.spec });
		await first.start();
		await first.settled();
		const target = snapshot(cacheRoot, hub.spec, "model.safetensors");
		writeFileSync(target, "truncated");
		expect(modelFilesPresent(cacheRoot, hub.spec)).toBe(false);

		const again = createModelDownloadService({ cacheRoot, spec: hub.spec });
		expect(again.status().state).toBe("absent");
		await again.start();
		expect((await again.settled()).state).toBe("ready");
		expect(readFileSync(target)).toEqual(CONTENTS["model.safetensors"]);
	});
});
