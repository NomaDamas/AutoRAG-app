import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoRAGAgent, buildAgentOptions, MinSyncClient, type CliConfig, type RetrievalMethod } from "@autorag/librarian";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyAppIndexing, readAppIndexing } from "../src/main/app-indexing";
import { createIndexingTierProbe, readCurrentIndexingTier } from "../src/main/hardware-probe";
import { neutralizeSemanticMethods, withSemanticPolicyApplied } from "../src/main/semantic-policy";
import { evaluateIndexingTier, type HardwareProfile } from "../src/shared/local-embedding-spec";

const GIB = 1024 ** 3;

function hw(overrides: Partial<HardwareProfile>): HardwareProfile {
	return {
		platform: "win32",
		arch: "x64",
		cpuModel: "Generic CPU",
		memoryBytes: 8 * GIB,
		cores: 4,
		gpus: [],
		...overrides,
	};
}

describe("AutoRAG-app hardware-aware indexing tiers and BM25 policy", () => {
	let workDir: string;
	const savedOverride = process.env.AUTORAG_HARDWARE_OVERRIDE;

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), "dazzi-bm25-tier-"));
		delete process.env.AUTORAG_HARDWARE_OVERRIDE;
	});

	afterEach(() => {
		if (savedOverride === undefined) delete process.env.AUTORAG_HARDWARE_OVERRIDE;
		else process.env.AUTORAG_HARDWARE_OVERRIDE = savedOverride;
		rmSync(workDir, { recursive: true, force: true });
	});

	it("assigns bm25-only / sparse+bm25 / full tiers from VM-calibrated hardware specs", () => {
		// 8 GB Mac or Windows -> bm25-only (never loads even 0.1B SPLADE)
		expect(evaluateIndexingTier(hw({ platform: "darwin", arch: "arm64", cpuModel: "Apple M2", memoryBytes: 8 * GIB, cores: 8 })).tier).toBe("bm25-only");
		expect(evaluateIndexingTier(hw({ memoryBytes: 8 * GIB, cores: 8 })).tier).toBe("bm25-only");
		// 16 GB 2-core CPU-only Windows -> bm25-only
		expect(evaluateIndexingTier(hw({ memoryBytes: 16 * GIB, cores: 2 })).tier).toBe("bm25-only");

		// 16 GB Apple Silicon or 16-32 GB CPU-only (4+ cores) -> sparse+bm25
		expect(evaluateIndexingTier(hw({ platform: "darwin", arch: "arm64", cpuModel: "Apple M3", memoryBytes: 16 * GIB, cores: 8 })).tier).toBe("sparse+bm25");
		expect(evaluateIndexingTier(hw({ memoryBytes: 16 * GIB, cores: 4 })).tier).toBe("sparse+bm25");
		expect(evaluateIndexingTier(hw({ memoryBytes: 32 * GIB, cores: 12 })).tier).toBe("sparse+bm25");

		// 24 GB+ Apple Silicon or 16 GB+ PC with >= 8 GB CUDA VRAM -> full
		expect(evaluateIndexingTier(hw({ platform: "darwin", arch: "arm64", cpuModel: "Apple M4", memoryBytes: 24 * GIB, cores: 8 })).tier).toBe("full");
		expect(evaluateIndexingTier(hw({ memoryBytes: 16 * GIB, cores: 8, gpus: [{ name: "RTX 4060", vramMiB: 8188 }] })).tier).toBe("full");
	});

	it("falls back safely to bm25-only when hardware probe throws", async () => {
		const probe = createIndexingTierProbe({
			env: {},
			allowOverride: false,
			readHardware: async () => {
				throw new Error("probe failed");
			},
		});
		const verdict = await probe();
		expect(verdict.tier).toBe("bm25-only");
		expect(verdict.sparseEnabled).toBe(false);
		expect(verdict.bm25Enabled).toBe(true);
	});

	it("applies bm25-only, sparse+bm25, and full tiers cleanly in withSemanticPolicyApplied", () => {
		const base: CliConfig = {
			searchPaths: [workDir],
			workspacePath: workDir,
			memoryPath: join(workDir, "memory.json"),
			minSync: { enabled: true, autoInstall: true, embedder: { id: "openai:qwen/qwen3-embedding-0.6b", apiKeyEnv: "OPENAI_API_KEY" } },
		};

		// 8 GB PC in keyword-only mode -> zero ML (embedder=none, sparse=none, bm25=on)
		const lowKeyword = withSemanticPolicyApplied(base, false, "bm25-only");
		expect(lowKeyword.minSync?.embedder).toEqual({ id: "none" });
		expect(lowKeyword.minSync?.sparse).toEqual({ id: "none" });
		expect(lowKeyword.minSync?.bm25).toEqual({ enabled: true, language: "multilingual" });

		// 8 GB PC using cloud dense embeddings -> keeps cloud embedder, skips local 0.1B SPLADE, keeps BM25
		const lowCloud = withSemanticPolicyApplied(base, true, "bm25-only");
		expect(lowCloud.minSync?.embedder?.id).toBe("openai:qwen/qwen3-embedding-0.6b");
		expect(lowCloud.minSync?.sparse).toEqual({ id: "none" });
		expect(lowCloud.minSync?.bm25).toEqual({ enabled: true, language: "multilingual" });

		// 16 GB PC in keyword-only mode -> SPLADE + BM25 (embedder=none, sparse active, bm25 active)
		const midKeyword = withSemanticPolicyApplied(base, false, "sparse+bm25");
		expect(midKeyword.minSync?.embedder).toEqual({ id: "none" });
		expect(midKeyword.minSync?.sparse).toBeUndefined();
		expect(midKeyword.minSync?.bm25).toEqual({ enabled: true, language: "multilingual" });
	});

	it("keeps bm25 and sparse methods active when neutralizeSemanticMethods silences vector/hybrid", async () => {
		const stub = (name: string, type: string): RetrievalMethod => ({
			describe: () => ({ name, type, description: name, status: "active", capabilities: [] }),
			retrieve: async () => [{ id: name, source: "/a.md", content: "ok", score: 1, metadata: {} }],
		});
		const bm25 = stub("hybrid", "bm25");
		const sparse = stub("sparse", "sparse");
		const vector = stub("minsync", "vector");
		const silenced = neutralizeSemanticMethods({ list: () => [bm25, sparse, vector] });
		expect(silenced).toEqual(["minsync"]);
		expect(await bm25.retrieve("q", {})).toHaveLength(1);
		expect(await sparse.retrieve("q", {})).toHaveLength(1);
		expect(await vector.retrieve("q", {})).toHaveLength(0);
	});

	it("reads appIndexing.indexingMode and auto-selects bm25-only via applyAppIndexing on simulated 8GB PC", async () => {
		expect(readAppIndexing({}).indexingMode).toBe("auto");
		expect(readAppIndexing({ appIndexing: { indexingMode: "bm25-only" } }).indexingMode).toBe("bm25-only");
		expect(readAppIndexing({ appIndexing: { indexingMode: "bogus" } }).indexingMode).toBe("auto");

		process.env.AUTORAG_HARDWARE_OVERRIDE = JSON.stringify(hw({ memoryBytes: 8 * GIB, cores: 4 }));
		expect((await readCurrentIndexingTier()).tier).toBe("bm25-only");

		const input: CliConfig = {
			searchPaths: [workDir],
			workspacePath: workDir,
			memoryPath: join(workDir, "memory.json"),
			minSync: { enabled: true, autoInstall: false },
		};
		const effective = await applyAppIndexing(input, { appIndexing: { semanticSearch: false, indexingMode: "auto" } });
		expect(effective.minSync?.embedder).toEqual({ id: "none" });
		expect(effective.minSync?.sparse).toEqual({ id: "none" });
		expect(effective.minSync?.bm25).toEqual({ enabled: true, language: "multilingual" });

		// Handing the resolved config to @autorag/librarian produces a BM25-only agent!
		const agent = new AutoRAGAgent(buildAgentOptions(effective));
		const hybrid = agent.getMethodRegistry().list().find((m) => m.describe().name === "hybrid");
		expect(hybrid?.describe().type).toBe("bm25");

		// If the built MinSync binary is available locally, run a full live offline BM25 E2E sync + query.
		const localBin = process.env.AUTORAG_TEST_MINSYNC_BIN;
		if (localBin && existsSync(localBin)) {
			const ws = join(workDir, "live-dazzi-bm25");
			mkdirSync(join(ws, "files"), { recursive: true });
			writeFileSync(join(ws, "files", "policy.md"), "환불정책과배송안내입니다 빠른 배송\n");
			const client = new MinSyncClient({
				binaryPath: localBin,
				workspacePath: ws,
				embedder: effective.minSync?.embedder,
				sparse: effective.minSync?.sparse,
				bm25: effective.minSync?.bm25,
			});
			const sync = await client.sync(true);
			expect(sync.ok).toBe(true);
			const hits = await client.query("환불 정책", 3, "bm25");
			expect(hits[0]?.path).toContain("policy.md");
			expect(hits[0]?.bm25Rank).toBe(1);
		}
	});
});
