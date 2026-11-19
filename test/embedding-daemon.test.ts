import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
	configureEmbeddingDaemon,
	createEmbeddingDaemon,
	DEFAULT_LOCAL_EMBEDDING_MODEL,
	ensureEmbeddingForConfig,
	followConfig,
	localEmbeddingModel,
	localEmbeddingServer,
	localModelMissing,
	stopEmbeddingDaemon,
} from "../src/main/embedding-daemon";
import { inlModelCacheRoot, inlServeStateRoot } from "../src/main/inl-paths";

describe("localEmbeddingModel", () => {
	it("is the default Qwen3 model when nothing is configured", () => {
		expect(localEmbeddingModel({})).toBe(DEFAULT_LOCAL_EMBEDDING_MODEL);
	});

	it("follows a native id and ignores the retired profile field", () => {
		expect(localEmbeddingModel({ minSync: { embedder: { id: "native:Org/Other-Model", dimension: 8 } } })).toBe("Org/Other-Model");
		expect(localEmbeddingModel({ minSync: { embedder: { profile: "qwen3-embedding-0.6b", dimension: 1024 } } })).toBe(DEFAULT_LOCAL_EMBEDDING_MODEL);
	});

	it("is null for any endpoint, remote or loopback, because that server is not ours to run", () => {
		expect(localEmbeddingModel({ minSync: { embedder: { id: "openai:text-embedding-3-small" } } })).toBeNull();
		expect(localEmbeddingModel({ minSync: { embedder: { id: "nomic-embed-text", baseUrl: "http://127.0.0.1:11434" } } })).toBeNull();
		expect(localEmbeddingModel({ minSync: { embedder: { id: "tei:bge", baseUrl: "http://10.0.0.5:8080" } } })).toBeNull();
	});

	it("is null in keyword-only mode", () => {
		expect(localEmbeddingModel({ appIndexing: { semanticSearch: false } })).toBeNull();
	});
});

const FAKE_DAEMON = `#!/usr/bin/env node
// A stand-in for \`inl serve\` / \`minsync serve\`: publishes the same state files and answers GET /health.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
if (args[0] !== "serve") process.exit(64);
if (process.env.FAKE_DAEMON_FAIL) { console.error("model files are missing"); process.exit(3); }
fs.appendFileSync(process.env.FAKE_DAEMON_LOG, JSON.stringify(args) + "\\n");
const model = flag("--model") ?? (flag("--embedder") ?? "native:Qwen/Qwen3-Embedding-0.6B").slice("native:".length);
const kind = process.env.FAKE_DAEMON_KIND ?? "dense";
const dimension = Number(process.env.FAKE_DAEMON_DIMENSION ?? 1024);
const instance = model.replace("/", "-") + "-" + kind + "-test";
const dir = path.join(process.env.HOME, ".cache", "im-not-llm", "serve", instance);
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok", kind, model_id: model, dimension, instance, pid: process.pid }));
  } else { res.statusCode = 404; res.end(); }
});
const cleanup = () => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); };
process.on("SIGTERM", cleanup);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "host"), "127.0.0.1");
fs.writeFileSync(path.join(dir, "pid"), String(process.pid));
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(path.join(dir, "port"), String(server.address().port));
});
`;

/** The directory holding a `node` the fake's `#!/usr/bin/env node` shebang can resolve, so PATH needs no other dir. */
const NODE_DIR = ((): string => {
	for (const entry of (process.env.PATH ?? "").split(delimiter)) {
		if (entry.length > 0 && existsSync(join(entry, "node"))) return entry;
	}
	return process.execPath.slice(0, process.execPath.lastIndexOf("/"));
})();

interface Fixture {
	readonly home: string;
	readonly ownerFile: string;
	readonly log: string;
	readonly bin: string;
	readonly env: NodeJS.ProcessEnv;
}

const directories: string[] = [];
const spawned: number[] = [];

afterEach(async () => {
	for (const pid of spawned.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createFixture(options: { inl?: boolean } = {}): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "autorag-daemon-"));
	directories.push(root);
	const bin = join(root, "bin");
	await mkdir(bin);
	for (const name of options.inl === true ? ["minsync", "inl"] : ["minsync"]) {
		const binary = join(bin, name);
		await writeFile(binary, FAKE_DAEMON);
		await chmod(binary, 0o755);
	}
	const home = join(root, "home");
	await mkdir(home);
	const log = join(root, "starts.log");
	await writeFile(log, "");
	return {
		home,
		bin,
		ownerFile: join(root, "embedding-daemon.json"),
		log,
		env: { PATH: [bin, NODE_DIR].join(delimiter), HOME: home, FAKE_DAEMON_LOG: log },
	};
}

async function starts(fixture: Fixture): Promise<string[][]> {
	return (await readFile(fixture.log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

function build(fixture: Fixture, extra: { ownerFile?: boolean; readyTimeoutMs?: number } = {}) {
	return createEmbeddingDaemon({
		env: fixture.env,
		home: fixture.home,
		...(extra.ownerFile === false ? {} : { ownerFile: fixture.ownerFile }),
		readyTimeoutMs: extra.readyTimeoutMs ?? 15_000,
	});
}

/** A loopback server answering any path with the same `/health` body, as `inl serve` would. */
async function serveHealth(health: Record<string, unknown>): Promise<{ readonly port: number; close: () => Promise<void> }> {
	const server = createServer((_request, response) => {
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify(health));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** The state files a running daemon publishes for a probe to find, under the shared inl serve root. */
function publishState(home: string, instance: string, port: number): void {
	const directory = join(home, ".cache", "im-not-llm", "serve", instance);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "host"), "127.0.0.1");
	writeFileSync(join(directory, "port"), String(port));
}

describe.skipIf(process.platform === "win32")("createEmbeddingDaemon", () => {
	it("starts `minsync serve` for the model, waits until it answers, and stops it on request", async () => {
		const fixture = await createFixture();
		const daemon = build(fixture);

		const result = await daemon.ensure(DEFAULT_LOCAL_EMBEDDING_MODEL);

		expect(result).toMatchObject({ state: "running", started: true, dimension: 1024 });
		if (result.state === "running") spawned.push(result.pid);
		expect(await starts(fixture)).toEqual([["serve", "--format", "json", "--quiet", "--idle-timeout", "0", "--embedder", `native:${DEFAULT_LOCAL_EMBEDDING_MODEL}`]]);
		const root = inlServeStateRoot({ home: fixture.home, platform: process.platform, env: fixture.env });
		expect(existsSync(root)).toBe(true);

		await daemon.stop();

		expect(existsSync(join(root, "Qwen-Qwen3-Embedding-0.6B-dense-test"))).toBe(false);
		expect(await daemon.ensure(DEFAULT_LOCAL_EMBEDDING_MODEL)).toMatchObject({ state: "running", started: true });
		await daemon.stop();
	});

	it("adopts a daemon that is already serving and never stops what it did not start", async () => {
		const fixture = await createFixture();
		const first = build(fixture, { ownerFile: false });
		const started = await first.ensure(DEFAULT_LOCAL_EMBEDDING_MODEL);
		if (started.state === "running") spawned.push(started.pid);
		const second = build(fixture, { ownerFile: false });

		const adopted = await second.ensure(DEFAULT_LOCAL_EMBEDDING_MODEL);
		await second.stop();

		expect(adopted).toMatchObject({ state: "running", started: false });
		expect(await starts(fixture)).toHaveLength(1);
		expect(await build(fixture, { ownerFile: false }).ensure(DEFAULT_LOCAL_EMBEDDING_MODEL)).toMatchObject({ state: "running", started: false });
		await first.stop();
	});

	it("starts one server for concurrent callers", async () => {
		const fixture = await createFixture();
		const daemon = build(fixture);

		const results = await Promise.all([daemon.ensure(DEFAULT_LOCAL_EMBEDDING_MODEL), daemon.ensure(DEFAULT_LOCAL_EMBEDDING_MODEL), daemon.ensure(DEFAULT_LOCAL_EMBEDDING_MODEL)]);

		expect(await starts(fixture)).toHaveLength(1);
		expect(results.every((result) => result.state === "running")).toBe(true);
		await daemon.stop();
	});

	it("takes back its own server after the app crashed, but not a server somebody else runs", async () => {
		const fixture = await createFixture();
		const crashed = build(fixture);
		const started = await crashed.ensure(DEFAULT_LOCAL_EMBEDDING_MODEL);
		if (started.state === "running") spawned.push(started.pid);
		const root = inlServeStateRoot({ home: fixture.home, platform: process.platform, env: fixture.env });

		// The next launch has no memory of the child, only the owner file the crashed run left.
		const next = build(fixture);
		expect(await next.ensure(DEFAULT_LOCAL_EMBEDDING_MODEL)).toMatchObject({ state: "running", started: false });
		await next.stop();
		expect(existsSync(join(root, "Qwen-Qwen3-Embedding-0.6B-dense-test"))).toBe(false);

		const foreign = build(fixture, { ownerFile: false });
		const theirs = await foreign.ensure(DEFAULT_LOCAL_EMBEDDING_MODEL);
		if (theirs.state === "running") spawned.push(theirs.pid);
		const bystander = build(fixture);
		await bystander.ensure(DEFAULT_LOCAL_EMBEDDING_MODEL);
		await bystander.stop();
		expect(await build(fixture, { ownerFile: false }).ensure(DEFAULT_LOCAL_EMBEDDING_MODEL)).toMatchObject({ state: "running", started: false });
		await foreign.stop();
	});

	it("reports a server that exits before it is ready, with what it printed, and does not throw", async () => {
		const fixture = await createFixture();
		const daemon = build(fixture);
		fixture.env.FAKE_DAEMON_FAIL = "1";

		const result = await daemon.ensure(DEFAULT_LOCAL_EMBEDDING_MODEL);

		expect(result).toMatchObject({ state: "unavailable" });
		expect(result.state === "unavailable" ? result.reason : "").toContain("model files are missing");
		delete fixture.env.FAKE_DAEMON_FAIL;
		expect(await daemon.ensure(DEFAULT_LOCAL_EMBEDDING_MODEL)).toMatchObject({ state: "running", started: true });
		await daemon.stop();
	});

	it("reports a missing minsync binary instead of throwing", async () => {
		const fixture = await createFixture();
		const daemon = createEmbeddingDaemon({ env: { PATH: join(fixture.home, "empty"), HOME: fixture.home }, home: fixture.home });

		const result = await daemon.ensure(DEFAULT_LOCAL_EMBEDDING_MODEL);

		expect(result).toMatchObject({ state: "unavailable" });
	});

	it("gives up when the server never answers and leaves no process behind", async () => {
		const fixture = await createFixture();
		const silent = join(fixture.home, "..", "bin", "minsync");
		await writeFile(silent, "#!/usr/bin/env node\nprocess.on('SIGTERM',()=>process.exit(0));require('node:net').createServer().listen(0);\n");
		const daemon = build(fixture, { readyTimeoutMs: 600 });

		const result = await daemon.ensure(DEFAULT_LOCAL_EMBEDDING_MODEL);

		expect(result.state).toBe("unavailable");
		expect(result.state === "unavailable" ? result.reason : "").toMatch(/not ready/);
	});

	it("stop with nothing running is a no-op", async () => {
		const fixture = await createFixture();
		await expect(build(fixture).stop()).resolves.toBeUndefined();
	});
});

describe.skipIf(process.platform === "win32")("the shared inl daemon", () => {
	it("prefers `inl serve` when an inl executable is on PATH", async () => {
		const fixture = await createFixture({ inl: true });
		const daemon = build(fixture);

		const result = await daemon.ensure(DEFAULT_LOCAL_EMBEDDING_MODEL);

		expect(result).toMatchObject({ state: "running", started: true, dimension: 1024 });
		if (result.state === "running") spawned.push(result.pid);
		expect(await starts(fixture)).toEqual([["serve", "--idle-timeout", "0", "--model", DEFAULT_LOCAL_EMBEDDING_MODEL]]);
		await daemon.stop();
	});

	it("falls back to the bundled `minsync serve` when no inl executable is on PATH", async () => {
		const fixture = await createFixture();
		const daemon = build(fixture);

		const result = await daemon.ensure(DEFAULT_LOCAL_EMBEDDING_MODEL);

		expect(result).toMatchObject({ state: "running", started: true });
		if (result.state === "running") spawned.push(result.pid);
		expect(await starts(fixture)).toEqual([["serve", "--format", "json", "--quiet", "--idle-timeout", "0", "--embedder", `native:${DEFAULT_LOCAL_EMBEDDING_MODEL}`]]);
		await daemon.stop();
	});

	it("adopts a daemon it did not start, matching on health rather than the instance name, and leaves it running", async () => {
		const fixture = await createFixture();
		const dense = await serveHealth({ status: "ok", kind: "dense", model_id: DEFAULT_LOCAL_EMBEDDING_MODEL, dimension: 1024, pid: process.pid });
		publishState(fixture.home, "a-name-that-encodes-nothing-a-consumer-knows", dense.port);

		const adopted = await createEmbeddingDaemon({ env: fixture.env, home: fixture.home }).ensure(DEFAULT_LOCAL_EMBEDDING_MODEL);
		await createEmbeddingDaemon({ env: fixture.env, home: fixture.home }).stop();

		expect(adopted).toMatchObject({ state: "running", started: false, dimension: 1024 });
		await dense.close();
	});

	it("never matches a daemon of another kind or model, but takes a health body without a kind as dense", async () => {
		const probeOnly = async (health: Record<string, unknown>) => {
			const fixture = await createFixture();
			const server = await serveHealth(health);
			publishState(fixture.home, "instance-does-not-matter", server.port);
			const state = await createEmbeddingDaemon({ env: fixture.env, home: fixture.home, modelPresent: () => false }).ensure(DEFAULT_LOCAL_EMBEDDING_MODEL);
			await server.close();
			return state;
		};

		expect(await probeOnly({ status: "ok", kind: "sparse", model_id: DEFAULT_LOCAL_EMBEDDING_MODEL, dimension: 8, pid: process.pid })).toMatchObject({ state: "unavailable" });
		expect(await probeOnly({ status: "ok", kind: "multimodal", model_id: DEFAULT_LOCAL_EMBEDDING_MODEL, dimension: 768, pid: process.pid })).toMatchObject({ state: "unavailable" });
		expect(await probeOnly({ status: "ok", kind: "late", model_id: DEFAULT_LOCAL_EMBEDDING_MODEL, dimension: 128, pid: process.pid })).toMatchObject({ state: "unavailable" });
		expect(await probeOnly({ status: "ok", kind: "dense", model_id: "Org/Other-Model", dimension: 1024, pid: process.pid })).toMatchObject({ state: "unavailable" });
		expect(await probeOnly({ status: "ok", model_id: DEFAULT_LOCAL_EMBEDDING_MODEL, dimension: 1024, pid: process.pid })).toMatchObject({ state: "running", started: false, dimension: 1024 });
	});
});

describe.skipIf(process.platform === "win32")("followConfig", () => {
	it("starts the server the config wants and stops the one it started when the config no longer wants a local model", async () => {
		const fixture = await createFixture();
		const daemon = build(fixture);

		const started = await followConfig(daemon, {});
		if (started?.state === "running") spawned.push(started.pid);
		expect(started).toMatchObject({ state: "running", started: true });

		expect(await followConfig(daemon, { minSync: { embedder: { id: "openai:text-embedding-3-small" } } })).toBeUndefined();
		// The first server is gone: a fresh daemon has to start its own, and this one stops it.
		const fresh = build(fixture);
		expect(await fresh.ensure(DEFAULT_LOCAL_EMBEDDING_MODEL)).toMatchObject({ state: "running", started: true });
		await fresh.stop();
	});

	it("does not start anything for keyword-only search", async () => {
		const fixture = await createFixture();

		expect(await followConfig(build(fixture), { appIndexing: { semanticSearch: false } })).toBeUndefined();
		expect(await starts(fixture)).toEqual([]);
	});
});

describe.skipIf(process.platform === "win32")("the process-wide hook", () => {
	it("manages nothing until configured, then starts on demand and stops on quit", async () => {
		const fixture = await createFixture();
		await ensureEmbeddingForConfig({});
		expect(await starts(fixture)).toEqual([]);

		configureEmbeddingDaemon({ env: fixture.env, home: fixture.home, ownerFile: fixture.ownerFile, readyTimeoutMs: 15_000 });
		await ensureEmbeddingForConfig({});
		await ensureEmbeddingForConfig({});
		expect(await starts(fixture)).toHaveLength(1);

		await stopEmbeddingDaemon();
		const root = inlServeStateRoot({ home: fixture.home, platform: process.platform, env: fixture.env });
		expect(existsSync(join(root, "Qwen-Qwen3-Embedding-0.6B-dense-test"))).toBe(false);
	});

	it("never starts the server while the model is not downloaded, so minsync does not fetch 1.2 GB by itself", async () => {
		const fixture = await createFixture();
		let present = false;
		const daemon = createEmbeddingDaemon({ env: fixture.env, home: fixture.home, ownerFile: fixture.ownerFile, readyTimeoutMs: 15_000, modelPresent: () => present });

		const blocked = await daemon.ensure(DEFAULT_LOCAL_EMBEDDING_MODEL);
		expect(blocked).toMatchObject({ state: "unavailable" });
		expect(await starts(fixture)).toEqual([]);

		present = true;
		const started = await daemon.ensure(DEFAULT_LOCAL_EMBEDDING_MODEL);
		if (started.state === "running") spawned.push(started.pid);
		expect(started).toMatchObject({ state: "running", started: true });
		expect(await starts(fixture)).toHaveLength(1);
		await daemon.stop();
	});

	it("still answers with a server that is already running when the model check says missing", async () => {
		const fixture = await createFixture();
		const first = await build(fixture).ensure(DEFAULT_LOCAL_EMBEDDING_MODEL);
		if (first.state === "running") spawned.push(first.pid);

		const gated = createEmbeddingDaemon({ env: fixture.env, home: fixture.home, readyTimeoutMs: 15_000, modelPresent: () => false });

		expect(await gated.ensure(DEFAULT_LOCAL_EMBEDDING_MODEL)).toMatchObject({ state: "running", started: false });
	});

	it("reports a missing download only when this process manages the server and the config wants the local model", async () => {
		const fixture = await createFixture();
		expect(localModelMissing({})).toBe(false);

		configureEmbeddingDaemon({ env: fixture.env, home: fixture.home, modelPresent: () => false });
		expect(localModelMissing({})).toBe(true);
		expect(localModelMissing({ appIndexing: { semanticSearch: false } })).toBe(false);
		expect(localModelMissing({ minSync: { embedder: { id: "openai:text-embedding-3-small" } } })).toBe(false);

		configureEmbeddingDaemon({ env: fixture.env, home: fixture.home, modelPresent: () => true });
		expect(localModelMissing({})).toBe(false);
	});

	it("does not throw when the server cannot start", async () => {
		const fixture = await createFixture();
		fixture.env.FAKE_DAEMON_FAIL = "1";
		configureEmbeddingDaemon({ env: fixture.env, home: fixture.home, readyTimeoutMs: 5_000 });

		await expect(ensureEmbeddingForConfig({})).resolves.toBeUndefined();
	});
});

describe.skipIf(process.platform === "win32")("localEmbeddingServer", () => {
	it("answers unavailable in a process that manages nothing, and starts the server once it does", async () => {
		const fixture = await createFixture();
		configureEmbeddingDaemon({ env: fixture.env, home: fixture.home, ownerFile: fixture.ownerFile, readyTimeoutMs: 15_000 });
		await stopEmbeddingDaemon();

		const started = await localEmbeddingServer(DEFAULT_LOCAL_EMBEDDING_MODEL);

		expect(started).toMatchObject({ state: "running", dimension: 1024 });
		await stopEmbeddingDaemon();
	});
});
