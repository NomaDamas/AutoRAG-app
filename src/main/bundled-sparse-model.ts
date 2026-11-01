import { constants, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import sparseModel from "../shared/sparse-model.json";

/**
 * MinSync's SPLADE encoder (`nlpai-lab/KURE-Sparse-nano`, Apache-2.0, 299 MB) ranks every local search, on every
 * machine and in every embedding mode, including the sparse-only mode of a machine too small for the dense model.
 * MinSync would download it from Hugging Face on first use; the installer carries it instead
 * (`<resources>/tools/models/<repoDir>`, staged by `scripts/release/stage-tools.mjs` from the same pin), so search
 * works offline from the first launch.
 *
 * MinSync reads models only from its own cache (`~/.cache/minsync/models`, `%LOCALAPPDATA%\minsync\models`,
 * or `FASTEMBED_CACHE_DIR`) in the Hugging Face hub layout, so the bundled copy is seeded there under the same
 * repo id and revision: the index's sparse identity stays `native:nlpai-lab/KURE-Sparse-nano`, and every MinSync
 * process (the app, its refresh job, the MCP server, a CLI) finds it. On APFS the copy is a clone and costs no
 * space.
 */

export interface SparseModelFile {
	readonly name: string;
	readonly bytes: number;
	readonly sha256: string;
}

export const SPARSE_MODEL: {
	readonly repo: string;
	readonly repoDir: string;
	readonly revision: string;
	readonly files: readonly SparseModelFile[];
} = sparseModel;

export type SparseModelSeedResult = "present" | "seeded" | "not-bundled" | "failed";

/**
 * Where `minsync`'s native encoders (`apply_cache_dir` in `native.rs`) look for cached Hugging Face models:
 * `FASTEMBED_CACHE_DIR` when set, else `%LOCALAPPDATA%\minsync\models` on Windows and `~/.cache/minsync/models`
 * everywhere else. The dense Qwen3 download and the bundled SPLADE seed both write here.
 */
export function minSyncModelCacheRoot(options: {
	readonly platform?: NodeJS.Platform;
	readonly home: string;
	readonly env?: NodeJS.ProcessEnv;
}): string {
	const override = options.env?.FASTEMBED_CACHE_DIR?.trim();
	if (override !== undefined && override.length > 0) return override;
	if ((options.platform ?? process.platform) === "win32") {
		const localAppData = options.env?.LOCALAPPDATA?.trim();
		const root = localAppData !== undefined && localAppData.length > 0 ? localAppData : join(options.home, "AppData", "Local");
		return join(root, "minsync", "models");
	}
	return join(options.home, ".cache", "minsync", "models");
}

function sizeOf(path: string): number | null {
	try {
		return statSync(path).size;
	} catch {
		return null;
	}
}

/** True when every pinned file is at its pinned size and the revision ref is written. */
export function sparseModelPresent(cacheRoot: string): boolean {
	const repo = join(cacheRoot, SPARSE_MODEL.repoDir);
	if (!existsSync(join(repo, "refs", "main"))) return false;
	const snapshot = join(repo, "snapshots", SPARSE_MODEL.revision);
	return SPARSE_MODEL.files.every((file) => sizeOf(join(snapshot, file.name)) === file.bytes);
}

/**
 * Copy the bundled model from `<tools>/models` into MinSync's model cache when the cache does not already hold
 * it. Each file is copied to a temporary name and renamed into place, and `refs/main` is written last, so an
 * interrupted copy never looks complete to MinSync. Any failure leaves the cache as it was: MinSync then
 * downloads the model itself, as it would without a bundle.
 */
export function seedBundledSparseModel(input: {
	readonly toolsRoot: string;
	readonly home: string;
	readonly env: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
}): SparseModelSeedResult {
	const bundled = join(input.toolsRoot, "models", SPARSE_MODEL.repoDir, "snapshots", SPARSE_MODEL.revision);
	if (!SPARSE_MODEL.files.every((file) => sizeOf(join(bundled, file.name)) === file.bytes)) return "not-bundled";
	const cacheRoot = minSyncModelCacheRoot({ home: input.home, env: input.env, ...(input.platform === undefined ? {} : { platform: input.platform }) });
	if (sparseModelPresent(cacheRoot)) return "present";
	const repo = join(cacheRoot, SPARSE_MODEL.repoDir);
	const snapshot = join(repo, "snapshots", SPARSE_MODEL.revision);
	try {
		for (const file of SPARSE_MODEL.files) {
			const target = join(snapshot, file.name);
			if (sizeOf(target) === file.bytes) continue;
			mkdirSync(dirname(target), { recursive: true });
			const partial = `${target}.seed-${process.pid}`;
			copyFileSync(join(bundled, file.name), partial, constants.COPYFILE_FICLONE);
			renameSync(partial, target);
		}
		mkdirSync(join(repo, "refs"), { recursive: true });
		writeFileSync(join(repo, "refs", "main"), SPARSE_MODEL.revision);
		return "seeded";
	} catch {
		for (const file of SPARSE_MODEL.files) rmSync(`${join(snapshot, file.name)}.seed-${process.pid}`, { force: true });
		return "failed";
	}
}
