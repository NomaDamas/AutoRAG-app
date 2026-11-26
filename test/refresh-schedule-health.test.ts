import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefreshScheduleStatus } from "../src/shared/settings-contract";
import { evaluateRefreshScheduleHealth, OVERDUE_MIN_MS } from "../src/shared/refresh-schedule-health";
import { createRefreshScheduleMonitor } from "../src/main/refresh-schedule-monitor";
import type { RefreshScheduler } from "../src/main/refresh-scheduler";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-11-26T12:00:00.000Z");

function baseStatus(overrides: Partial<RefreshScheduleStatus> = {}): RefreshScheduleStatus {
	return {
		supported: true,
		mechanism: "launchd",
		installed: true,
		wanted: true,
		localScheduled: false,
		scheduledSourceIds: ["kakao", "slack"],
		intervalMs: 30 * MIN,
		lastTickAt: new Date(NOW - 20 * MIN).toISOString(),
		local: null,
		sources: {
			kakao: { at: new Date(NOW - 20 * MIN).toISOString(), ok: true, error: null, durationMs: 1200, detail: "indexed" },
			slack: { at: new Date(NOW - 20 * MIN).toISOString(), ok: true, error: null, durationMs: 800, detail: "indexed" },
		},
		paused: null,
		conflicts: [],
		error: null,
		...overrides,
	};
}

describe("evaluateRefreshScheduleHealth", () => {
	it("returns nothing when manual, unsupported, or healthy", () => {
		expect(evaluateRefreshScheduleHealth(null, NOW)).toEqual([]);
		expect(evaluateRefreshScheduleHealth(baseStatus({ supported: false }), NOW)).toEqual([]);
		expect(evaluateRefreshScheduleHealth(baseStatus({ wanted: false, installed: false }), NOW)).toEqual([]);
		expect(evaluateRefreshScheduleHealth(baseStatus(), NOW)).toEqual([]);
	});

	it("flags not-registered when wanted is true and OS job is missing or errored", () => {
		const missing = evaluateRefreshScheduleHealth(baseStatus({ installed: false }), NOW);
		expect(missing).toHaveLength(1);
		expect(missing[0]).toMatchObject({ kind: "not-registered", tone: "error", error: null });

		const errored = evaluateRefreshScheduleHealth(baseStatus({ installed: true, error: "launchctl failed" }), NOW);
		expect(errored).toHaveLength(1);
		expect(errored[0]).toMatchObject({ kind: "not-registered", tone: "error", error: "launchctl failed" });
	});

	it("flags overdue when installed and unpaused but lastTickAt is well past cadence", () => {
		const fresh = evaluateRefreshScheduleHealth(baseStatus({ lastTickAt: new Date(NOW - (OVERDUE_MIN_MS - MIN)).toISOString() }), NOW);
		expect(fresh).toEqual([]);

		const stalled = evaluateRefreshScheduleHealth(baseStatus({ lastTickAt: new Date(NOW - 4 * HOUR).toISOString() }), NOW);
		expect(stalled).toHaveLength(1);
		expect(stalled[0]).toMatchObject({ kind: "overdue", tone: "warning", overdueMinutes: 240 });

		// Paused by refresh.schedule (e.g. battery / time window) must not alarm as overdue.
		const paused = evaluateRefreshScheduleHealth(
			baseStatus({
				lastTickAt: new Date(NOW - 8 * HOUR).toISOString(),
				paused: { at: new Date(NOW - 10 * MIN).toISOString(), reason: "battery" },
			}),
			NOW,
		);
		expect(paused).toEqual([]);

		// Newly installed job that has never ticked yet is not overdue.
		const neverTicked = evaluateRefreshScheduleHealth(baseStatus({ lastTickAt: null }), NOW);
		expect(neverTicked).toEqual([]);
	});

	it("flags failing only for currently scheduled items, ignoring stale failures from unscheduled sources", () => {
		const status = baseStatus({
			localScheduled: false,
			scheduledSourceIds: ["kakao"],
			local: { at: new Date(NOW - 5 * HOUR).toISOString(), ok: false, error: "old local failure", durationMs: 10, detail: null },
			sources: {
				kakao: { at: new Date(NOW - 10 * MIN).toISOString(), ok: false, error: "timeout", durationMs: 5000, detail: "failed" },
				removedSource: { at: new Date(NOW - 10 * HOUR).toISOString(), ok: false, error: "gone", durationMs: 10, detail: "failed" },
			},
		});
		const issues = evaluateRefreshScheduleHealth(status, NOW);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.kind).toBe("failing");
		expect(issues[0]?.failing?.map((item) => item.id)).toEqual(["kakao"]);
	});

	it("flags conflicting external AutoRAG refresh jobs", () => {
		const issues = evaluateRefreshScheduleHealth(baseStatus({ conflicts: ["cron: watch-once.sh"] }), NOW);
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({ kind: "conflicts", tone: "warning", conflicts: ["cron: watch-once.sh"] });
	});
});

describe("createRefreshScheduleMonitor", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("auto-reconciles on startup when wanted is true and OS job is missing, and broadcasts status", async () => {
		const missing = baseStatus({ installed: false });
		const fixed = baseStatus({ installed: true });
		const scheduler: RefreshScheduler = {
			status: vi.fn().mockResolvedValue(missing),
			reconcile: vi.fn().mockResolvedValue(fixed),
			remove: vi.fn(),
		};
		const pushed: RefreshScheduleStatus[] = [];
		const monitor = createRefreshScheduleMonitor({ scheduler, onStatus: (s) => pushed.push(s), intervalMs: 5 * MIN });

		const stop = monitor.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(scheduler.reconcile).toHaveBeenCalledTimes(1);
		expect(pushed).toEqual([fixed]);
		stop();
	});

	it("does not reconcile when everything is manual and no job is installed", async () => {
		const manual = baseStatus({ wanted: false, installed: false, intervalMs: null, scheduledSourceIds: [] });
		const scheduler: RefreshScheduler = {
			status: vi.fn().mockResolvedValue(manual),
			reconcile: vi.fn(),
			remove: vi.fn(),
		};
		const pushed: RefreshScheduleStatus[] = [];
		const monitor = createRefreshScheduleMonitor({ scheduler, onStatus: (s) => pushed.push(s), intervalMs: 5 * MIN });

		const stop = monitor.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(scheduler.reconcile).not.toHaveBeenCalled();
		expect(pushed).toEqual([manual]);
		stop();
	});

	it("audits periodically and broadcasts only when status changes, self-healing if the job disappears mid-session", async () => {
		const healthy = baseStatus({ installed: true });
		const missing = baseStatus({ installed: false });
		const failedReconcile = baseStatus({ installed: false, error: "launchctl bootstrap failed" });
		const scheduler: RefreshScheduler = {
			status: vi.fn().mockResolvedValueOnce(healthy).mockResolvedValueOnce(healthy).mockResolvedValueOnce(missing),
			reconcile: vi.fn().mockResolvedValueOnce(healthy).mockResolvedValueOnce(failedReconcile),
			remove: vi.fn(),
		};
		const pushed: RefreshScheduleStatus[] = [];
		const monitor = createRefreshScheduleMonitor({ scheduler, onStatus: (s) => pushed.push(s), intervalMs: 5 * MIN, log: () => undefined });

		const stop = monitor.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(pushed).toEqual([healthy]);
		expect(scheduler.reconcile).toHaveBeenCalledTimes(1);

		// Second audit: still healthy -> no duplicate push and no extra reconcile
		await vi.advanceTimersByTimeAsync(5 * MIN);
		expect(pushed).toHaveLength(1);
		expect(scheduler.reconcile).toHaveBeenCalledTimes(1);

		// Third audit: job vanished -> attempts reconcile and pushes the resulting error status
		await vi.advanceTimersByTimeAsync(5 * MIN);
		expect(scheduler.reconcile).toHaveBeenCalledTimes(2);
		expect(pushed).toEqual([healthy, failedReconcile]);
		stop();
	});
});
