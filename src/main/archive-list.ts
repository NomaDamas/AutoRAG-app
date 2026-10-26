/**
 * Lists an archive's top level for the Quick Look panel. The page has no wasm
 * engine, so the main process runs one on a worker thread
 * (`archive-list-worker.mjs`) and sends back one entry per top-level child.
 *
 * Every limit ends in a note rather than an error: an archive over the input
 * cap is never read, a zstd stream stops inflating at its output cap, a
 * listing over the entry or time cap is abandoned, and a preview that moved
 * on stops the worker. Nothing here writes to disk.
 */

import { stat } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { collapseToTopLevel, type ArchiveEntry } from "../preview/shared/archive-items";
import type { ArchivePreview, ArchiveUnreadable } from "../preview/shared/contract";

/** What bounds one listing. */
export interface ArchiveListLimits {
	/** The compressed archive is read whole into the engine's memory, so a bigger one is not read at all. */
	readonly maxInputBytes: number;
	/** The most a zstd layer may inflate to before the listing gives up. */
	readonly maxOutputBytes: number;
	/** The most entries a listing walks. */
	readonly maxEntries: number;
	/** Wall time before the worker is terminated. */
	readonly timeoutMs: number;
}

const MIB = 1024 ** 2;

export const ARCHIVE_LIST_LIMITS: ArchiveListLimits = {
	maxInputBytes: 256 * MIB,
	maxOutputBytes: 512 * MIB,
	maxEntries: 100_000,
	timeoutMs: 30_000,
};

export interface ArchiveListOptions {
	readonly limits?: Partial<ArchiveListLimits>;
	/** Polled while the worker runs; true abandons the listing (the preview moved on). */
	readonly stopped?: () => boolean;
}

/** How often a running listing asks whether it is still wanted. */
const STOP_POLL_MS = 200;

type WorkerReply =
	| { readonly ok: true; readonly entries: readonly ArchiveEntry[] }
	| { readonly ok: false; readonly reason: ArchiveUnreadable };

/**
 * The top-level children of `sourcePath`, or the reason it cannot be listed.
 * Rejects only when `stopped` says the result is no longer wanted.
 */
export async function listArchive(sourcePath: string, options: ArchiveListOptions = {}): Promise<ArchivePreview> {
	const limits = { ...ARCHIVE_LIST_LIMITS, ...options.limits };
	if ((await stat(sourcePath)).size > limits.maxInputBytes) return { kind: "unreadable", reason: "tooLarge" };
	return new Promise<ArchivePreview>((resolve, reject) => {
		const worker = new Worker(new URL("./archive-list-worker.mjs", import.meta.url), {
			workerData: { sourcePath, limits },
		});
		const timers: NodeJS.Timeout[] = [];
		const settle = (finish: () => void): void => {
			for (const timer of timers) clearTimeout(timer);
			void worker.terminate();
			finish();
		};
		const unreadable = (reason: ArchiveUnreadable): void => settle(() => resolve({ kind: "unreadable", reason }));
		timers.push(setTimeout(() => unreadable("tooSlow"), limits.timeoutMs));
		if (options.stopped !== undefined) {
			const stopped = options.stopped;
			const poll = (): void => {
				if (stopped()) {
					settle(() => reject(new Error("Archive listing cancelled")));
					return;
				}
				timers.push(setTimeout(poll, STOP_POLL_MS));
			};
			poll();
		}
		worker.once("message", (reply: WorkerReply) => {
			if (reply.ok) settle(() => resolve({ kind: "entries", entries: collapseToTopLevel(reply.entries) }));
			else unreadable(reply.reason);
		});
		worker.once("error", () => unreadable("corrupt"));
		worker.once("exit", (code) => {
			if (code !== 0) unreadable("corrupt");
		});
	});
}
