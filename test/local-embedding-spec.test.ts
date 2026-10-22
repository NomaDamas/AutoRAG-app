import { describe, expect, it } from "vitest";
import {
	LOCAL_EMBEDDING_MIN_MEMORY_GB,
	LOCAL_EMBEDDING_MIN_VRAM_GB,
	evaluateLocalEmbeddingSpec,
	localSpecMessage,
	type HardwareProfile,
} from "../src/shared/local-embedding-spec";
import { createLocalSpecProbe, parseNvidiaSmi } from "../src/main/hardware-probe";

const GIB = 1024 ** 3;

function mac(cpuModel: string, memoryGb: number, arch = "arm64"): HardwareProfile {
	return { platform: "darwin", arch, cpuModel, memoryBytes: memoryGb * GIB, gpus: [] };
}

function pc(platform: string, gpus: HardwareProfile["gpus"]): HardwareProfile {
	return { platform, arch: "x64", cpuModel: "Some CPU", memoryBytes: 64 * GIB, gpus };
}

describe("evaluateLocalEmbeddingSpec: Apple silicon", () => {
	it("passes a Pro, Max or Ultra chip with at least 32 GB of unified memory", () => {
		for (const chip of ["Apple M2 Pro", "Apple M4 Max", "Apple M5 Pro", "Apple M6 Max", "Apple M1 Ultra"]) {
			expect(evaluateLocalEmbeddingSpec(mac(chip, 32)), chip).toEqual({ eligible: true });
		}
		expect(evaluateLocalEmbeddingSpec(mac("Apple M4 Max", 64))).toEqual({ eligible: true });
	});

	it("rejects a base chip however much memory it has", () => {
		for (const chip of ["Apple M1", "Apple M2", "Apple M5", "Apple M6"]) {
			expect(evaluateLocalEmbeddingSpec(mac(chip, 32)), chip).toEqual({ eligible: false, reason: "apple-base-chip", vars: { chip } });
		}
	});

	it("rejects a Pro/Max chip below 32 GB and reports the memory it has", () => {
		expect(evaluateLocalEmbeddingSpec(mac("Apple M3 Pro", 18))).toEqual({
			eligible: false,
			reason: "apple-memory",
			vars: { memoryGb: 18, minMemoryGb: LOCAL_EMBEDDING_MIN_MEMORY_GB },
		});
	});

	it("checks the chip before the memory, so a base chip never reads as a memory problem", () => {
		const verdict = evaluateLocalEmbeddingSpec(mac("Apple M4", 16));
		expect(verdict.eligible === false && verdict.reason).toBe("apple-base-chip");
	});

	it("rejects an Intel Mac", () => {
		const verdict = evaluateLocalEmbeddingSpec(mac("Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz", 64, "x64"));
		expect(verdict).toMatchObject({ eligible: false, reason: "apple-silicon-required" });
	});

	it("matches the chip inside a longer brand string such as a virtual machine's", () => {
		expect(evaluateLocalEmbeddingSpec(mac("Apple M4 Max (Virtual)", 32))).toEqual({ eligible: true });
	});
});

describe("evaluateLocalEmbeddingSpec: Windows and Linux", () => {
	it("passes a CUDA GPU with at least 8 GB of VRAM", () => {
		for (const platform of ["win32", "linux"]) {
			expect(evaluateLocalEmbeddingSpec(pc(platform, [{ name: "NVIDIA GeForce RTX 4070", vramMiB: 12_282 }]))).toEqual({ eligible: true });
		}
	});

	it("treats a card marketed as 8 GB as 8 GB even when the driver reports a few MiB less", () => {
		expect(evaluateLocalEmbeddingSpec(pc("win32", [{ name: "NVIDIA GeForce RTX 4060 Laptop GPU", vramMiB: 8188 }]))).toEqual({ eligible: true });
	});

	it("rejects a GPU under 8 GB and says how much it has", () => {
		expect(evaluateLocalEmbeddingSpec(pc("linux", [{ name: "NVIDIA GeForce RTX 3050", vramMiB: 6144 }]))).toEqual({
			eligible: false,
			reason: "gpu-vram",
			vars: { gpu: "NVIDIA GeForce RTX 3050", vramGb: 6, minVramGb: LOCAL_EMBEDDING_MIN_VRAM_GB },
		});
	});

	it("uses the GPU with the most VRAM when there are several", () => {
		expect(
			evaluateLocalEmbeddingSpec(
				pc("win32", [
					{ name: "NVIDIA GeForce GTX 1050", vramMiB: 2048 },
					{ name: "NVIDIA GeForce RTX 3080", vramMiB: 10_240 },
				]),
			),
		).toEqual({ eligible: true });
	});

	it("rejects a machine with no CUDA GPU", () => {
		expect(evaluateLocalEmbeddingSpec(pc("win32", []))).toEqual({
			eligible: false,
			reason: "no-cuda-gpu",
			vars: { minVramGb: LOCAL_EMBEDDING_MIN_VRAM_GB },
		});
	});

	it("rejects a platform the app has no local embedding path for", () => {
		expect(evaluateLocalEmbeddingSpec(pc("freebsd", [{ name: "NVIDIA", vramMiB: 24_000 }]))).toMatchObject({ eligible: false, reason: "unsupported-platform" });
	});
});

describe("localSpecMessage", () => {
	function recorder(): { readonly calls: [string, Record<string, unknown>][]; readonly translate: (key: string, options?: Record<string, unknown>) => string } {
		const calls: [string, Record<string, unknown>][] = [];
		return {
			calls,
			translate: (key, options) => {
				calls.push([key, options ?? {}]);
				return `<${key}>`;
			},
		};
	}

	it("is empty for an eligible machine", () => {
		const { calls, translate } = recorder();
		expect(localSpecMessage({ eligible: true }, translate)).toBe("");
		expect(calls).toEqual([]);
	});

	it("wraps the failing requirement in the shared blocked sentence, with the machine's own numbers", () => {
		const { calls, translate } = recorder();
		const message = localSpecMessage(evaluateLocalEmbeddingSpec(mac("Apple M3 Pro", 18)), translate);
		expect(message).toBe("<localSpec.blocked>");
		expect(calls).toEqual([
			["localSpec.reason.appleMemory", { memoryGb: 18, minMemoryGb: 32, minVramGb: 8 }],
			["localSpec.blocked", { reason: "<localSpec.reason.appleMemory>" }],
		]);
	});

	it("has a reason string for every way to fail", () => {
		const verdicts = [
			evaluateLocalEmbeddingSpec(mac("Apple M4", 64)),
			evaluateLocalEmbeddingSpec(mac("Intel", 64, "x64")),
			evaluateLocalEmbeddingSpec(pc("win32", [])),
			evaluateLocalEmbeddingSpec(pc("win32", [{ name: "G", vramMiB: 1024 }])),
			evaluateLocalEmbeddingSpec(pc("sunos", [])),
		];
		const keys = new Set<string>();
		for (const verdict of verdicts) {
			const { calls, translate } = recorder();
			localSpecMessage(verdict, translate);
			keys.add(calls[0]?.[0] ?? "");
		}
		expect([...keys].sort()).toEqual([
			"localSpec.reason.appleBaseChip",
			"localSpec.reason.appleSiliconRequired",
			"localSpec.reason.gpuVram",
			"localSpec.reason.noCudaGpu",
			"localSpec.reason.unsupportedPlatform",
		].sort());
	});
});

describe("parseNvidiaSmi", () => {
	it("reads one GPU per line and ignores lines it cannot read", () => {
		expect(parseNvidiaSmi("NVIDIA GeForce RTX 4090, 24564\nNVIDIA RTX A2000, 6138\n\nNVIDIA Thing, [N/A]\nnonsense\n")).toEqual([
			{ name: "NVIDIA GeForce RTX 4090", vramMiB: 24_564 },
			{ name: "NVIDIA RTX A2000", vramMiB: 6138 },
		]);
	});
});

describe("createLocalSpecProbe", () => {
	const eligibleMac = mac("Apple M4 Max", 64);

	it("reads the hardware once and keeps the verdict", async () => {
		let reads = 0;
		const probe = createLocalSpecProbe({
			env: {},
			allowOverride: false,
			readHardware: async () => {
				reads += 1;
				return eligibleMac;
			},
		});
		expect(await probe()).toEqual({ eligible: true });
		expect(await probe()).toEqual({ eligible: true });
		expect(reads).toBe(1);
	});

	it("honors the QA hardware override only when overrides are allowed", async () => {
		const env = { AUTORAG_QA_HARDWARE: JSON.stringify(mac("Apple M2", 8)) };
		const real = async (): Promise<HardwareProfile> => eligibleMac;
		expect(await createLocalSpecProbe({ env, allowOverride: true, readHardware: real })()).toMatchObject({ eligible: false, reason: "apple-base-chip" });
		expect(await createLocalSpecProbe({ env, allowOverride: false, readHardware: real })()).toEqual({ eligible: true });
	});

	it("falls back to the real hardware when the override is not a hardware profile", async () => {
		const probe = createLocalSpecProbe({ env: { AUTORAG_QA_HARDWARE: "{nope" }, allowOverride: true, readHardware: async () => eligibleMac });
		expect(await probe()).toEqual({ eligible: true });
	});

	it("blocks, rather than throws, when the hardware cannot be read", async () => {
		const probe = createLocalSpecProbe({
			env: {},
			allowOverride: false,
			readHardware: async () => {
				throw new Error("sysctl failed");
			},
		});
		expect(await probe()).toEqual({ eligible: false, reason: "hardware-unreadable" });
	});
});
