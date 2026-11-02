import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { DEFAULT_FILEE_TIMEOUT_MS, FileeCliError, type FileeCliOptions, type FileeCliRun } from "@autorag/librarian";

/**
 * Runs filee-cli so that stopping it stops everything it started.
 *
 * Filee hands the work to ffmpeg, LibreOffice, Pandoc and friends. The
 * librarian's runner signals only the program it spawned, which leaves those
 * children running (reparented to init) and still writing into the folder the
 * caller is about to delete. Here the program leads its own process group
 * (POSIX) or is killed with `taskkill /t` (Windows), so one abort ends the
 * whole tree, and the promise settles only after the program is gone.
 */

/** How long the polite request (SIGTERM) gets before the tree is killed outright. */
const DEFAULT_KILL_GRACE_MS = 3000;

export interface FileeProcessOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly cwd?: string;
	/** Folder for Filee's settings and engines (`FILEE_DATA_DIR`). */
	readonly dataDir?: string;
	readonly killGraceMs?: number;
}

const live = new Set<ChildProcess>();
let exitHookInstalled = false;

function killTree(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
	const pid = child.pid;
	if (pid === undefined) return;
	if (process.platform === "win32") {
		spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		// The group is already gone, or the program never became its leader.
		try {
			child.kill(signal);
		} catch {
			// Already exited.
		}
	}
}

/** Quitting the app must not leave a conversion running on its own. */
function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.on("exit", () => {
		for (const child of live) killTree(child, "SIGKILL");
	});
}

export function runFileeProcess(executable: string, args: readonly string[], options: FileeProcessOptions = {}): Promise<FileeCliRun> {
	const { signal } = options;
	return new Promise<FileeCliRun>((resolveRun, reject) => {
		if (signal?.aborted) {
			reject(new FileeCliError("filee was aborted."));
			return;
		}
		const child = spawn(executable, [...args], {
			cwd: options.cwd,
			env: options.dataDir === undefined ? process.env : { ...process.env, FILEE_DATA_DIR: resolve(options.dataDir) },
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		live.add(child);
		installExitHook();

		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let settled = false;
		let stopping: string | null = null;
		let escalation: NodeJS.Timeout | undefined;

		const settle = (action: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(escalation);
			signal?.removeEventListener("abort", onAbort);
			live.delete(child);
			action();
		};
		const stop = (reason: string): void => {
			if (stopping !== null || settled) return;
			stopping = reason;
			killTree(child, "SIGTERM");
			escalation = setTimeout(() => killTree(child, "SIGKILL"), options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
		};
		const onAbort = (): void => stop("filee was aborted.");
		const timer = setTimeout(() => stop("filee timed out."), options.timeoutMs ?? DEFAULT_FILEE_TIMEOUT_MS);
		signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.once("error", (error) => settle(() => reject(new FileeCliError(`Unable to run filee: ${error.message}`))));
		// A stopped run settles when the program exits (its descendants may hold the pipes open, so
		// `close` can lag); whatever of the tree outlived it is swept first.
		child.once("exit", () => {
			if (stopping === null) return;
			killTree(child, "SIGKILL");
			const reason = stopping;
			settle(() => reject(new FileeCliError(reason)));
		});
		child.once("close", (code) =>
			settle(() =>
				resolveRun({
					stdout: Buffer.concat(stdout).toString("utf8"),
					stderr: Buffer.concat(stderr).toString("utf8"),
					exitCode: code ?? -1,
				}),
			),
		);
	});
}

/**
 * `options` with the librarian's spawn replaced by {@link runFileeProcess}, so
 * `convertWithFilee` / `listFileeFormats` keep their argument building and
 * result parsing but stop and time out the whole process tree.
 */
export function withTreeKillingRun(options: FileeCliOptions): FileeCliOptions {
	if (options.run !== undefined) return options;
	const executable = options.executable ?? "filee";
	return {
		...options,
		run: (args) =>
			runFileeProcess(executable, args, {
				...(options.signal === undefined ? {} : { signal: options.signal }),
				...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
				...(options.cwd === undefined ? {} : { cwd: options.cwd }),
				...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
			}),
	};
}
