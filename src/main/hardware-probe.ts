import { execFile } from "node:child_process";
import { cpus, totalmem } from "node:os";
import { promisify } from "node:util";
import {
	evaluateIndexingTier,
	evaluateLocalEmbeddingSpec,
	isHardwareProfile,
	type GpuInfo,
	type HardwareProfile,
	type IndexingTierVerdict,
	type LocalSpecVerdict,
} from "../shared/local-embedding-spec";

const execFileAsync = promisify(execFile);

/** `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`: one "name, MiB" line per GPU. */
export function parseNvidiaSmi(output: string): readonly GpuInfo[] {
	const gpus: GpuInfo[] = [];
	for (const line of output.split(/\r?\n/u)) {
		const cut = line.lastIndexOf(",");
		if (cut < 0) continue;
		const name = line.slice(0, cut).trim();
		const vramMiB = Number(line.slice(cut + 1).trim());
		if (name.length > 0 && Number.isFinite(vramMiB) && vramMiB > 0) gpus.push({ name, vramMiB });
	}
	return gpus;
}

/** Where the driver puts `nvidia-smi` when it is not on `PATH` (older Windows drivers). */
const NVIDIA_SMI_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
	win32: ["nvidia-smi", "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe"],
	linux: ["nvidia-smi"],
};

async function readCudaGpus(platform: string): Promise<readonly GpuInfo[]> {
	for (const command of NVIDIA_SMI_CANDIDATES[platform] ?? []) {
		try {
			const { stdout } = await execFileAsync(command, ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], {
				timeout: 10_000,
				windowsHide: true,
			});
			return parseNvidiaSmi(stdout);
		} catch {
			// Not installed here, or the driver is not loaded: try the next location, then report no CUDA GPU.
		}
	}
	return [];
}

export async function readHardware(): Promise<HardwareProfile> {
	const platform = process.platform;
	const cpuList = cpus();
	return {
		platform,
		arch: process.arch,
		cpuModel: cpuList[0]?.model ?? "",
		memoryBytes: totalmem(),
		cores: Math.max(1, cpuList.length),
		gpus: platform === "win32" || platform === "linux" ? await readCudaGpus(platform) : [],
	};
}

export interface LocalSpecProbeDeps {
	readonly env: NodeJS.ProcessEnv;
	/**
	 * Whether `AUTORAG_QA_HARDWARE` (a JSON {@link HardwareProfile}) may replace the real
	 * hardware. Manual QA needs it to see the blocked state on a capable machine; a packaged
	 * app never honors it.
	 */
	readonly allowOverride: boolean;
	readonly readHardware?: () => Promise<HardwareProfile>;
}

function overrideFrom(env: NodeJS.ProcessEnv): HardwareProfile | null {
	const raw = env.AUTORAG_QA_HARDWARE?.trim();
	if (raw === undefined || raw.length === 0) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return isHardwareProfile(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * The verdict for this machine, read once: the hardware does not change while the app
 * runs, and `nvidia-smi` costs a process spawn. An unreadable machine is blocked, not an error.
 */
export function createLocalSpecProbe(deps: LocalSpecProbeDeps): () => Promise<LocalSpecVerdict> {
	let verdict: Promise<LocalSpecVerdict> | null = null;
	return () => {
		verdict ??= (async (): Promise<LocalSpecVerdict> => {
			const override = deps.allowOverride ? overrideFrom(deps.env) : null;
			try {
				return evaluateLocalEmbeddingSpec(override ?? (await (deps.readHardware ?? readHardware)()));
			} catch {
				return { eligible: false, reason: "hardware-unreadable" };
			}
		})();
		return verdict;
	};
}

/**
 * Cached indexing-tier probe (`bm25-only` / `sparse+bm25` / `full`) from the same host hardware
 * snapshot. Falls back safely to `bm25-only` if hardware cannot be probed.
 */
export function createIndexingTierProbe(deps: LocalSpecProbeDeps): () => Promise<IndexingTierVerdict> {
	let verdict: Promise<IndexingTierVerdict> | null = null;
	return () => {
		verdict ??= (async (): Promise<IndexingTierVerdict> => {
			const override = deps.allowOverride ? overrideFrom(deps.env) : null;
			try {
				return evaluateIndexingTier(override ?? (await (deps.readHardware ?? readHardware)()));
			} catch {
				return {
					tier: "bm25-only",
					denseEligible: false,
					sparseEnabled: false,
					bm25Enabled: true,
					reason: "hardware-unreadable: falling back to zero-ML BM25 only",
				};
			}
		})();
		return verdict;
	};
}

let cachedTierVerdict: Promise<IndexingTierVerdict> | null = null;

/** Resolve the current host's indexing tier, honoring `AUTORAG_HARDWARE_OVERRIDE` when set. */
export async function readCurrentIndexingTier(env: NodeJS.ProcessEnv = process.env): Promise<IndexingTierVerdict> {
	const raw = env.AUTORAG_HARDWARE_OVERRIDE?.trim() || env.AUTORAG_QA_HARDWARE?.trim();
	if (raw !== undefined && raw.length > 0) {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (isHardwareProfile(parsed)) return evaluateIndexingTier(parsed);
		} catch {
			// Ignore malformed override and probe the real host.
		}
	}
	cachedTierVerdict ??= readHardware()
		.then(evaluateIndexingTier)
		.catch(
			(): IndexingTierVerdict => ({
				tier: "bm25-only",
				denseEligible: false,
				sparseEnabled: false,
				bm25Enabled: true,
				reason: "hardware-unreadable: falling back to zero-ML BM25 only",
			}),
		);
	return cachedTierVerdict;
}
