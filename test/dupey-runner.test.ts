import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { scanWithDupey } from "@autorag/librarian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDuplicateScans } from "../src/fs-worker/librarian-dupey";
import {
	createDupeyRunner,
	DUPEY_KILL_GRACE_MS,
	DUPEY_TIMEOUT_MS,
	DupeyStoppedError,
	DupeyTimeoutError,
	joinExcludeDirValues,
} from "../src/main/dupey-runner";
import { isDupeyTimeout } from "../src/main/version-family-service";

interface FakeChild {
	readonly child: ChildProcess;
	/** Signals the runner sent, in order. */
	readonly signals: string[];
	/** The process leaves: `exit`, then `close` (both at once; fake timers would stall a deferred one), as Node reports it. */
	leave(code: number | null, signal?: NodeJS.Signals | null): void;
	stdout: PassThrough;
	stderr: PassThrough;
}

function fakeChild(pid: number | undefined = 4242): FakeChild {
	const emitter = new EventEmitter();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const signals: string[] = [];
	const child = Object.assign(emitter, {
		pid,
		stdout,
		stderr,
		kill: (signal?: NodeJS.Signals | number) => {
			signals.push(String(signal));
			return true;
		},
	}) as unknown as ChildProcess;
	return {
		child,
		signals,
		stdout,
		stderr,
		leave(code, signal = null) {
			emitter.emit("exit", code, signal);
			stdout.end();
			stderr.end();
			emitter.emit("close", code, signal);
		},
	};
}

/** A runner whose processes are the fakes, in the order they are started. */
function fakeRunner(options: { timeoutMs?: number; killGraceMs?: number } = {}) {
	const children: FakeChild[] = [];
	const started: { command: string; args: readonly string[]; options: unknown }[] = [];
	const runner = createDupeyRunner({
		...options,
		spawn: (command, args, spawnOptions) => {
			started.push({ command, args, options: spawnOptions });
			const next = fakeChild();
			children.push(next);
			return next.child;
		},
	});
	return { runner, children, started };
}

describe("dupey runner (fake processes)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("starts dupey with the arguments and resolves with its standard output", async () => {
		const { runner, children, started } = fakeRunner();

		const output = runner.run(["scan", "/data", "--json"]);
		children[0]?.stdout.write('{"files":[]}');
		children[0]?.leave(0);

		await expect(output).resolves.toBe('{"files":[]}');
		expect(started).toHaveLength(1);
		expect(started[0]?.command).toBe("dupey");
		expect(started[0]?.args).toEqual(["scan", "/data", "--json"]);
		expect(started[0]?.options).toMatchObject({ stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		expect(runner.running).toBe(0);
	});

	it("keeps a character that arrives split across two chunks whole", async () => {
		const { runner, children } = fakeRunner();
		const output = runner.run(["scan", "/data"]);
		const bytes = Buffer.from('{"path":"/데이터/한글.txt"}');
		// Cut inside the first Hangul syllable of the file name (3 bytes in UTF-8).
		const cut = bytes.indexOf(Buffer.from("한")) + 1;

		children[0]?.stdout.write(bytes.subarray(0, cut));
		children[0]?.stdout.write(bytes.subarray(cut));
		children[0]?.leave(0);

		await expect(output).resolves.toBe('{"path":"/데이터/한글.txt"}');
	});

	it("fails with dupey's exit code and what it printed to standard error", async () => {
		const { runner, children } = fakeRunner();
		const output = runner.run(["scan", "/data"]);
		const failed = expect(output).rejects.toThrow("dupey failed with exit code 2: no such directory");

		children[0]?.stderr.write("no such directory\n");
		children[0]?.leave(2);

		await failed;
	});

	it("fails when dupey cannot be started, and has nothing left to end", async () => {
		const { runner, children } = fakeRunner();
		const output = runner.run(["scan", "/data"]);
		const failed = expect(output).rejects.toThrow("Unable to run dupey: spawn dupey ENOENT");
		Object.assign(children[0]?.child ?? {}, { pid: undefined });

		children[0]?.child.emit("error", new Error("spawn dupey ENOENT"));

		await failed;
		expect(runner.running).toBe(0);
	});

	describe("the time limit", () => {
		it("fails the call at the limit with the time-out message, and asks dupey to end with SIGTERM", async () => {
			const { runner, children } = fakeRunner({ timeoutMs: 1000, killGraceMs: 5000 });
			const output = runner.run(["scan", "/data"]);
			const failed = output.catch((error: unknown) => error);

			await vi.advanceTimersByTimeAsync(999);
			expect(children[0]?.signals).toEqual([]);
			await vi.advanceTimersByTimeAsync(1);

			const error = await failed;
			expect(error).toBeInstanceOf(DupeyTimeoutError);
			expect(isDupeyTimeout((error as Error).message)).toBe(true);
			expect(children[0]?.signals).toEqual(["SIGTERM"]);
			// The process is still ours until it has left.
			expect(runner.running).toBe(1);
		});

		it("sends SIGKILL to a dupey that ignored SIGTERM once the grace has passed", async () => {
			const { runner, children } = fakeRunner({ timeoutMs: 1000, killGraceMs: 5000 });
			const failed = runner.run(["scan", "/data"]).catch(() => undefined);
			await vi.advanceTimersByTimeAsync(1000);
			expect(children[0]?.signals).toEqual(["SIGTERM"]);

			await vi.advanceTimersByTimeAsync(4999);
			expect(children[0]?.signals).toEqual(["SIGTERM"]);
			await vi.advanceTimersByTimeAsync(1);
			expect(children[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);

			children[0]?.leave(null, "SIGKILL");
			await failed;
			expect(runner.running).toBe(0);
		});

		it("does not send SIGKILL to a dupey that left on SIGTERM", async () => {
			const { runner, children } = fakeRunner({ timeoutMs: 1000, killGraceMs: 5000 });
			const failed = runner.run(["scan", "/data"]).catch(() => undefined);
			await vi.advanceTimersByTimeAsync(1000);

			children[0]?.leave(null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(10_000);

			await failed;
			expect(children[0]?.signals).toEqual(["SIGTERM"]);
			expect(vi.getTimerCount()).toBe(0);
		});

		it("leaves no timer behind after a scan that finished in time", async () => {
			const { runner, children } = fakeRunner({ timeoutMs: 1000 });
			const output = runner.run(["scan", "/data"]);
			children[0]?.leave(0);
			await output;

			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(children[0]?.signals).toEqual([]);
		});

		it("defaults to the librarian's 120 s limit and a 5 s grace", () => {
			expect(DUPEY_TIMEOUT_MS).toBe(120_000);
			expect(DUPEY_KILL_GRACE_MS).toBe(5_000);
		});
	});

	describe("shutdown", () => {
		it("ends every running dupey at once, fails their calls as stopped, and refuses new ones", async () => {
			const { runner, children, started } = fakeRunner();
			const first = runner.run(["scan", "/a"]).catch((error: unknown) => error);
			const second = runner.run(["scan", "/b"]).catch((error: unknown) => error);

			const shutdown = runner.shutdown({ graceMs: 500 });

			// SIGTERM goes out before anything is awaited: the thread may be terminated right after.
			expect(children.map((child) => child.signals)).toEqual([["SIGTERM"], ["SIGTERM"]]);
			for (const child of children) child.leave(null, "SIGTERM");
			await shutdown;

			const stopped = await first;
			expect(stopped).toBeInstanceOf(DupeyStoppedError);
			// A stop is not a time-out: it must never be remembered as one.
			expect(isDupeyTimeout((stopped as Error).message)).toBe(false);
			expect(await second).toBeInstanceOf(DupeyStoppedError);
			expect(runner.running).toBe(0);
			await expect(runner.run(["scan", "/c"])).rejects.toBeInstanceOf(DupeyStoppedError);
			expect(started).toHaveLength(2);
		});

		it("sends SIGKILL to a dupey that ignores SIGTERM, and returns once it has left", async () => {
			const { runner, children } = fakeRunner();
			const call = runner.run(["scan", "/a"]).catch(() => undefined);
			let done = false;

			const shutdown = runner.shutdown({ graceMs: 500 }).then(() => {
				done = true;
			});
			await vi.advanceTimersByTimeAsync(499);
			expect(children[0]?.signals).toEqual(["SIGTERM"]);
			await vi.advanceTimersByTimeAsync(1);
			expect(children[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
			expect(done).toBe(false);

			children[0]?.leave(null, "SIGKILL");
			await shutdown;
			await call;
			expect(done).toBe(true);
		});

		it("gives up waiting for a process that never reports leaving, after the grace and a short settle", async () => {
			const { runner } = fakeRunner();
			void runner.run(["scan", "/a"]).catch(() => undefined);
			let done = false;

			void runner.shutdown({ graceMs: 500 }).then(() => {
				done = true;
			});
			await vi.advanceTimersByTimeAsync(500);
			expect(done).toBe(false);
			await vi.advanceTimersByTimeAsync(250);

			expect(done).toBe(true);
			expect(runner.running).toBe(1);
		});

		it("shortens the grace of a dupey a time-out already sent SIGTERM to", async () => {
			const { runner, children } = fakeRunner({ timeoutMs: 1000, killGraceMs: 5000 });
			const failed = runner.run(["scan", "/a"]).catch(() => undefined);
			await vi.advanceTimersByTimeAsync(1000);
			expect(children[0]?.signals).toEqual(["SIGTERM"]);

			void runner.shutdown({ graceMs: 500 });
			await vi.advanceTimersByTimeAsync(500);

			// SIGKILL arrives 500 ms after the shutdown, not the 4 s the time-out's own grace had left.
			expect(children[0]?.signals).toEqual(["SIGTERM", "SIGTERM", "SIGKILL"]);
			children[0]?.leave(null, "SIGKILL");
			await failed;
		});

		it("returns at once when nothing is running", async () => {
			const { runner } = fakeRunner();

			await runner.shutdown();

			expect(vi.getTimerCount()).toBe(0);
		});

		it("lets a process `exit` handler kill every running dupey synchronously", async () => {
			const { runner, children } = fakeRunner();
			const call = runner.run(["scan", "/a"]).catch(() => undefined);

			runner.killAll();

			expect(children[0]?.signals).toEqual(["SIGKILL"]);
			children[0]?.leave(null, "SIGKILL");
			await call;
		});
	});
});

describe("joinExcludeDirValues", () => {
	it("turns each --exclude-dir and its name into one argument, so a name starting with a dash stays a value", () => {
		expect(joinExcludeDirValues(["scan", "/cloud", "--json", "--exclude-dir", "Docs", "--exclude-dir", "-archive"])).toEqual([
			"scan",
			"/cloud",
			"--json",
			"--exclude-dir=Docs",
			"--exclude-dir=-archive",
		]);
	});

	it("leaves arguments without the option alone, and a trailing option as it is", () => {
		expect(joinExcludeDirValues(["scan", "/cloud", "--json"])).toEqual(["scan", "/cloud", "--json"]);
		expect(joinExcludeDirValues(["scan", "--exclude-dir"])).toEqual(["scan", "--exclude-dir"]);
	});
});

describe("duplicate scans of the librarian thread", () => {
	it("runs the librarian's scan through the runner, with the excluded folders as =values", async () => {
		const { runner, children, started } = fakeRunner();
		const scans = createDuplicateScans({ scan: scanWithDupey, runner });

		const result = scans.scanDuplicates("/cloud", { excludeDirs: ["Docs", "-archive"] });
		await vi.waitFor(() => expect(children).toHaveLength(1));
		children[0]?.stdout.write(JSON.stringify({ dir: "/cloud", files: [], families: [], errors: [] }));
		children[0]?.leave(0);

		await expect(result).resolves.toMatchObject({ dir: "/cloud" });
		expect(started[0]?.args.slice(2)).toEqual(["--json", "--exclude-dir=Docs", "--exclude-dir=-archive"]);
	});

	it("stops the runner, and the scan in flight fails as stopped", async () => {
		const { runner, children } = fakeRunner();
		const scans = createDuplicateScans({ scan: scanWithDupey, runner });
		const result = scans.scanDuplicates("/cloud").catch((error: unknown) => error);
		await vi.waitFor(() => expect(children).toHaveLength(1));

		const stopping = scans.stop();
		children[0]?.leave(null, "SIGTERM");
		await stopping;

		expect(await result).toBeInstanceOf(DupeyStoppedError);
		expect(children[0]?.signals).toEqual(["SIGTERM"]);
	});
});

/** A node script standing in for dupey: it says it is ready (a file appears), then waits, optionally ignoring SIGTERM. */
const STAND_IN = (ignoreTerm: boolean): string => `
const { writeFileSync } = require("node:fs");
${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}
setInterval(() => {}, 1000);
writeFileSync(process.argv[1], String(process.pid));
`;

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function until(condition: () => boolean, label: string, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("dupey runner (real processes)", () => {
	const spawned: number[] = [];
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "dupey-runner-"));
	});

	afterEach(async () => {
		// A test that failed must not leave its stand-in running.
		for (const pid of spawned.splice(0)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
		await rm(dir, { recursive: true, force: true });
	});

	function realRunner(options: { timeoutMs?: number; killGraceMs?: number } = {}) {
		return createDupeyRunner({
			executable: process.execPath,
			...options,
			spawn: (command, args, spawnOptions) => {
				const child = spawn(command, [...args], spawnOptions);
				if (child.pid !== undefined) spawned.push(child.pid);
				return child;
			},
		});
	}

	it("ends a dupey that ignores SIGTERM with SIGKILL when the app shuts down", async () => {
		// SIGTERM cannot be ignored on Windows: the process is terminated outright, so there is no escalation to see.
		if (process.platform === "win32") return;
		const ready = join(dir, "ready");
		const runner = realRunner();
		const call = runner.run(["-e", STAND_IN(true), ready]).catch((error: unknown) => error);
		await until(() => existsSync(ready), "the stand-in to install its SIGTERM handler");
		const pid = spawned[0] as number;
		expect(alive(pid)).toBe(true);

		const started = Date.now();
		await runner.shutdown({ graceMs: 300 });

		expect(alive(pid)).toBe(false);
		// It survived the SIGTERM, so the SIGKILL came after the grace and not before.
		expect(Date.now() - started).toBeGreaterThanOrEqual(250);
		expect(await call).toBeInstanceOf(DupeyStoppedError);
		expect(runner.running).toBe(0);
	});

	it("ends a dupey that outlasts the time limit, and fails the call as a time-out", async () => {
		const ready = join(dir, "ready");
		const runner = realRunner({ timeoutMs: 1500, killGraceMs: 300 });

		const error = await runner.run(["-e", STAND_IN(false), ready]).catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(DupeyTimeoutError);
		const pid = spawned[0] as number;
		await until(() => !alive(pid), "the stand-in to be gone");
		expect(runner.running).toBe(0);
	});

	it("kills the dupey of a call that timed out, even if it ignores SIGTERM", async () => {
		if (process.platform === "win32") return;
		const ready = join(dir, "ready");
		const runner = realRunner({ timeoutMs: 1500, killGraceMs: 300 });

		const error = await runner.run(["-e", STAND_IN(true), ready]).catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(DupeyTimeoutError);
		const pid = spawned[0] as number;
		// SIGTERM was ignored; the SIGKILL 300 ms after it is what ends the process.
		await until(() => !alive(pid), "SIGKILL to end the stand-in");
		expect(runner.running).toBe(0);
	});

	const hasDupey = spawnSync("dupey", ["--version"], { stdio: "ignore" }).status === 0;

	it.skipIf(!hasDupey)("scans a real folder through the runner, leaving out a folder whose name starts with a dash", async () => {
		const same = "The quarterly report.\n".repeat(40);
		await mkdir(join(dir, "-archive"));
		await writeFile(join(dir, "a.txt"), same);
		await writeFile(join(dir, "b.txt"), same);
		await writeFile(join(dir, "-archive", "c.txt"), same);
		const runner = createDupeyRunner();
		const scans = createDuplicateScans({ scan: scanWithDupey, runner });

		const result = await scans.scanDuplicates(dir, { excludeDirs: ["-archive"] });

		expect(result.files.map((file) => file.path.split(/[\\/]/).pop()).sort()).toEqual(["a.txt", "b.txt"]);
		expect(result.families).toHaveLength(1);
		expect(runner.running).toBe(0);
	});
});
