import { describe, expect, it, vi } from "vitest";
import { enteredLocalTrack, watchLocalTrack } from "../src/main/local-track";

interface Step {
	readonly id: string;
	readonly status: "running" | "done" | "failed";
	readonly detail?: string;
}
interface Snapshot {
	readonly active: boolean;
	readonly steps: readonly Step[];
}

const done = (id: string, detail?: string): Step => ({ id, status: "done", ...(detail === undefined ? {} : { detail }) });
const run = (...steps: Step[]): Snapshot => ({ active: true, steps });

describe("enteredLocalTrack", () => {
	it("is true once Jev routed the question to the local branch", () => {
		expect(enteredLocalTrack(run(done("route", "local")))).toBe(true);
	});

	it("is false while Jev is still deciding, and when the question went to a branch that never searches the index", () => {
		expect(enteredLocalTrack(run({ id: "route", status: "running" }))).toBe(false);
		for (const route of ["organize", "extra", "config"]) expect(enteredLocalTrack(run(done("route", route))), route).toBe(false);
		expect(enteredLocalTrack(run({ id: "route", status: "failed", detail: "offline" }))).toBe(false);
	});

	it("is true for every step only the local branch runs, so a run with no Jev route is caught too", () => {
		for (const id of ["datasource-select", "minsync", "jikji", "datasource:slack", "fast"]) expect(enteredLocalTrack(run({ id, status: "running" })), id).toBe(true);
	});

	it("is false before any step and for steps of a turn answered from the conversation", () => {
		expect(enteredLocalTrack(run())).toBe(false);
		expect(enteredLocalTrack(run({ id: "answer", status: "running" }))).toBe(false);
	});
});

/** The tracker's `subscribe` contract: notified after every change, not on subscribe. */
function fakeTracker() {
	const listeners = new Set<(snapshot: Snapshot) => void>();
	return {
		subscribe: (listener: (snapshot: Snapshot) => void) => {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		emit: (snapshot: Snapshot) => {
			for (const listener of [...listeners]) listener(snapshot);
		},
		size: () => listeners.size,
	};
}

describe("watchLocalTrack", () => {
	it("calls back once per run, however many changes follow the branch being taken", () => {
		const tracker = fakeTracker();
		const listener = vi.fn();
		watchLocalTrack({ searchProgress: tracker }, listener);

		tracker.emit({ active: true, steps: [] });
		tracker.emit(run({ id: "route", status: "running" }));
		expect(listener).not.toHaveBeenCalled();
		tracker.emit(run(done("route", "local")));
		tracker.emit(run(done("route", "local"), { id: "datasource-select", status: "running" }));
		tracker.emit(run(done("route", "local"), done("datasource-select", "none"), { id: "minsync", status: "running" }));
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("arms again for the next run, which begins with no steps", () => {
		const tracker = fakeTracker();
		const listener = vi.fn();
		watchLocalTrack({ searchProgress: tracker }, listener);

		tracker.emit(run(done("route", "local")));
		tracker.emit({ active: false, steps: [done("route", "local")] });
		tracker.emit({ active: true, steps: [] });
		tracker.emit(run(done("route", "local")));

		expect(listener).toHaveBeenCalledTimes(2);
	});

	it("stays quiet for a run Jev sent elsewhere", () => {
		const tracker = fakeTracker();
		const listener = vi.fn();
		watchLocalTrack({ searchProgress: tracker }, listener);

		tracker.emit(run(done("route", "organize")));
		tracker.emit({ active: false, steps: [done("route", "organize")] });

		expect(listener).not.toHaveBeenCalled();
	});

	it("stops listening when asked to", () => {
		const tracker = fakeTracker();
		const listener = vi.fn();
		const stop = watchLocalTrack({ searchProgress: tracker }, listener);

		stop();
		tracker.emit(run(done("route", "local")));

		expect(listener).not.toHaveBeenCalled();
		expect(tracker.size()).toBe(0);
	});

	it("does nothing, and does not throw, when the agent keeps no progress tracker", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const listener = vi.fn();

		expect(() => watchLocalTrack({}, listener)()).not.toThrow();
		expect(() => watchLocalTrack({ searchProgress: { subscribe: "nope" } }, listener)()).not.toThrow();

		expect(listener).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});
