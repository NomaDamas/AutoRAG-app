import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { t } from "../shared/i18n/core";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "./embedding-daemon";
import type { ModelDownloadState, ModelDownloadStatus } from "../shared/model-download-contract";

/**
 * Fetches the on-device embedding model (Qwen/Qwen3-Embedding-0.6B) into the cache MinSync's native embedder
 * reads, in the Hugging Face hub layout (`models--Org--Name/{refs/main,snapshots/<rev>/<file>}`). The installer
 * does not carry these ~1.2 GB; the app downloads them when the user chooses local embedding.
 *
 * Every file is pinned by revision, size and SHA-256. A file is written to `<name>.download`, hashed once
 * complete, and only then renamed into place, so the cache never holds a half or a corrupt file. A stopped
 * download keeps its partial file and the next start continues it with a Range request.
 */

export interface ModelFile {
	readonly name: string;
	readonly sha256: string;
	readonly bytes: number;
}

export interface ModelSpec {
	/** Cache directory name, e.g. `models--Qwen--Qwen3-Embedding-0.6B`. */
	readonly repoDir: string;
	readonly revision: string;
	/** A file lives at `<baseUrl>/<name>`. */
	readonly baseUrl: string;
	readonly files: readonly ModelFile[];
}

const NATIVE_QWEN3_REVISION = "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3";

/** The one model the app offers, pinned to the revision and hashes MinSync's native embedder was verified with. */
export function nativeQwen3Spec(baseUrl: string = `https://huggingface.co/${DEFAULT_LOCAL_EMBEDDING_MODEL}/resolve/${NATIVE_QWEN3_REVISION}`): ModelSpec {
	return {
		repoDir: "models--Qwen--Qwen3-Embedding-0.6B",
		revision: NATIVE_QWEN3_REVISION,
		baseUrl: baseUrl.replace(/\/+$/u, ""),
		files: [
			{ name: "config.json", bytes: 727, sha256: "b5bf1f51fc45be473a54718cef92448d90a1be001bf9b9a44b8c7f10a19feaa9" },
			{ name: "tokenizer.json", bytes: 11_423_705, sha256: "def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a" },
			{ name: "model.safetensors", bytes: 1_191_586_416, sha256: "0437e45c94563b09e13cb7a64478fc406947a93cb34a7e05870fc8dcd48e23fd" },
		],
	};
}

export function modelTotalBytes(spec: ModelSpec): number {
	return spec.files.reduce((sum, file) => sum + file.bytes, 0);
}

/**
 * Where `minsync`'s `NativeEmbedder` (`apply_cache_dir` in `native.rs`) looks for cached Hugging Face models:
 * `FASTEMBED_CACHE_DIR` when set, else `%LOCALAPPDATA%\minsync\models` on Windows and `~/.cache/minsync/models`
 * everywhere else.
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

/**
 * The `modelPresent` check of the embedding daemon: the pinned Qwen3 weights must be in the cache; any other
 * native model is MinSync's own to fetch.
 */
export function localModelPresent(options: { readonly home: string; readonly env: NodeJS.ProcessEnv }): (model: string) => boolean {
	return (model) => model.toLowerCase() !== DEFAULT_LOCAL_EMBEDDING_MODEL.toLowerCase() || modelFilesPresent(minSyncModelCacheRoot({ home: options.home, env: options.env }), nativeQwen3Spec());
}

function snapshotDir(cacheRoot: string, spec: ModelSpec): string {
	return join(cacheRoot, spec.repoDir, "snapshots", spec.revision);
}

/** Size of a file, following symlinks (hf-hub links snapshot files into `blobs/`); null when it is not there. */
function sizeOf(path: string): number | null {
	try {
		return statSync(path).size;
	} catch {
		return null;
	}
}

/**
 * True when every file is in the cache at its pinned size and the revision ref is written. Sizes, not hashes:
 * a file only reaches its final name after its hash matched, and hashing 1.2 GB on every check would be slow.
 */
export function modelFilesPresent(cacheRoot: string, spec: ModelSpec): boolean {
	if (!existsSync(join(cacheRoot, spec.repoDir, "refs", "main"))) return false;
	const directory = snapshotDir(cacheRoot, spec);
	return spec.files.every((file) => sizeOf(join(directory, file.name)) === file.bytes);
}

/** Bytes of the model on disk: finished files in full, a partial file as far as it got. */
function bytesOnDisk(cacheRoot: string, spec: ModelSpec): number {
	const directory = snapshotDir(cacheRoot, spec);
	let total = 0;
	for (const file of spec.files) {
		const done = sizeOf(join(directory, file.name));
		total += done === file.bytes ? file.bytes : Math.min(sizeOf(`${join(directory, file.name)}.download`) ?? 0, file.bytes);
	}
	return total;
}

export interface ModelDownloadService {
	status(): ModelDownloadStatus;
	/** Starts the download, or joins the running one. Resolves with the status right after it started. */
	start(): Promise<ModelDownloadStatus>;
	/** Stops the running download; the partial file stays. Resolves once it has stopped. */
	cancel(): Promise<ModelDownloadStatus>;
	/** Resolves with the final status of the download in progress, or the current status when none runs. */
	settled(): Promise<ModelDownloadStatus>;
}

export interface ModelDownloadDeps {
	readonly cacheRoot: string;
	readonly spec: ModelSpec;
	readonly onChange?: (status: ModelDownloadStatus) => void;
	readonly fetchImpl?: typeof fetch;
	/** Least time between two progress notifications. Defaults to 100 ms. */
	readonly progressIntervalMs?: number;
	/** A download that receives nothing for this long fails instead of hanging. Defaults to 30 s. */
	readonly idleTimeoutMs?: number;
}

class HttpError extends Error {
	constructor(readonly status: number) {
		super(`HTTP ${status}`);
	}
}

class ChecksumError extends Error {}

class IdleError extends Error {}

function hashFile(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}

export function createModelDownloadService(deps: ModelDownloadDeps): ModelDownloadService {
	const { cacheRoot, spec } = deps;
	const doFetch = deps.fetchImpl ?? fetch;
	const total = modelTotalBytes(spec);
	const intervalMs = deps.progressIntervalMs ?? 100;
	const idleMs = deps.idleTimeoutMs ?? 30_000;

	const initial = (): ModelDownloadStatus =>
		modelFilesPresent(cacheRoot, spec)
			? { state: "ready", bytesDone: total, bytesTotal: total, file: null, error: null }
			: { state: "absent", bytesDone: bytesOnDisk(cacheRoot, spec), bytesTotal: total, file: null, error: null };

	let current = initial();
	let running: Promise<ModelDownloadStatus> | null = null;
	let controller: AbortController | null = null;
	let lastNotified = 0;

	const set = (next: Partial<ModelDownloadStatus> & { readonly state: ModelDownloadState }, force = true): void => {
		current = { ...current, ...next };
		const now = Date.now();
		if (!force && now - lastNotified < intervalMs) return;
		lastNotified = now;
		deps.onChange?.(current);
	};

	async function fetchFile(file: ModelFile, completed: number, signal: AbortSignal): Promise<void> {
		const directory = snapshotDir(cacheRoot, spec);
		const target = join(directory, file.name);
		const part = `${target}.download`;
		await mkdir(directory, { recursive: true });
		set({ state: "downloading", file: file.name, bytesDone: completed });
		if (sizeOf(target) === file.bytes) return;

		let offset = sizeOf(part) ?? 0;
		if (offset > file.bytes) {
			await rm(part, { force: true });
			offset = 0;
		}
		if (offset < file.bytes) {
			const inner = new AbortController();
			const forward = (): void => inner.abort();
			signal.addEventListener("abort", forward, { once: true });
			let idle: ReturnType<typeof setTimeout> | undefined;
			let timedOut = false;
			const arm = (): void => {
				clearTimeout(idle);
				idle = setTimeout(() => {
					timedOut = true;
					inner.abort();
				}, idleMs);
			};
			try {
				arm();
				const response = await doFetch(`${spec.baseUrl}/${file.name}`, {
					headers: offset > 0 ? { range: `bytes=${offset}-` } : {},
					signal: inner.signal,
				});
				if (response.status === 200 && offset > 0) offset = 0; // the server ignored Range: start the file over
				else if (response.status !== 200 && response.status !== 206) throw new HttpError(response.status);
				if (response.body === null) throw new HttpError(response.status);
				const handle = await open(part, offset > 0 ? "a" : "w");
				try {
					let received = offset;
					set({ bytesDone: completed + received, state: "downloading" }, false);
					const reader = response.body.getReader();
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						arm();
						await handle.write(value);
						received += value.length;
						set({ state: "downloading", bytesDone: completed + Math.min(received, file.bytes) }, false);
					}
				} finally {
					await handle.close();
				}
			} catch (error) {
				if (timedOut && !signal.aborted) throw new IdleError(file.name);
				throw error;
			} finally {
				clearTimeout(idle);
				signal.removeEventListener("abort", forward);
			}
		}
		if ((await hashFile(part)) !== file.sha256 || sizeOf(part) !== file.bytes) {
			await rm(part, { force: true });
			throw new ChecksumError(file.name);
		}
		await rename(part, target);
	}

	function describe(error: unknown, file: string | null): string {
		const name = file ?? "";
		if (error instanceof HttpError) return t("main.modelDownload.errors.http", { file: name, status: error.status });
		if (error instanceof ChecksumError) return t("main.modelDownload.errors.checksum", { file: name });
		if (error instanceof IdleError) return t("main.modelDownload.errors.stalled", { file: name });
		const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
		return t("main.modelDownload.errors.network", { file: name, message: `${error instanceof Error ? error.message : String(error)}${cause}` });
	}

	async function run(signal: AbortSignal): Promise<ModelDownloadStatus> {
		try {
			let completed = 0;
			for (const file of spec.files) {
				await fetchFile(file, completed, signal);
				completed += file.bytes;
			}
			// The ref is what makes the cache usable offline; it is written last, after every file verified.
			await mkdir(join(cacheRoot, spec.repoDir, "refs"), { recursive: true });
			await writeFile(join(cacheRoot, spec.repoDir, "refs", "main"), spec.revision);
			set({ state: "ready", bytesDone: total, file: null, error: null });
		} catch (error) {
			if (signal.aborted) set({ ...initial(), state: "absent", error: null });
			else set({ state: "failed", bytesDone: bytesOnDisk(cacheRoot, spec), error: describe(error, current.file) });
		}
		return current;
	}

	return {
		status: () => {
			// Idle states follow the disk: a model deleted or finished by another program is noticed. A failure keeps its reason.
			if (running === null && current.state !== "failed") current = initial();
			return current;
		},
		start: async () => {
			if (running === null) {
				if (modelFilesPresent(cacheRoot, spec)) {
					if (current.state !== "ready") set(initial());
					return current;
				}
				controller = new AbortController();
				const signal = controller.signal;
				set({ state: "downloading", error: null, file: null, bytesDone: bytesOnDisk(cacheRoot, spec) });
				const started = run(signal).finally(() => {
					if (running === started) running = null;
				});
				running = started;
			}
			return current;
		},
		cancel: async () => {
			controller?.abort();
			await running;
			return current;
		},
		settled: async () => (running === null ? current : running),
	};
}
