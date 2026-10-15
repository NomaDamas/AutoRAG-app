import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJobWatchdog, JOB_STALL_MS, latestModification, progressFiles } from "../src/main/job-watchdog";
import { terminateMinSyncChildren } from "../src/main/minsync-watchdog";

const MIN = 60_000;
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function harness(overrides: { stallMs?: number; hardMaxMs?: number } = {}) {
	let clock = 10_000_000;
	let signal = 0;
	const expired: Array<{ reason: string; idleMs: number }> = [];
	const watchdog = createJobWatchdog({
		latestSignal: () => signal,
		onExpire: (reason, idleMs) => void expired.push({ reason, idleMs }),
		now: () => clock,
		...overrides,
	});
	return {
		watchdog,
		expired,
		advance: (ms: number) => {
			clock += ms;
			watchdog.tick();
		},
		// A file changed; the timer's next poll sees it.
		touch: () => {
			signal = clock;
			watchdog.tick();
		},
	};
}

describe("createJobWatchdog", () => {
	it("does not abandon a run that keeps producing progress, however long it takes", () => {
		const h = harness({ stallMs: 30 * MIN });

		for (let step = 0; step < 20 * 12; step += 1) {
			h.touch();
			h.advance(5 * MIN);
		}

		expect(h.expired).toEqual([]);
	});

	it("abandons a run whose progress files have gone quiet for the stall window", () => {
		const h = harness({ stallMs: 30 * MIN });

		h.touch();
		h.advance(29 * MIN);
		expect(h.expired).toEqual([]);
		h.advance(2 * MIN);

		expect(h.expired).toEqual([{ reason: "stalled", idleMs: 31 * MIN }]);
	});

	it("restarts the window whenever a file changes", () => {
		const h = harness({ stallMs: 30 * MIN });

		h.advance(25 * MIN);
		h.touch();
		h.advance(25 * MIN);

		expect(h.expired).toEqual([]);
	});

	it("stops a run that is still active at the hard ceiling", () => {
		const h = harness({ stallMs: 30 * MIN, hardMaxMs: 3 * 60 * MIN });

		for (let minute = 0; minute < 3 * 60; minute += 5) {
			h.touch();
			h.advance(5 * MIN);
		}

		expect(h.expired.map((entry) => entry.reason)).toEqual(["ceiling"]);
	});

	it("expires once", () => {
		const h = harness({ stallMs: 10 * MIN });

		h.advance(11 * MIN);
		h.advance(11 * MIN);

		expect(h.expired).toHaveLength(1);
	});

	it("allows a stall window long enough for a mirror checkpoint of slow files", () => {
		expect(JOB_STALL_MS).toBeGreaterThan(25 * 3 * MIN);
	});
});

describe("progress files", () => {
	it("reports the newest modification and ignores files not written yet", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "autorag-job-watchdog-"));
		directories.push(workspace);
		const [progress, parsed] = progressFiles(workspace);
		await mkdir(join(workspace, ".autorag", "parsed"), { recursive: true });
		await writeFile(progress as string, "{}");
		await writeFile(parsed as string, "{}");
		await utimes(progress as string, 1000, 1000);
		await utimes(parsed as string, 5000, 5000);

		expect(latestModification(progressFiles(workspace))).toBe(5_000_000);
		expect(latestModification([join(workspace, "missing")])).toBe(0);
	});
});

describe("terminateMinSyncChildren", () => {
	it("signals every minsync child and counts them", async () => {
		const killed: number[] = [];

		const stopped = await terminateMinSyncChildren(async () => [{ pid: 7, cpuMs: 1 }, { pid: 8, cpuMs: 1 }], (pid) => void killed.push(pid), "darwin");

		expect(killed).toEqual([7, 8]);
		expect(stopped).toBe(2);
	});

	it("skips a child that is already gone", async () => {
		const stopped = await terminateMinSyncChildren(
			async () => [{ pid: 7, cpuMs: 1 }, { pid: 8, cpuMs: 1 }],
			(pid) => {
				if (pid === 7) throw new Error("ESRCH");
			},
			"linux",
		);

		expect(stopped).toBe(1);
	});

	it("never kills on Windows, where a minsync cannot be told from the user's own", async () => {
		const killed: number[] = [];

		expect(await terminateMinSyncChildren(async () => [{ pid: 7, cpuMs: 1 }], (pid) => void killed.push(pid), "win32")).toBe(0);
		expect(killed).toEqual([]);
	});
});
