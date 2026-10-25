import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { isEmbeddingDaemonPid } from "./embedding-daemon";

/**
 * MinSync embeds the whole corpus in one child process, so the app cannot time
 * a single file there. What it can see from outside is whether the child is
 * doing anything: a healthy sync burns CPU the whole time, a hung embedder
 * burns none. A child whose CPU time has not moved for `stallMs` is killed; the
 * librarian reports the sync as failed, and the caller retries it.
 */

export interface MinSyncProcess {
	readonly pid: number;
	/** Total CPU time (user + system) the process has used so far. */
	readonly cpuMs: number;
}

/** How long a minsync child may use no CPU before it counts as stuck. */
export const DEFAULT_EMBEDDING_STALL_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 10_000;

/** `ps`/`tasklist` CPU time: `[[d-]hh:]mm:ss[.cc]`. */
export function parseCpuTime(text: string): number | null {
	const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/u.exec(text.trim());
	if (match === null) return null;
	const [, days, hours, minutes, seconds] = match;
	return ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60_000 + Math.round(Number(seconds) * 1000);
}

/** minsync children of `parentPid` from `ps -A -o pid=,ppid=,time=,comm=`. */
export function parsePsOutput(output: string, parentPid: number): MinSyncProcess[] {
	const found: MinSyncProcess[] = [];
	for (const line of output.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
		if (match === null || Number(match[2]) !== parentPid || basename(match[4] ?? "") !== "minsync") continue;
		const cpuMs = parseCpuTime(match[3] ?? "");
		if (cpuMs !== null) found.push({ pid: Number(match[1]), cpuMs });
	}
	return found;
}

/** `tasklist /FO CSV /NH /V` rows for minsync.exe (Windows lists no parent, so every minsync is ours to watch). */
export function parseTasklistCsv(output: string): MinSyncProcess[] {
	const found: MinSyncProcess[] = [];
	for (const line of output.split(/\r?\n/u)) {
		const cells = line.match(/"([^"]*)"/gu)?.map((cell) => cell.slice(1, -1));
		if (cells === undefined || cells[0]?.toLowerCase() !== "minsync.exe") continue;
		const cpuMs = parseCpuTime(cells[7] ?? "");
		if (cpuMs !== null) found.push({ pid: Number(cells[1]), cpuMs });
	}
	return found;
}

const run = promisify(execFile);

/** The minsync children this process started, with their CPU time. An unreadable listing is no children. */
export async function sampleMinSyncProcesses(): Promise<MinSyncProcess[]> {
	try {
		if (process.platform === "win32") {
			const { stdout } = await run("tasklist", ["/FO", "CSV", "/NH", "/V", "/FI", "IMAGENAME eq minsync.exe"], { windowsHide: true });
			return parseTasklistCsv(stdout);
		}
		const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,time=,comm="]);
		return parsePsOutput(stdout, process.pid);
	} catch {
		return [];
	}
}

export interface StallWatchdogOptions {
	readonly sample: () => Promise<readonly MinSyncProcess[]>;
	readonly kill: (pid: number) => void;
	readonly stallMs: number;
	readonly intervalMs: number;
	readonly now?: () => number;
	/** Processes that idle by design (the embedding daemon) and must never count as stuck. */
	readonly exempt?: (pid: number) => boolean;
}

export interface StallWatchdog {
	/** One observation; the timer calls it, tests call it directly. */
	tick(): Promise<void>;
	start(): void;
	stop(): void;
	/** How many stuck children have been killed. */
	killed(): number;
}

export function createStallWatchdog(options: StallWatchdogOptions): StallWatchdog {
	const now = options.now ?? Date.now;
	const seen = new Map<number, { cpuMs: number; since: number }>();
	const killedPids = new Set<number>();
	let timer: NodeJS.Timeout | null = null;

	const tick = async (): Promise<void> => {
		const processes = await options.sample();
		const at = now();
		const live = new Set(processes.map((entry) => entry.pid));
		for (const pid of [...seen.keys()]) if (!live.has(pid)) seen.delete(pid);
		for (const { pid, cpuMs } of processes) {
			const previous = seen.get(pid);
			if (previous === undefined || previous.cpuMs !== cpuMs) {
				seen.set(pid, { cpuMs, since: at });
				continue;
			}
			if (options.exempt?.(pid) === true || at - previous.since < options.stallMs || killedPids.has(pid)) continue;
			killedPids.add(pid);
			options.kill(pid);
		}
	};

	return {
		tick,
		start: () => {
			if (timer !== null) return;
			timer = setInterval(() => void tick().catch(() => undefined), options.intervalMs);
			timer.unref();
		},
		stop: () => {
			clearInterval(timer ?? undefined);
			timer = null;
		},
		killed: () => killedPids.size,
	};
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

/** The watchdog the refresh uses: real process listing, SIGTERM. */
export function createMinSyncWatchdog(stallMs: number = DEFAULT_EMBEDDING_STALL_MS): StallWatchdog {
	return createStallWatchdog({
		sample: sampleMinSyncProcesses,
		exempt: isEmbeddingDaemonPid,
		kill: (pid) => {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// Already gone.
			}
		},
		stallMs,
		intervalMs: POLL_INTERVAL_MS,
	});
}

/** Extra attempts after the watchdog killed a stuck embedder. Parsed mirrors are incremental, so a retry only repeats the embedding. */
export const EMBEDDING_STALL_RETRIES = 2;

/**
 * Run `attempt` under `watchdog`. When it did not succeed and the watchdog
 * killed a stuck child during it, the attempt is repeated, up to `retries`
 * more times. A failure the watchdog did not cause is returned as is.
 */
export async function runWithStallRetry<T>(
	attempt: () => Promise<T>,
	succeeded: (value: T) => boolean,
	watchdog: StallWatchdog,
	retries: number,
): Promise<{ readonly value: T; readonly retries: number }> {
	watchdog.start();
	try {
		for (let used = 0; ; used += 1) {
			const killedBefore = watchdog.killed();
			const value = await attempt();
			if (succeeded(value) || watchdog.killed() === killedBefore || used >= retries) return { value, retries: used };
		}
	} finally {
		watchdog.stop();
	}
}
