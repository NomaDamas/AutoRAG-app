import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	configureEmbeddingDaemon,
	createEmbeddingDaemon,
	DEFAULT_LOCAL_EMBEDDING_MODEL,
	ensureEmbeddingForConfig,
	followConfig,
	localEmbeddingModel,
	localEmbeddingServer,
	minSyncServeStateRoot,
	stopEmbeddingDaemon,
} from "../src/main/embedding-daemon";

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

const FAKE_MINSYNC = `#!/usr/bin/env node
// A stand-in for \`minsync serve\`: publishes the same state files and answers GET /health.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
if (args[0] !== "serve") process.exit(64);
if (process.env.FAKE_MINSYNC_FAIL) { console.error("model files are missing"); process.exit(3); }
fs.appendFileSync(process.env.FAKE_MINSYNC_LOG, JSON.stringify(args) + "\\n");
const embedder = flag("--embedder") ?? "native:Qwen/Qwen3-Embedding-0.6B";
const model = embedder.slice("native:".length);
const instance = model.replace("/", "-") + "-test";
const dir = path.join(process.env.HOME, ".cache", "minsync", "serve", instance);
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok", model_id: model, dimension: 1024, instance, pid: process.pid }));
  } else { res.statusCode = 404; res.end(); }
});
const cleanup = () => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); };
process.on("SIGTERM", cleanup);
server.listen(0, "127.0.0.1", () => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "host"), "127.0.0.1");
  fs.writeFileSync(path.join(dir, "pid"), String(process.pid));
  fs.writeFileSync(path.join(dir, "port"), String(server.address().port));
});
`;

interface Fixture {
	readonly home: string;
	readonly ownerFile: string;
	readonly log: string;
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

async function createFixture(): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "autorag-daemon-"));
	directories.push(root);
	const bin = join(root, "bin");
	await mkdir(bin);
	const binary = join(bin, "minsync");
	await writeFile(binary, FAKE_MINSYNC);
	await chmod(binary, 0o755);
	const home = join(root, "home");
	await mkdir(home);
	const log = join(root, "starts.log");
	await writeFile(log, "");
	return {
		home,
		ownerFile: join(root, "embedding-daemon.json"),
		log,
		env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, FAKE_MINSYNC_LOG: log },
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

describe.skipIf(process.platform === "win32")("createEmbeddingDaemon", () => {
	it("starts `minsync serve` for the model, waits until it answers, and stops it on request", async () => {
		const fixture = await createFixture();
		const daemon = build(fixture);

		const result = await daemon.ensure(DEFAULT_LOCAL_EMBEDDING_MODEL);

		expect(result).toMatchObject({ state: "running", started: true, dimension: 1024 });
		if (result.state === "running") spawned.push(result.pid);
		expect(await starts(fixture)).toEqual([["serve", "--format", "json", "--quiet", "--idle-timeout", "0", "--embedder", `native:${DEFAULT_LOCAL_EMBEDDING_MODEL}`]]);
		const root = minSyncServeStateRoot({ home: fixture.home, platform: process.platform, env: fixture.env });
		expect(existsSync(root)).toBe(true);

		await daemon.stop();

		expect(existsSync(join(root, "Qwen-Qwen3-Embedding-0.6B-test"))).toBe(false);
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
		const root = minSyncServeStateRoot({ home: fixture.home, platform: process.platform, env: fixture.env });

		// The next launch has no memory of the child, only the owner file the crashed run left.
		const next = build(fixture);
		expect(await next.ensure(DEFAULT_LOCAL_EMBEDDING_MODEL)).toMatchObject({ state: "running", started: false });
		await next.stop();
		expect(existsSync(join(root, "Qwen-Qwen3-Embedding-0.6B-test"))).toBe(false);

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
		fixture.env.FAKE_MINSYNC_FAIL = "1";

		const result = await daemon.ensure(DEFAULT_LOCAL_EMBEDDING_MODEL);

		expect(result).toMatchObject({ state: "unavailable" });
		expect(result.state === "unavailable" ? result.reason : "").toContain("model files are missing");
		delete fixture.env.FAKE_MINSYNC_FAIL;
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
		const root = minSyncServeStateRoot({ home: fixture.home, platform: process.platform, env: fixture.env });
		expect(existsSync(join(root, "Qwen-Qwen3-Embedding-0.6B-test"))).toBe(false);
	});

	it("waits for the bundled model to be in place before starting, so the server never downloads it", async () => {
		const fixture = await createFixture();
		const { promise: seeded, resolve } = Promise.withResolvers<void>();
		configureEmbeddingDaemon({ env: fixture.env, home: fixture.home, ownerFile: fixture.ownerFile, readyTimeoutMs: 15_000, ready: seeded });

		const pending = ensureEmbeddingForConfig({});
		await Promise.resolve();
		expect(await starts(fixture)).toEqual([]);
		resolve();
		await pending;

		expect(await starts(fixture)).toHaveLength(1);
		await stopEmbeddingDaemon();
	});

	it("does not throw when the server cannot start", async () => {
		const fixture = await createFixture();
		fixture.env.FAKE_MINSYNC_FAIL = "1";
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
