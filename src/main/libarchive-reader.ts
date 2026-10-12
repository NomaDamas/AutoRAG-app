/**
 * libarchive-wasm-backed extractor for the formats Node cannot read natively:
 * 7z, RAR, and the bzip2/xz tar wrappers. The wasm build reads them in memory and
 * runs in a Node worker thread, so the Electron main thread never blocks.
 *
 * The engine is loaded lazily, inside the worker, on the first such extraction.
 * The worker writes only regular files and directories, skipping symlinks,
 * hardlinks, devices, and FIFOs; archives that look encrypted or do not parse
 * are refused with Korean copy — the app never prompts for a password.
 */

import { stat } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { t } from "../shared/i18n/core";
import { ArchiveError } from "./archive-guard.mjs";
import { type ArchiveLimits } from "./archive-common";

/** One worker's reply: success, or the Korean reason it refused the archive. */
interface WorkerReply {
	readonly ok: boolean;
	readonly message?: string;
}

/** The fallback when the engine traps instead of reporting: a message covering both causes. */
const combinedMessage = (): string => t("main.archive.combined");

/**
 * Extract `sourcePath` into `destDir` on a worker thread. Throws
 * {@link ArchiveError} (Korean) when the archive is too large for the
 * in-memory engine, encrypted, empty, corrupt, or over the byte/entry caps.
 */
export async function extractWithLibarchive(sourcePath: string, destDir: string, limits: ArchiveLimits): Promise<void> {
	const size = (await stat(sourcePath)).size;
	if (size > limits.maxEngineBytes) {
		throw new ArchiveError(t("main.archive.tooLargeForEngine"));
	}
	await new Promise<void>((resolve, reject) => {
		const worker = new Worker(new URL("./archive-worker.mjs", import.meta.url), {
			workerData: { sourcePath, destDir, limits },
		});
		const settle = (error: ArchiveError | null): void => {
			void worker.terminate();
			if (error === null) resolve();
			else reject(error);
		};
		worker.once("message", (reply: WorkerReply) => settle(reply.ok ? null : new ArchiveError(reply.message ?? combinedMessage())));
		worker.once("error", () => settle(new ArchiveError(combinedMessage())));
		worker.once("exit", (code) => {
			if (code !== 0) settle(new ArchiveError(combinedMessage()));
		});
	});
}
