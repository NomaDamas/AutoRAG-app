import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import toolPins from "../src/shared/tool-pins.json";
import { createToolVersionsService, findBinaryOnPath, findManifestDrift } from "../src/main/tool-versions";
import type { EmbeddingDaemonRestartResult, EmbeddingDaemonStatus } from "../src/main/embedding-daemon";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

describe("findManifestDrift", () => {
	it("returns empty when tools/manifest.json matches src/shared/tool-pins.json", () => {
		const tools = [
			{ name: "node", version: toolPins.node.version },
			{ name: "autorag", version: toolPins.librarian.version },
			...Object.entries(toolPins.tools).map(([name, entry]) => ({ name, version: entry.version })),
		];
		expect(findManifestDrift({ schema: 1, platform: "darwin-arm64", tools }, "darwin-arm64")).toEqual([]);
	});

	it("reports every tool whose bundled version disagrees with tool-pins.json", () => {
		const tools = [
			{ name: "node", version: toolPins.node.version },
			{ name: "autorag", version: toolPins.librarian.version },
			...Object.entries(toolPins.tools).map(([name, entry]) => ({
				name,
				version: name === "minsync" ? "0.7.3" : entry.version,
			})),
		];
		expect(findManifestDrift({ schema: 1, platform: "darwin-arm64", tools }, "darwin-arm64")).toEqual([
			{ name: "minsync", pinned: toolPins.tools.minsync.version, manifest: "0.7.3" },
		]);
	});
});

describe("findBinaryOnPath", () => {
	it("skips the bundled tools/bin directory so only user-installed PATH copies are reported", async () => {
		const root = await makeTempDir("autorag-path-");
		const bundledBin = join(root, "tools", "bin");
		const userBin = join(root, "user-bin");
		await mkdir(bundledBin, { recursive: true });
		await mkdir(userBin, { recursive: true });
		await writeFile(join(bundledBin, "minsync"), "#!/bin/sh\necho minsync 0.7.6\n");
		await chmod(join(bundledBin, "minsync"), 0o755);

		const envOnlyBundled = { PATH: bundledBin };
		expect(findBinaryOnPath("minsync", envOnlyBundled, bundledBin, "darwin")).toBeNull();

		await writeFile(join(userBin, "minsync"), "#!/bin/sh\necho minsync 0.7.3\n");
		await chmod(join(userBin, "minsync"), 0o755);
		const envBoth = { PATH: `${bundledBin}:${userBin}` };
		expect(findBinaryOnPath("minsync", envBoth, bundledBin, "darwin")).toBe(join(userBin, "minsync"));
	});
});

describe("createToolVersionsService", () => {
	it("reports resolved versions, flags PATH mismatches, and offers restart only for an app-owned outdated daemon", async () => {
		const root = await makeTempDir("autorag-tv-");
		const toolsDir = join(root, "tools");
		await mkdir(join(toolsDir, "bin"), { recursive: true });
		await writeFile(
			join(toolsDir, "manifest.json"),
			JSON.stringify({
				schema: 1,
				platform: "darwin-arm64",
				daemon: toolPins.daemon,
				tools: [
					{ name: "node", version: toolPins.node.version },
					{ name: "autorag", version: toolPins.librarian.version },
					...Object.entries(toolPins.tools).map(([name, entry]) => ({ name, version: entry.version })),
				],
			}),
		);

		let currentDaemon: EmbeddingDaemonStatus = {
			state: "running",
			baseUrl: "http://127.0.0.1:54133",
			port: 54133,
			dimension: 1024,
			pid: 4242,
			version: "0.3.1",
			instance: "Qwen-Qwen3-Embedding-0.6B-test",
			owned: true,
		};

		const restartMock = vi.fn(async (): Promise<EmbeddingDaemonRestartResult> => {
			currentDaemon = {
				state: "running",
				baseUrl: "http://127.0.0.1:54133",
				port: 54133,
				dimension: 1024,
				pid: 5555,
				version: toolPins.daemon.engineVersion,
				instance: "Qwen-Qwen3-Embedding-0.6B-test",
				owned: true,
			};
			return {
				ok: true,
				state: { ...currentDaemon, started: true },
			};
		});

		const service = createToolVersionsService({
			appVersion: "1.2.3",
			librarianVersion: toolPins.librarian.version,
			resourcesPath: root,
			env: {},
			platform: "darwin",
			arch: "arm64",
			daemonStatus: async () => currentDaemon,
			restartDaemon: restartMock,
			probeExternal: async (binary) => {
				if (binary === "minsync") return { pathLocation: "/usr/local/bin/minsync", pathVersion: "0.7.3" };
				if (binary === "inl") return { pathLocation: "/usr/local/bin/inl", pathVersion: toolPins.daemon.engineVersion };
				return { pathLocation: null, pathVersion: null };
			},
		});

		const before = await service.get();
		expect(before.manifestPresent).toBe(true);
		expect(before.manifestDrift).toEqual([]);
		expect(before.daemon.outdated).toBe(true);
		expect(before.daemon.canRestart).toBe(true);
		expect(before.components.map((c) => c.id)).toEqual(["app", "librarian", "minsync", "inl", "mailcrawl", "lazykatok"]);

		const minsyncRow = before.components.find((c) => c.id === "minsync");
		expect(minsyncRow?.pathMismatch).toBe(true);
		expect(minsyncRow?.pathVersion).toBe("0.7.3");

		const inlRow = before.components.find((c) => c.id === "inl");
		expect(inlRow?.pathMismatch).toBe(false);

		const restarted = await service.restartDaemon();
		expect(restartMock).toHaveBeenCalledOnce();
		expect(restarted.ok).toBe(true);
		expect(restarted.snapshot.daemon.outdated).toBe(false);
		expect(restarted.snapshot.daemon.version).toBe(toolPins.daemon.engineVersion);
		expect(restarted.snapshot.daemon.port).toBe(54133);
	});

	it("marks canRestart false when an outdated daemon was started outside Dazzi", async () => {
		const service = createToolVersionsService({
			appVersion: "1.2.3",
			librarianVersion: toolPins.librarian.version,
			resourcesPath: "/nonexistent",
			env: {},
			platform: "darwin",
			arch: "arm64",
			daemonStatus: async () => ({
				state: "running",
				baseUrl: "http://127.0.0.1:54133",
				port: 54133,
				dimension: 1024,
				pid: 9999,
				version: "0.3.1",
				instance: "Qwen-Qwen3-Embedding-0.6B-test",
				owned: false,
			}),
			restartDaemon: async () => ({ ok: false, reason: "not-owned", message: "started outside Dazzi" }),
			probeExternal: async () => ({ pathLocation: null, pathVersion: null }),
		});

		const snap = await service.get();
		expect(snap.daemon.outdated).toBe(true);
		expect(snap.daemon.owned).toBe(false);
		expect(snap.daemon.canRestart).toBe(false);

		const res = await service.restartDaemon();
		expect(res.ok).toBe(false);
		expect(res.reason).toBe("not-owned");
	});
});
