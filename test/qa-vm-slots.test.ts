import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSlotPool, ownerAlive } from "../scripts/qa-vm/slots.mjs";

/**
 * The VM slot pool caps concurrent macOS VMs across every checkout on the
 * machine. These cover what callers depend on: the cap, reclaiming a crashed
 * run's slot, never reclaiming a live one, and one winner per slot across
 * real processes.
 */
// The pool drives macOS VMs and reads process state through `ps`, which Windows lacks.
describe.skipIf(process.platform === "win32")("qa-vm slot pool", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "qa-slots-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("hands out at most `capacity` slots, lowest index first, and refuses the next caller", () => {
		const pool = createSlotPool({ dir, isAlive: () => true });
		const first = pool.acquire({ capacity: 2, owner: { vm: "a" } });
		const second = pool.acquire({ capacity: 2, owner: { vm: "b" } });
		expect([first?.index, second?.index]).toEqual([0, 1]);
		expect(pool.acquire({ capacity: 2, owner: { vm: "c" } })).toBeNull();
	});

	it("frees a slot on release so the next caller takes it", () => {
		const pool = createSlotPool({ dir, isAlive: () => true });
		const first = pool.acquire({ capacity: 1, owner: { vm: "a" } });
		expect(pool.acquire({ capacity: 1, owner: { vm: "b" } })).toBeNull();
		first?.release();
		expect(pool.acquire({ capacity: 1, owner: { vm: "b" } })?.index).toBe(0);
	});

	it("never offers a slot at or above a capacity lowered by VMs running outside the pool", () => {
		const pool = createSlotPool({ dir, isAlive: () => true });
		expect(pool.acquire({ capacity: 0, owner: { vm: "a" } })).toBeNull();
		expect(pool.acquire({ capacity: 1, owner: { vm: "a" } })?.index).toBe(0);
		expect(pool.acquire({ capacity: 1, owner: { vm: "b" } })).toBeNull();
	});

	it("reclaims a slot whose owner died and reports that owner so its VM can be destroyed", () => {
		const reaped: unknown[] = [];
		const crashed = createSlotPool({ dir, pid: 111, isAlive: () => true });
		crashed.acquire({ capacity: 2, owner: { vm: "autorag-qa-run-dead" } });

		const pool = createSlotPool({ dir, isAlive: (owner: { pid: number }) => owner.pid !== 111, onReap: (owner) => reaped.push(owner) });
		const slot = pool.acquire({ capacity: 1, owner: { vm: "autorag-qa-run-new" } });

		expect(slot?.index).toBe(0);
		expect(reaped).toEqual([expect.objectContaining({ vm: "autorag-qa-run-dead", pid: 111 })]);
		expect(pool.holders().map((holder) => holder.owner?.vm)).toEqual(["autorag-qa-run-new"]);
	});

	it("leaves a live owner's slot alone", () => {
		const reaped: unknown[] = [];
		const live = createSlotPool({ dir, pid: 222, isAlive: () => true });
		live.acquire({ capacity: 1, owner: { vm: "keep" } });
		const pool = createSlotPool({ dir, isAlive: () => true, onReap: (owner) => reaped.push(owner) });

		pool.reapStale();

		expect(pool.acquire({ capacity: 1, owner: { vm: "other" } })).toBeNull();
		expect(reaped).toEqual([]);
		expect(pool.holders()).toHaveLength(1);
	});

	it("puts a slot back when it comes back to life between the staleness check and the reclaim", () => {
		// The staleness decision spans a `ps` call, so another process can re-take
		// the slot in that window. The reclaim re-verifies after the rename and
		// must restore a live run's slot, not delete it and report its VM.
		const reaped: unknown[] = [];
		mkdirSync(join(dir, "slot-0"));
		writeFileSync(join(dir, "slot-0", "owner.json"), JSON.stringify({ pid: 42, vm: "live-vm" }));
		let checks = 0;
		const pool = createSlotPool({ dir, isAlive: () => ++checks > 1, onReap: (owner) => reaped.push(owner) });

		pool.reapStale();

		expect(reaped).toEqual([]);
		expect(pool.holders().map((holder) => holder.owner?.vm)).toEqual(["live-vm"]);
	});

	it("gives a slot that is still being created a grace period, then treats it as abandoned", () => {
		let clock = Date.now();
		const pool = createSlotPool({ dir, isAlive: () => true, now: () => clock, graceMs: 10_000 });
		const path = join(dir, "slot-0");
		mkdirSync(path);
		utimesSync(path, new Date(clock), new Date(clock));

		expect(pool.acquire({ capacity: 1, owner: { vm: "a" } })).toBeNull();
		clock += 11_000;
		expect(pool.acquire({ capacity: 1, owner: { vm: "a" } })?.index).toBe(0);
	});

	it("does not delete a slot that was reclaimed and handed to someone else after the original owner's release", () => {
		const slow = createSlotPool({ dir, pid: 333, isAlive: () => true });
		const stale = slow.acquire({ capacity: 1, owner: { vm: "slow" } });
		const successor = createSlotPool({ dir, isAlive: (owner: { pid: number }) => owner.pid !== 333 });
		const taken = successor.acquire({ capacity: 1, owner: { vm: "successor" } });
		expect(taken?.owner.vm).toBe("successor");

		stale?.release();

		expect(successor.holders().map((holder) => holder.owner?.vm)).toEqual(["successor"]);
	});

	it("ignores unrelated files in the slot directory", () => {
		writeFileSync(join(dir, "notes.txt"), "x");
		const pool = createSlotPool({ dir, isAlive: () => true });
		pool.acquire({ capacity: 2, owner: { vm: "a" } });
		expect(pool.holders()).toHaveLength(1);
	});

	it("lets exactly `capacity` of many concurrent processes win a slot", async () => {
		const moduleUrl = pathToFileURL(join(process.cwd(), "scripts", "qa-vm", "slots.mjs")).href;
		const source = `
			import { createSlotPool } from ${JSON.stringify(moduleUrl)};
			const slot = createSlotPool({ dir: process.argv[1] }).acquire({ capacity: 2, owner: { vm: "child" } });
			console.log(slot === null ? "lost" : "won");
			process.stdin.resume();
		`;
		const children = Array.from({ length: 6 }, () => spawn(process.execPath, ["--input-type=module", "-e", source, dir], { stdio: ["pipe", "pipe", "inherit"] }));
		try {
			const outcomes = await Promise.all(
				children.map((child) => {
					const { promise, resolve, reject } = Promise.withResolvers<string>();
					child.once("error", reject);
					child.stdout?.once("data", (chunk) => resolve(String(chunk).trim()));
					return promise;
				}),
			);
			expect(outcomes.filter((outcome) => outcome === "won")).toHaveLength(2);
			expect(outcomes.filter((outcome) => outcome === "lost")).toHaveLength(4);
		} finally {
			for (const child of children) child.kill("SIGKILL");
		}
	});

	it("counts a killed process as dead even while its parent has not collected it (a zombie)", async () => {
		const closed = Promise.withResolvers<void>();
		const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
		child.once("close", () => closed.resolve());
		const pid = child.pid as number;
		const owner = { pid, procStart: execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim() };
		expect(ownerAlive(owner)).toBe(true);

		// Kill it, then read its state through a synchronous `ps` loop: the event loop
		// never runs, so this process cannot reap it and it stays a zombie.
		process.kill(pid, "SIGKILL");
		let stat = "";
		do {
			stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
		} while (!stat.startsWith("Z"));

		expect(ownerAlive(owner)).toBe(false);
		await closed.promise;
	});
});
