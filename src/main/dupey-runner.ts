/**
 * The dupey processes the app starts for a scan, and the only code that starts them.
 *
 * `scanWithDupey` of the librarian spawns the CLI itself when it is given no `run`, and that spawn is nobody's to stop:
 * it is not tracked, its 120 s limit sends SIGTERM once and never SIGKILL, and nothing ends it when the thread that
 * called it is terminated. A scan of a cloud drive reads files the drive has to download first, so such a dupey can
 * outlive the app by tens of minutes with its parent gone (PPID 1). This runner is handed to `scanWithDupey` as its
 * `run`, so every scan's child is one the app can find, end, and wait for.
 *
 * No `electron` import: the runner lives in the librarian thread, like the rest of the fs worker.
 */

import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";

/** The librarian's own limit for one dupey call (`timeoutMs`), which a `run` of ours replaces. */
export const DUPEY_TIMEOUT_MS = 120_000;
/** How long a dupey that was sent SIGTERM may take to leave before it is sent SIGKILL. */
export const DUPEY_KILL_GRACE_MS = 5_000;
/** The same wait when the app is quitting: the worker is killed 2 s after the quit, so it must be short. */
export const DUPEY_SHUTDOWN_GRACE_MS = 500;
/** After SIGKILL, how long shutdown waits to hear the process left. A process stuck in the kernel may never. */
const KILL_SETTLE_MS = 250;

/** The scan outlasted its limit. The text is what `isDupeyTimeout` recognizes (`version-family-service.ts`), so keep it. */
export class DupeyTimeoutError extends Error {
	constructor() {
		super("dupey timed out.");
		this.name = "DupeyCliError";
	}
}

/**
 * The runner was shut down, or shut down while this call was running. It is not a time-out: a scan that ends this way
 * says nothing about the folder, so it must never be remembered as one.
 */
export class DupeyStoppedError extends Error {
	constructor() {
		super("dupey was stopped.");
		this.name = "DupeyCliError";
	}
}

export type DupeySpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface DupeyRunnerOptions {
	/** The CLI to start; a bare name is looked up on `PATH`. */
	readonly executable?: string;
	/** Longest one call may run before dupey is ended and the call fails with {@link DupeyTimeoutError}. */
	readonly timeoutMs?: number;
	/** How long a dupey asked to end by itself (SIGTERM) gets before it is killed (SIGKILL). */
	readonly killGraceMs?: number;
	/** Replaces `child_process.spawn`, for a test. */
	readonly spawn?: DupeySpawn;
}

export interface DupeyRunner {
	/** Runs dupey with `args` and resolves with its standard output. Fails with {@link DupeyStoppedError} after `shutdown`. */
	run(args: readonly string[]): Promise<string>;
	/** Processes started and not yet gone, including ones whose call already failed and that are being ended. */
	readonly running: number;
	/**
	 * Ends every running dupey (SIGTERM, then SIGKILL after `graceMs`) and refuses new calls. Calls still running fail
	 * with {@link DupeyStoppedError} at once. Resolves when the processes are gone, or after the wait the grace allows.
	 */
	shutdown(options?: { readonly graceMs?: number }): Promise<void>;
	/** SIGKILL for every running dupey, now and synchronously: what a process `exit` handler can still do. */
	killAll(): void;
}

/**
 * `scanWithDupey` passes a folder to leave out as two arguments, `--exclude-dir` then the name. clap takes a name that
 * starts with `-` as another option, so such a folder (`-archive`) failed the whole scan. `--exclude-dir=<name>` is
 * always a value.
 */
export function joinExcludeDirValues(args: readonly string[]): readonly string[] {
	const out: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] as string;
		const value = args[index + 1];
		if (arg === "--exclude-dir" && value !== undefined) {
			out.push(`--exclude-dir=${value}`);
			index += 1;
		} else {
			out.push(arg);
		}
	}
	return out;
}

interface Live {
	readonly exited: Promise<void>;
	/** SIGTERM now, SIGKILL after `graceMs` unless it has left by then. A second call shortens the wait. */
	terminate(graceMs: number): void;
	kill(): void;
	/** Fails the call that started this process, if it has not settled yet. */
	fail(error: Error): void;
}

/** Waits for `promise`, but not longer than `ms`. */
async function within(promise: Promise<unknown>, ms: number): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([promise, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
	} finally {
		clearTimeout(timer);
	}
}

export function createDupeyRunner(options: DupeyRunnerOptions = {}): DupeyRunner {
	const executable = options.executable ?? "dupey";
	const timeoutMs = options.timeoutMs ?? DUPEY_TIMEOUT_MS;
	const killGraceMs = options.killGraceMs ?? DUPEY_KILL_GRACE_MS;
	const start = options.spawn ?? spawn;
	const live = new Set<Live>();
	let stopped = false;

	function run(args: readonly string[]): Promise<string> {
		if (stopped) return Promise.reject(new DupeyStoppedError());
		return new Promise<string>((resolve, reject) => {
			const child = start(executable, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
			// Decoded as a stream: a Korean file name split across two chunks is not two broken characters.
			child.stdout?.setEncoding("utf8");
			child.stderr?.setEncoding("utf8");
			let stdout = "";
			let stderr = "";
			let settled = false;
			let gone = false;
			let killTimer: NodeJS.Timeout | undefined;
			const exited = Promise.withResolvers<void>();

			const settle = (finish: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(limit);
				finish();
			};
			const signal = (name: NodeJS.Signals): void => {
				try {
					child.kill(name);
				} catch {
					// Already gone; the exit event says so.
				}
			};
			const entry: Live = {
				exited: exited.promise,
				terminate(graceMs) {
					if (gone) return;
					clearTimeout(killTimer);
					signal("SIGTERM");
					killTimer = setTimeout(() => {
						if (!gone) signal("SIGKILL");
					}, graceMs);
				},
				kill() {
					if (!gone) signal("SIGKILL");
				},
				fail(error) {
					settle(() => reject(error));
				},
			};
			live.add(entry);

			const limit = setTimeout(() => {
				settle(() => reject(new DupeyTimeoutError()));
				// The call has failed; the process is still ours to end, and a SIGTERM it ignores is followed by SIGKILL.
				entry.terminate(killGraceMs);
			}, timeoutMs);

			child.stdout?.on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr?.on("data", (chunk: string) => {
				stderr += chunk;
			});
			// Not `once`: a failed `kill` raises `error` too, and an `error` nobody listens for throws.
			child.on("error", (error: Error) => {
				if (child.pid === undefined) {
					// It never started, so no exit event will follow.
					gone = true;
					clearTimeout(killTimer);
					live.delete(entry);
					exited.resolve();
				}
				settle(() => reject(new Error(`Unable to run dupey: ${error.message}`)));
			});
			child.once("exit", () => {
				gone = true;
				clearTimeout(killTimer);
				live.delete(entry);
				exited.resolve();
			});
			child.once("close", (code: number | null, closedBy: NodeJS.Signals | null) => {
				settle(() => {
					if (code === 0) {
						resolve(stdout);
						return;
					}
					const detail = stderr.trim();
					reject(new Error(`dupey failed with exit code ${code ?? closedBy ?? "unknown"}${detail ? `: ${detail}` : ""}`));
				});
			});
		});
	}

	return {
		run,
		get running() {
			return live.size;
		},
		async shutdown(shutdownOptions = {}) {
			stopped = true;
			const graceMs = shutdownOptions.graceMs ?? DUPEY_SHUTDOWN_GRACE_MS;
			const going = [...live];
			for (const entry of going) {
				entry.fail(new DupeyStoppedError());
				entry.terminate(graceMs);
			}
			await within(Promise.all(going.map((entry) => entry.exited)), graceMs + KILL_SETTLE_MS);
		},
		killAll() {
			stopped = true;
			for (const entry of [...live]) entry.kill();
		},
	};
}
