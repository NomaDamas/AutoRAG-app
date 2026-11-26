import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

/**
 * Child-process cleanup for MinSync.
 *
 * MinSync has its own per-batch embedding deadlines (exit 7) and durable stage/sync
 * resumption, and both `minsync stage` (an idle JSONL journal server) and HTTP-backed
 * `minsync sync` (waiting on the local `inl serve` daemon or a remote embedder)
 * legitimately spend minutes at ~0 CPU. Refresh runs therefore never kill MinSync
 * children on CPU inactivity; this module only stops lingering `minsync` children
 * when the app quits or the OS-scheduled refresh job abandons a wedged run.
 */

export interface MinSyncProcess {
	readonly pid: number;
}

/** minsync children of `parentPid` from `ps -A -o pid=,ppid=,comm=`. */
export function parsePsOutput(output: string, parentPid: number): MinSyncProcess[] {
	const found: MinSyncProcess[] = [];
	for (const line of output.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
		if (match === null || Number(match[2]) !== parentPid || basename(match[3] ?? "") !== "minsync") continue;
		found.push({ pid: Number(match[1]) });
	}
	return found;
}

const run = promisify(execFile);

/** The minsync children this process started (POSIX only). An unreadable listing is no children. */
export async function sampleMinSyncProcesses(): Promise<MinSyncProcess[]> {
	if (process.platform === "win32") return [];
	try {
		const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,comm="]);
		return parsePsOutput(stdout, process.pid);
	} catch {
		return [];
	}
}

/**
 * Stop every minsync child this process started. MinSync is a separate process
 * with no signal handler: when its parent quits or gives up, it keeps running
 * headless and keeps `.minsync/lock`, so the next refresh fails with "another
 * sync is in progress" until it finishes. SIGTERM ends it at once and the OS
 * releases the lock; the next sync resumes from `progress.jsonl`. Windows lists
 * no parent for a process, so a minsync there cannot be told from the user's own.
 */
export async function terminateMinSyncChildren(
	sample: () => Promise<readonly MinSyncProcess[]> = sampleMinSyncProcesses,
	kill: (pid: number) => void = (pid) => process.kill(pid, "SIGTERM"),
	platform: NodeJS.Platform = process.platform,
): Promise<number> {
	if (platform === "win32") return 0;
	let stopped = 0;
	for (const { pid } of await sample()) {
		try {
			kill(pid);
			stopped += 1;
		} catch {
			// Already gone.
		}
	}
	return stopped;
}
