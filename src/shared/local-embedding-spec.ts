/**
 * The minimum machine that may run the built-in local embedding model
 * (Qwen3 Embedding 0.6B): the "spec guard".
 *
 * - Apple silicon: a Pro, Max or Ultra chip (M2 Pro, M5 Max, ...; the base M1/M5 chips
 *   do not qualify) with at least 32 GB of unified memory.
 * - Windows and Linux: an NVIDIA (CUDA) GPU with at least 8 GB of VRAM.
 *
 * Pure over a {@link HardwareProfile}, so both processes share one rule: the main
 * process reads the hardware and enforces it, the renderer shows the verdict.
 * Lower the requirement here, and nowhere else, once a lighter model ships.
 */

export const LOCAL_EMBEDDING_MIN_MEMORY_GB = 32;
export const LOCAL_EMBEDDING_MIN_VRAM_GB = 8;

/**
 * Drivers report an "8 GB" card as 8188 or 8192 MiB depending on the model, so the
 * threshold is the 8000 MB the card is sold as, not 8 GiB.
 */
const MIN_VRAM_MIB = LOCAL_EMBEDDING_MIN_VRAM_GB * 1000;
const MIN_MEMORY_BYTES = LOCAL_EMBEDDING_MIN_MEMORY_GB * 1024 ** 3;

export interface GpuInfo {
	readonly name: string;
	/** Dedicated video memory, in MiB, as the NVIDIA driver reports it. */
	readonly vramMiB: number;
}

export interface HardwareProfile {
	/** `process.platform`. */
	readonly platform: string;
	readonly arch: string;
	/** `os.cpus()[0].model`: "Apple M4 Max" on Apple silicon. */
	readonly cpuModel: string;
	readonly memoryBytes: number;
	/** CUDA-capable GPUs only; empty when none was found. */
	readonly gpus: readonly GpuInfo[];
}

export type LocalSpecFailure =
	| "apple-base-chip"
	| "apple-memory"
	| "apple-silicon-required"
	| "no-cuda-gpu"
	| "gpu-vram"
	| "unsupported-platform"
	| "hardware-unreadable";

export type LocalSpecVerdict =
	| { readonly eligible: true }
	| {
			readonly eligible: false;
			readonly reason: LocalSpecFailure;
			readonly vars?: Readonly<Record<string, string | number>>;
	  };

export function isHardwareProfile(value: unknown): value is HardwareProfile {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.platform === "string" &&
		typeof candidate.arch === "string" &&
		typeof candidate.cpuModel === "string" &&
		typeof candidate.memoryBytes === "number" &&
		Number.isFinite(candidate.memoryBytes) &&
		Array.isArray(candidate.gpus) &&
		candidate.gpus.every((gpu) => {
			const entry = gpu as Record<string, unknown> | null;
			return typeof entry === "object" && entry !== null && typeof entry.name === "string" && typeof entry.vramMiB === "number" && Number.isFinite(entry.vramMiB);
		})
	);
}

const APPLE_CHIP = /Apple M\d+(?: (Pro|Max|Ultra))?/u;

export function evaluateLocalEmbeddingSpec(hardware: HardwareProfile): LocalSpecVerdict {
	if (hardware.platform === "darwin") {
		const chip = APPLE_CHIP.exec(hardware.cpuModel);
		if (chip === null) return { eligible: false, reason: "apple-silicon-required" };
		if (chip[1] === undefined) return { eligible: false, reason: "apple-base-chip", vars: { chip: chip[0] } };
		if (hardware.memoryBytes < MIN_MEMORY_BYTES) {
			return {
				eligible: false,
				reason: "apple-memory",
				vars: { memoryGb: Math.floor(hardware.memoryBytes / 1024 ** 3), minMemoryGb: LOCAL_EMBEDDING_MIN_MEMORY_GB },
			};
		}
		return { eligible: true };
	}
	if (hardware.platform === "win32" || hardware.platform === "linux") {
		let best: GpuInfo | undefined;
		for (const gpu of hardware.gpus) if (best === undefined || gpu.vramMiB > best.vramMiB) best = gpu;
		if (best === undefined) return { eligible: false, reason: "no-cuda-gpu", vars: { minVramGb: LOCAL_EMBEDDING_MIN_VRAM_GB } };
		if (best.vramMiB < MIN_VRAM_MIB) {
			return {
				eligible: false,
				reason: "gpu-vram",
				vars: { gpu: best.name, vramGb: Math.floor(best.vramMiB / 1024), minVramGb: LOCAL_EMBEDDING_MIN_VRAM_GB },
			};
		}
		return { eligible: true };
	}
	return { eligible: false, reason: "unsupported-platform" };
}

export type LocalSpecTranslate = (key: string, options?: Record<string, unknown>) => string;

const REASON_KEYS: Readonly<Record<LocalSpecFailure, string>> = {
	"apple-base-chip": "localSpec.reason.appleBaseChip",
	"apple-memory": "localSpec.reason.appleMemory",
	"apple-silicon-required": "localSpec.reason.appleSiliconRequired",
	"no-cuda-gpu": "localSpec.reason.noCudaGpu",
	"gpu-vram": "localSpec.reason.gpuVram",
	"unsupported-platform": "localSpec.reason.unsupportedPlatform",
	"hardware-unreadable": "localSpec.reason.hardwareUnreadable",
};

/** The sentence shown where local embedding is unavailable; empty for an eligible machine. */
export function localSpecMessage(verdict: LocalSpecVerdict, translate: LocalSpecTranslate): string {
	if (verdict.eligible) return "";
	const reason = translate(REASON_KEYS[verdict.reason], {
		minMemoryGb: LOCAL_EMBEDDING_MIN_MEMORY_GB,
		minVramGb: LOCAL_EMBEDDING_MIN_VRAM_GB,
		...verdict.vars,
	});
	return translate("localSpec.blocked", { reason });
}
