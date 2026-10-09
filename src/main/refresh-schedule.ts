import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConfigRefreshResult, DataSourceSyncResult, ScheduledRunRecord } from "../shared/settings-contract";
import { isJsonObject } from "../shared/settings-contract";
import { LIVE_QUERY_TEMPLATES } from "./datasource-index-probe";
import { acquireRefreshLock, isLockHeld, type RefreshLockHolder } from "./refresh-lock";

/** The shortest cadence the UI offers; also the floor for a hand-edited config. */
export const MIN_REFRESH_INTERVAL_MS = 5 * 60_000;
/** The job never sleeps longer than this between wake-ups, so a due item waits at most this long. */
export const MAX_WAKE_INTERVAL_MS = 30 * 60_000;

export interface SchedulePlan {
	/** How often the local folders refresh; `null` = manual only. */
	readonly localIntervalMs: number | null;
	readonly sources: readonly { readonly id: string; readonly intervalMs: number }[];
}

export interface ScheduleState {
	readonly version: 1;
	readonly lastTickAt: string | null;
	readonly local: ScheduledRunRecord | null;
	readonly sources: Readonly<Record<string, ScheduledRunRecord>>;
}

export interface SchedulePaths {
	readonly dir: string;
	readonly lock: string;
	readonly state: string;
	readonly log: string;
}

/** Everything the app and the background job persist lives beside the shared config, so both resolve the same files. */
export function schedulePaths(configPath: string): SchedulePaths {
	const dir = join(dirname(configPath), "app-refresh");
	return { dir, lock: join(dir, "refresh.lock"), state: join(dir, "state.json"), log: join(dir, "job.log") };
}

function positiveInterval(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.max(MIN_REFRESH_INTERVAL_MS, Math.floor(value)) : null;
}

/**
 * What the config asks to refresh automatically. A datasource joins only when
 * it is enabled and carries an explicit `pollingIntervalMs`; one with no value
 * is manual, so connecting a source never starts background syncing by itself.
 */
export function readSchedulePlan(raw: Record<string, unknown>): SchedulePlan {
	const appIndexing = isJsonObject(raw.appIndexing) ? raw.appIndexing : {};
	const sources: { id: string; intervalMs: number }[] = [];
	const datasources = isJsonObject(raw.datasources) ? raw.datasources : {};
	for (const [id, entry] of Object.entries(datasources)) {
		if (!isJsonObject(entry) || entry.enabled === false) continue;
		const type = typeof entry.type === "string" ? entry.type : id;
		if (LIVE_QUERY_TEMPLATES.has(type)) continue;
		const intervalMs = positiveInterval(entry.pollingIntervalMs);
		if (intervalMs !== null) sources.push({ id, intervalMs });
	}
	return { localIntervalMs: positiveInterval(appIndexing.refreshIntervalMs), sources };
}

/** How often the OS job wakes up: the shortest wanted cadence, capped so due work never waits long. `null` = no job needed. */
export function wakeIntervalMs(plan: SchedulePlan): number | null {
	const all = [...(plan.localIntervalMs === null ? [] : [plan.localIntervalMs]), ...plan.sources.map((source) => source.intervalMs)];
	if (all.length === 0) return null;
	return Math.min(MAX_WAKE_INTERVAL_MS, Math.min(...all));
}

export function emptyScheduleState(): ScheduleState {
	return { version: 1, lastTickAt: null, local: null, sources: {} };
}

function runRecord(value: unknown): ScheduledRunRecord | null {
	if (!isJsonObject(value)) return null;
	if (typeof value.at !== "string" || typeof value.ok !== "boolean" || typeof value.durationMs !== "number") return null;
	return {
		at: value.at,
		ok: value.ok,
		error: typeof value.error === "string" ? value.error : null,
		durationMs: value.durationMs,
		detail: typeof value.detail === "string" ? value.detail : null,
	};
}

export function readScheduleState(path: string): ScheduleState {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return emptyScheduleState();
	}
	if (!isJsonObject(parsed)) return emptyScheduleState();
	const sources: Record<string, ScheduledRunRecord> = {};
	if (isJsonObject(parsed.sources)) {
		for (const [id, value] of Object.entries(parsed.sources)) {
			const record = runRecord(value);
			if (record !== null) sources[id] = record;
		}
	}
	return {
		version: 1,
		lastTickAt: typeof parsed.lastTickAt === "string" ? parsed.lastTickAt : null,
		local: runRecord(parsed.local),
		sources,
	};
}

/**
 * Run `work` while holding the shared refresh lock, so a manual refresh and a
 * scheduled tick never run at once. When another run owns the lock, `onBusy`
 * builds the result instead of waiting.
 */
export async function withRefreshLock<T>(lockPath: string, owner: string, work: () => Promise<T>, onBusy: (holder: RefreshLockHolder) => T): Promise<T> {
	const lock = acquireRefreshLock(lockPath, { owner });
	if (isLockHeld(lock)) return onBusy(lock.heldBy);
	try {
		return await work();
	} finally {
		lock.release();
	}
}

export function writeScheduleState(path: string, state: ScheduleState): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
	renameSync(temporary, path);
}

/** A wake-up that lands a hair before the interval elapsed still counts, so a drifting timer never skips a whole cycle. */
function elapsed(record: ScheduledRunRecord | null | undefined, intervalMs: number, now: number): boolean {
	if (record === null || record === undefined) return true;
	const at = Date.parse(record.at);
	if (Number.isNaN(at)) return true;
	return now - at >= intervalMs - Math.min(60_000, intervalMs / 10);
}

export function dueItems(plan: SchedulePlan, state: ScheduleState, now: number): { readonly local: boolean; readonly sourceIds: readonly string[] } {
	return {
		local: plan.localIntervalMs !== null && elapsed(state.local, plan.localIntervalMs, now),
		sourceIds: plan.sources.filter((source) => elapsed(state.sources[source.id], source.intervalMs, now)).map((source) => source.id),
	};
}

export interface ScheduledRunDeps {
	readonly paths: SchedulePaths;
	readonly readRaw: () => Record<string, unknown>;
	readonly refreshLocal: () => Promise<ConfigRefreshResult>;
	readonly syncSource: (id: string) => Promise<DataSourceSyncResult>;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
	readonly owner?: string;
}

export type ScheduledRunOutcome =
	| { readonly kind: "ran"; readonly local: boolean; readonly sourceIds: readonly string[]; readonly failures: number }
	| { readonly kind: "idle" }
	| { readonly kind: "locked"; readonly heldBy: RefreshLockHolder };

function localDetail(result: ConfigRefreshResult): string {
	return `스캔 ${result.scanned} · 기록 ${result.written} · 삭제 ${result.deleted} · 건너뜀 ${result.skipped}`;
}

function sourceDetail(result: DataSourceSyncResult): string {
	return result.chunkCount === null ? result.state : `${result.state} · ${result.chunkCount.toLocaleString()}개`;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * One wake-up of the background job: read the config, work out what is due,
 * refresh exactly that under the shared lock, and record each outcome. The same
 * lock guards the Settings button, so a manual run and a tick never overlap.
 */
export async function runScheduledRefresh(deps: ScheduledRunDeps): Promise<ScheduledRunOutcome> {
	const now = deps.now ?? Date.now;
	const log = deps.log ?? (() => undefined);
	const plan = readSchedulePlan(deps.readRaw());
	const before = readScheduleState(deps.paths.state);
	const due = dueItems(plan, before, now());
	if (!due.local && due.sourceIds.length === 0) return { kind: "idle" };

	const lock = acquireRefreshLock(deps.paths.lock, { owner: deps.owner ?? "scheduled-job", now });
	if (isLockHeld(lock)) {
		log(`skip: another refresh (${lock.heldBy.owner}, pid ${lock.heldBy.pid}) is running`);
		return { kind: "locked", heldBy: lock.heldBy };
	}
	let failures = 0;
	let state = before;
	const save = (next: ScheduleState): void => {
		state = next;
		writeScheduleState(deps.paths.state, state);
	};
	try {
		save({ ...state, lastTickAt: new Date(now()).toISOString() });
		if (due.local) {
			const startedAt = now();
			let record: ScheduledRunRecord;
			try {
				const result = await deps.refreshLocal();
				record = { at: new Date(now()).toISOString(), ok: result.ok, error: result.error, durationMs: now() - startedAt, detail: localDetail(result) };
			} catch (error) {
				record = { at: new Date(now()).toISOString(), ok: false, error: message(error), durationMs: now() - startedAt, detail: null };
			}
			if (!record.ok) failures += 1;
			log(`local ${record.ok ? "ok" : "fail"} ${record.detail ?? ""} ${record.error ?? ""}`.trim());
			save({ ...state, local: record });
		}
		for (const id of due.sourceIds) {
			const startedAt = now();
			let record: ScheduledRunRecord;
			try {
				const result = await deps.syncSource(id);
				record = { at: new Date(now()).toISOString(), ok: result.ok, error: result.error, durationMs: now() - startedAt, detail: sourceDetail(result) };
			} catch (error) {
				record = { at: new Date(now()).toISOString(), ok: false, error: message(error), durationMs: now() - startedAt, detail: null };
			}
			if (!record.ok) failures += 1;
			log(`source ${id} ${record.ok ? "ok" : "fail"} ${record.detail ?? ""} ${record.error ?? ""}`.trim());
			save({ ...state, sources: { ...state.sources, [id]: record } });
		}
	} finally {
		lock.release();
	}
	return { kind: "ran", local: due.local, sourceIds: due.sourceIds, failures };
}
