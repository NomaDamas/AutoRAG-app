import { describe, expect, it } from "vitest";
import {
	createStallWatchdog,
	type MinSyncProcess,
	parseCpuTime,
	parsePsOutput,
	parseTasklistCsv,
	runWithStallRetry,
	stallWatchedProcesses,
} from "../src/main/minsync-watchdog";

describe("parseCpuTime", () => {
	it("reads the formats ps and tasklist print", () => {
		expect(parseCpuTime("0:01.50")).toBe(1500);
		expect(parseCpuTime("1:02:03.25")).toBe(3_723_250);
		expect(parseCpuTime("00:00:07")).toBe(7000);
		expect(parseCpuTime("1-02:03:04")).toBe(93_784_000);
		expect(parseCpuTime("garbage")).toBeNull();
	});
});

describe("process listings", () => {
	it("keeps only minsync children of the given parent", () => {
		const ps = [
			"  100     1  0:00.10 /usr/bin/other",
			"  200   100  0:12.00 /Users/x/.cargo/bin/minsync",
			"  201   999  0:30.00 /Users/x/.cargo/bin/minsync",
			"  202   100  0:00.50 /bin/zsh",
		].join("\n");

		expect(parsePsOutput(ps, 100)).toEqual([{ pid: 200, cpuMs: 12_000 }]);
	});

	it("reads tasklist CSV rows for minsync.exe", () => {
		const csv = '"minsync.exe","4321","Console","1","52,000 K","Running","DESKTOP\\u","0:00:42","N/A"\r\n';

		expect(parseTasklistCsv(csv)).toEqual([{ pid: 4321, cpuMs: 42_000 }]);
	});

	it("reads which minsync subcommand a child runs, wherever its executable sits", () => {
		const ps = [
			"  200   100  0:00.02 /Users/x/.cargo/bin/minsync stage --state-dir /tmp/a b/stage",
			"  201   100  0:12.00 /Users/x/.cargo/bin/minsync sync --full --format json --progress jsonl",
			"  202   100  0:00.01 /Applications/Dazzi Test.app/Contents/Resources/tools/bin/minsync serve --quiet",
			"  203   100  0:00.01 /Users/x/.cargo/bin/minsync",
			"  204   100  0:00.01 /Users/x/bin/minsync-helper stage",
		].join("\n");

		expect(parsePsOutput(ps, 100)).toEqual([
			{ pid: 200, cpuMs: 20, subcommand: "stage" },
			{ pid: 201, cpuMs: 12_000, subcommand: "sync" },
			{ pid: 202, cpuMs: 10, subcommand: "serve" },
			{ pid: 203, cpuMs: 10 },
		]);
	});

	it("leaves the parse step's stage child out of what the stall watchdog judges", () => {
		const listing: MinSyncProcess[] = [
			{ pid: 200, cpuMs: 20, subcommand: "stage" },
			{ pid: 201, cpuMs: 12_000, subcommand: "sync" },
			{ pid: 4321, cpuMs: 42_000 },
		];

		expect(stallWatchedProcesses(listing).map((entry) => entry.pid)).toEqual([201, 4321]);
	});

	it("an idle stage child survives the stall window while an idle sync child is killed", async () => {
		let clock = 0;
		const killed: number[] = [];
		const listing: MinSyncProcess[] = [
			{ pid: 200, cpuMs: 20, subcommand: "stage" },
			{ pid: 201, cpuMs: 9_000, subcommand: "sync" },
		];
		const watchdog = createStallWatchdog({
			sample: async () => stallWatchedProcesses(listing),
			kill: (pid) => void killed.push(pid),
			stallMs: 5000,
			intervalMs: 1000,
			now: () => clock,
		});

		await watchdog.tick();
		clock += 6000;
		await watchdog.tick();

		expect(killed).toEqual([201]);
	});
});

describe("createStallWatchdog", () => {
	function harness(stallMs: number) {
		let clock = 0;
		let cpu = 1000;
		let alive = true;
		const killed: number[] = [];
		const watchdog = createStallWatchdog({
			sample: async () => (alive ? [{ pid: 7, cpuMs: cpu }] : []),
			kill: (pid) => void killed.push(pid),
			stallMs,
			intervalMs: 1000,
			now: () => clock,
		});
		return {
			watchdog,
			killed,
			tick: async (advance: number, nextCpu?: number) => {
				clock += advance;
				if (nextCpu !== undefined) cpu = nextCpu;
				await watchdog.tick();
			},
			exit: () => void (alive = false),
		};
	}

	it("kills a child whose CPU time has not moved for the stall window", async () => {
		const h = harness(5000);

		await h.tick(0);
		await h.tick(4000);
		expect(h.killed).toEqual([]);
		await h.tick(1000);

		expect(h.killed).toEqual([7]);
		expect(h.watchdog.killed()).toBe(1);
	});

	it("never kills a process it was told to leave alone, such as the embedding daemon that idles by design", async () => {
		let clock = 0;
		const killed: number[] = [];
		const exempt = new Set([7]);
		const watchdog = createStallWatchdog({
			sample: async () => [{ pid: 7, cpuMs: 1000 }, { pid: 8, cpuMs: 1000 }],
			kill: (pid) => void killed.push(pid),
			stallMs: 5000,
			intervalMs: 1000,
			now: () => clock,
			exempt: (pid) => exempt.has(pid),
		});

		await watchdog.tick();
		clock += 6000;
		await watchdog.tick();

		expect(killed).toEqual([8]);
	});

	it("never kills a child that keeps burning CPU, however long it runs", async () => {
		const h = harness(5000);

		for (let step = 1; step <= 50; step += 1) await h.tick(4000, 1000 + step * 10);

		expect(h.killed).toEqual([]);
	});

	it("restarts the window when CPU time moves again", async () => {
		const h = harness(5000);

		await h.tick(0);
		await h.tick(4000);
		await h.tick(4000, 2000);
		await h.tick(4000);

		expect(h.killed).toEqual([]);
	});

	it("forgets a child that exited and does not kill it later", async () => {
		const h = harness(5000);

		await h.tick(0);
		h.exit();
		await h.tick(10_000);

		expect(h.killed).toEqual([]);
	});

	it("kills a stalled child once, not on every later tick", async () => {
		const h = harness(5000);

		await h.tick(0);
		await h.tick(5000);
		await h.tick(1000);
		await h.tick(1000);

		expect(h.killed).toEqual([7]);
	});
});

describe("runWithStallRetry", () => {
	function fakeWatchdog() {
		let killed = 0;
		return { tick: async () => undefined, start: () => undefined, stop: () => undefined, killed: () => killed, kill: () => void (killed += 1) };
	}

	it("retries when a stuck child was killed and the attempt failed, then returns the success", async () => {
		const dog = fakeWatchdog();
		const outcomes = [false, true];
		const attempt = async (): Promise<boolean> => {
			const ok = outcomes.shift() ?? true;
			if (!ok) dog.kill();
			return ok;
		};

		const result = await runWithStallRetry(attempt, (ok) => ok, dog, 2);

		expect(result).toEqual({ value: true, retries: 1 });
	});

	it("does not retry a failure the watchdog did not cause", async () => {
		const dog = fakeWatchdog();
		let calls = 0;

		const result = await runWithStallRetry(async () => (calls += 1, false), (ok) => ok, dog, 2);

		expect(calls).toBe(1);
		expect(result).toEqual({ value: false, retries: 0 });
	});

	it("gives up after the retry budget and returns the last failure", async () => {
		const dog = fakeWatchdog();
		let calls = 0;
		const attempt = async (): Promise<boolean> => {
			calls += 1;
			dog.kill();
			return false;
		};

		const result = await runWithStallRetry(attempt, (ok) => ok, dog, 2);

		expect(calls).toBe(3);
		expect(result).toEqual({ value: false, retries: 2 });
	});

	it("stops the watchdog even when the attempt throws", async () => {
		let stopped = false;
		const dog = { ...fakeWatchdog(), stop: () => void (stopped = true) };

		await expect(runWithStallRetry(async () => Promise.reject(new Error("x")), () => true, dog, 2)).rejects.toThrow("x");

		expect(stopped).toBe(true);
	});

	it("retries when the killed child made the attempt throw, as the parse step's stage session does", async () => {
		const dog = fakeWatchdog();
		let calls = 0;
		const attempt = async (): Promise<string> => {
			calls += 1;
			if (calls === 1) {
				dog.kill();
				throw new Error("MinSync stage session ended (signal SIGTERM).");
			}
			return "parsed";
		};

		const result = await runWithStallRetry(attempt, () => true, dog, 2);

		expect(result).toEqual({ value: "parsed", retries: 1 });
	});

	it("throws a failure the watchdog did not cause on the first attempt", async () => {
		const dog = fakeWatchdog();
		let calls = 0;

		await expect(runWithStallRetry(async () => (calls += 1, Promise.reject(new Error("disk full"))), () => true, dog, 2)).rejects.toThrow("disk full");

		expect(calls).toBe(1);
	});

	it("throws the last error once the retry budget is spent", async () => {
		const dog = fakeWatchdog();
		let calls = 0;
		const attempt = async (): Promise<string> => {
			calls += 1;
			dog.kill();
			throw new Error(`session ended ${calls}`);
		};

		await expect(runWithStallRetry(attempt, () => true, dog, 2)).rejects.toThrow("session ended 3");

		expect(calls).toBe(3);
	});
});
