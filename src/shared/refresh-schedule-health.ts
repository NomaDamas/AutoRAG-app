/**
 * Pure health assessment of the OS-scheduled background refresh job.
 *
 * Shared by the main-process periodic monitor and the Notification Center so
 * both judge "is automatic refresh actually working?" with the same rules:
 *  - `not-registered`: the config wants periodic refresh, the OS supports it,
 *    and no OS job is installed right now (e.g. a plist was unloaded/deleted).
 *  - `overdue`: the job is installed, not paused by `refresh.schedule`, and the
 *    last tick (or the oldest scheduled item) is well past its cadence — the
 *    OS stopped firing the job or it keeps failing before recording state.
 *  - `failing`: the job is ticking, but one or more currently scheduled items
 *    failed on their latest automatic run.
 *  - `conflicts`: another scheduled job on this machine also refreshes AutoRAG
 *    while Dazzi's own schedule is active.
 *
 * Nothing is reported while everything is manual (`!wanted`) or while the
 * platform has no scheduler (`!supported`).
 */

import type { RefreshScheduleStatus, ScheduledRunRecord } from "./settings-contract";

export type RefreshScheduleHealthIssueKind = "not-registered" | "overdue" | "failing" | "conflicts";

export interface RefreshScheduleFailingItem {
	/** `"local"` for local folders, or the datasource id. */
	readonly id: string;
	readonly kind: "local" | "source";
	readonly at: string;
	readonly error: string | null;
}

export interface RefreshScheduleHealthIssue {
	readonly kind: RefreshScheduleHealthIssueKind;
	/** Stable signature for Notification Center's "hide until changed" state. */
	readonly signature: string;
	readonly tone: "error" | "warning";
	/** Epoch ms of the most relevant event, when one exists. */
	readonly at: number | null;
	/** Overdue: minutes since the last tick (null if it has never ticked). */
	readonly overdueMinutes?: number | null;
	/** Failing: the scheduled items whose latest automatic run failed. */
	readonly failing?: readonly RefreshScheduleFailingItem[];
	/** Conflicts: descriptions of the other AutoRAG jobs found on this machine. */
	readonly conflicts?: readonly string[];
	/** Error reported by the scheduler itself (e.g. launchctl/schtasks failure). */
	readonly error?: string | null;
}

/**
 * Grace floor before declaring an installed job overdue. A job waking every
 * 5 min should not trigger a false alarm after a single sleep/wake cycle; we
 * wait at least 3× the wake interval and at least 2 hours before warning.
 */
export const OVERDUE_MIN_MS = 2 * 60 * 60_000;
export const OVERDUE_INTERVAL_MULTIPLIER = 3;

export function overdueThresholdMs(intervalMs: number): number {
	return Math.max(OVERDUE_MIN_MS, intervalMs * OVERDUE_INTERVAL_MULTIPLIER);
}

/**
 * Evaluate the current scheduler status and return the active health issues
 * that deserve user attention in the Notification Center.
 */
export function evaluateRefreshScheduleHealth(
	status: RefreshScheduleStatus | null | undefined,
	now: number = Date.now(),
): readonly RefreshScheduleHealthIssue[] {
	if (status === null || status === undefined || !status.supported || !status.wanted) {
		return [];
	}

	const issues: RefreshScheduleHealthIssue[] = [];

	// 1. Registered job missing (or scheduler query/install error)
	if (!status.installed || status.error !== null) {
		issues.push({
			kind: "not-registered",
			signature: `not-registered:${status.error ?? "missing"}`,
			tone: "error",
			at: status.lastTickAt !== null && !Number.isNaN(Date.parse(status.lastTickAt)) ? Date.parse(status.lastTickAt) : null,
			error: status.error,
		});
	} else if (status.paused === null && status.intervalMs !== null && status.lastTickAt !== null) {
		// 2. Installed and not paused, yet hasn't ticked for well over its wake interval.
		// Never flag `lastTickAt === null`: a newly scheduled job has not had its first tick yet.
		const lastMs = Date.parse(status.lastTickAt);
		if (!Number.isNaN(lastMs)) {
			const ageMs = now - lastMs;
			if (ageMs >= overdueThresholdMs(status.intervalMs)) {
				const overdueMinutes = Math.max(1, Math.round(ageMs / 60_000));
				issues.push({
					kind: "overdue",
					// Keyed by lastTickAt so hiding it stays hidden until a tick actually happens (or a different tick stalls).
					signature: `overdue:${status.lastTickAt}`,
					tone: "warning",
					at: lastMs,
					overdueMinutes,
				});
			}
		}
	}

	// 3. Scheduled items whose newest automatic run failed.
	// Only inspect currently scheduled items (when `scheduledSourceIds` is provided) so an old failure
	// for a datasource that was later set back to manual or removed does not nag forever.
	const failing: RefreshScheduleFailingItem[] = [];
	const pushIfFailed = (kind: "local" | "source", id: string, record: ScheduledRunRecord | null | undefined): void => {
		if (record === null || record === undefined || record.ok) return;
		failing.push({ id, kind, at: record.at, error: record.error });
	};
	if (status.localScheduled !== false) {
		pushIfFailed("local", "local", status.local);
	}
	const activeSourceIds = status.scheduledSourceIds ?? Object.keys(status.sources);
	for (const id of activeSourceIds) {
		pushIfFailed("source", id, status.sources[id]);
	}
	if (failing.length > 0) {
		failing.sort((a, b) => a.id.localeCompare(b.id));
		const newestAt = failing.reduce<number | null>((acc, item) => {
			const parsed = Date.parse(item.at);
			if (Number.isNaN(parsed)) return acc;
			return acc === null ? parsed : Math.max(acc, parsed);
		}, null);
		issues.push({
			kind: "failing",
			signature: `failing:${failing.map((item) => `${item.id}@${item.at}:${item.error ?? ""}`).join("|")}`,
			tone: "warning",
			at: newestAt,
			failing,
		});
	}

	// 4. Conflicting external AutoRAG refresh jobs on this machine.
	if (status.conflicts.length > 0) {
		const sorted = [...status.conflicts].sort();
		issues.push({
			kind: "conflicts",
			signature: `conflicts:${sorted.join("|")}`,
			tone: "warning",
			at: null,
			conflicts: sorted,
		});
	}

	return issues;
}
