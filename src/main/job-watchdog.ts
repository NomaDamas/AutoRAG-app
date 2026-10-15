import { statSync } from "node:fs";
import { join } from "node:path";

/**
 * Decides when the background job has to be abandoned. A wall clock cannot: a
 * first index of a large corpus legitimately runs for hours, and killing it every
 * tick throws away the batch in flight each time. What matters is whether the
 * run is still producing anything, so the job watches the files a healthy run
 * keeps touching and gives up only when they go quiet (or, as a last resort,
 * after a hard ceiling).
 */

/** No change in any progress file for this long means the run is wedged. */
/** Longer than 25 files (one mirror checkpoint) each spending the full 180 s parse budget. */
export const JOB_STALL_MS = 90 * 60_000;
/** Whatever it is doing, a single tick never runs longer than this. */
export const JOB_HARD_MAX_MS = 24 * 60 * 60_000;
const CHECK_INTERVAL_MS = 60_000;

export type JobExpiry = "stalled" | "ceiling";

export interface JobWatchdogOptions {
	/** Newest modification time (ms) among the progress files; 0 when none exist yet. */
	readonly latestSignal: () => number;
	readonly onExpire: (reason: JobExpiry, idleMs: number) => void;
	readonly stallMs?: number;
	readonly hardMaxMs?: number;
	readonly intervalMs?: number;
	readonly now?: () => number;
}

export interface JobWatchdog {
	/** One observation; the timer calls it, tests call it directly. */
	tick(): void;
	start(): void;
	stop(): void;
}

export function createJobWatchdog(options: JobWatchdogOptions): JobWatchdog {
	const now = options.now ?? Date.now;
	const stallMs = options.stallMs ?? JOB_STALL_MS;
	const hardMaxMs = options.hardMaxMs ?? JOB_HARD_MAX_MS;
	const startedAt = now();
	let lastSignal = 0;
	let lastProgressAt = startedAt;
	let timer: NodeJS.Timeout | null = null;
	let expired = false;

	const tick = (): void => {
		if (expired) return;
		const at = now();
		const signal = options.latestSignal();
		if (signal > lastSignal) {
			lastSignal = signal;
			lastProgressAt = at;
		}
		const reason: JobExpiry | null = at - startedAt >= hardMaxMs ? "ceiling" : at - lastProgressAt >= stallMs ? "stalled" : null;
		if (reason === null) return;
		expired = true;
		options.onExpire(reason, at - lastProgressAt);
	};

	return {
		tick,
		start: () => {
			if (timer !== null) return;
			timer = setInterval(tick, options.intervalMs ?? CHECK_INTERVAL_MS);
			timer.unref();
		},
		stop: () => {
			clearInterval(timer ?? undefined);
			timer = null;
		},
	};
}

/**
 * The files a running refresh keeps touching: the librarian's phase marker, the
 * parsed mirror's checkpoint (every 25 files), and MinSync's resume log (every batch).
 */
export function progressFiles(workspacePath: string): readonly string[] {
	return [
		join(workspacePath, ".autorag", "refresh-progress.json"),
		join(workspacePath, ".autorag", "parsed", "index.json"),
		join(workspacePath, ".autorag", "minsync", ".minsync", "progress.jsonl"),
	];
}

/** Newest mtime among `files`; a missing file counts as 0. */
export function latestModification(files: readonly string[]): number {
	let latest = 0;
	for (const file of files) {
		try {
			latest = Math.max(latest, statSync(file).mtimeMs);
		} catch {
			// not written yet
		}
	}
	return latest;
}
