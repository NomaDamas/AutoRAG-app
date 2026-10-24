import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
	IDLE_INDEX_ACTIVITY,
	INDEX_ACTIVITY_PHASES,
	type IndexActivityCounts,
	type IndexActivityItem,
	type IndexActivityOrigin,
	type IndexActivityPhase,
	type IndexActivitySnapshot,
} from "../shared/index-activity-contract";
import { isJsonObject } from "../shared/settings-contract";
import { readActivity, type ActivityRecord } from "./index-activity-journal";
import { readLibrarianFile } from "./librarian-file";

/**
 * One view of "what is indexing right now", merged from the three places that
 * know:
 *  - `<workspace>/.autorag/refresh-progress.json`: the librarian's own record of
 *    a `refresh()` — written by this app, the scheduled job and `autorag watch`.
 *    It carries the phase and (after parsing) the file counts, nothing finer.
 *  - `<config dir>/app-refresh/activity.json`: the plan of whoever holds the
 *    refresh lock, which is the only place a datasource sync is visible
 *    (`skill.index()` reports no progress at all).
 * Both are judged live by `pid`, never by `updatedAt`: a phase can run for
 * minutes without touching the file.
 */

/** How long a finished run stays visible before the display clears. */
export const DONE_LINGER_MS = 4_000;
/** A failure stays longer: the user has to be able to read it. */
export const FAILED_LINGER_MS = 15_000;

/**
 * Where each librarian phase starts on the local item's bar. The librarian
 * reports phases, not per-file totals, so this is a stage estimate that follows
 * the first-run screen's split (read 0–50, vector index 50–90).
 */
const PHASE_START: Readonly<Record<IndexActivityPhase, number>> = {
	parsed: 0,
	minsync: 0.5,
	datasources: 0.9,
	jikji: 0.93,
	everything: 0.95,
	fsearch: 0.97,
	finalizing: 0.99,
};

export interface ProgressView {
	readonly state: "running" | "success" | "failed";
	readonly phase: IndexActivityPhase | null;
	readonly pid: number;
	readonly startedAt: string;
	readonly finishedAt: string | null;
	readonly counts: IndexActivityCounts | null;
	readonly error: string | null;
}

export function parseRefreshProgress(text: string): ProgressView | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isJsonObject(parsed)) return null;
	const { state, pid, startedAt } = parsed;
	if ((state !== "running" && state !== "success" && state !== "failed") || typeof pid !== "number" || typeof startedAt !== "string") return null;
	const phase = INDEX_ACTIVITY_PHASES.find((candidate) => candidate === parsed.phase) ?? null;
	const raw = parsed.parsedCounts;
	const counts =
		isJsonObject(raw) && typeof raw.scanned === "number" && typeof raw.written === "number" && typeof raw.deleted === "number" && typeof raw.skipped === "number"
			? { scanned: raw.scanned, written: raw.written, deleted: raw.deleted, skipped: raw.skipped }
			: null;
	return {
		state,
		phase,
		pid,
		startedAt,
		finishedAt: typeof parsed.finishedAt === "string" ? parsed.finishedAt : null,
		counts,
		error: typeof parsed.error === "string" ? parsed.error : null,
	};
}

export interface DeriveInput {
	readonly progress: ProgressView | null;
	readonly journal: ActivityRecord | null;
	/** Committed file count from `.autorag/minsync/.minsync/progress.jsonl` while MinSync runs. */
	readonly minsyncCommitted?: number;
	readonly now: number;
	readonly alive: (pid: number) => boolean;
	/** Pids of this app's own processes (main, fs worker); a refresh from any other pid is external. */
	readonly ownPids: readonly number[];
}

function time(iso: string | null): number {
	const value = iso === null ? Number.NaN : Date.parse(iso);
	return Number.isNaN(value) ? 0 : value;
}

function localFraction(phase: IndexActivityPhase | null, counts: IndexActivityCounts | null, minsyncCommitted = 0): number {
	if (phase === null) return 0;
	const base = PHASE_START[phase];
	if (phase === "minsync" && minsyncCommitted > 0 && counts !== null && counts.written > 0) {
		const span = PHASE_START.datasources - PHASE_START.minsync;
		return base + span * Math.min(1, minsyncCommitted / counts.written);
	}
	return base;
}

function fractionOf(items: readonly IndexActivityItem[], minsyncCommitted = 0): number | null {
	const finished = items.filter((item) => item.state === "done" || item.state === "failed").length;
	const local = items.find((item) => item.kind === "local" && item.state === "running");
	// A datasource sync reports nothing while it runs: with nothing finished and no local phase to read, the position is unknown.
	if (finished === 0 && (local === undefined || local.phase === null)) return null;
	const partial = local === undefined ? 0 : localFraction(local.phase, local.counts, minsyncCommitted);
	return Math.min(1, (finished + partial) / items.length);
}

function originOf(journal: ActivityRecord | null, progress: ProgressView | null, ownPids: readonly number[]): IndexActivityOrigin {
	if (journal !== null) return journal.owner === "scheduled-job" ? "scheduled" : "app";
	return progress !== null && ownPids.includes(progress.pid) ? "app" : "external";
}

/** Pure merge of the two files into the snapshot the UI shows; time and process liveness are inputs so it tests without a clock. */
export function deriveIndexActivity(input: DeriveInput): IndexActivitySnapshot {
	const { progress, journal, minsyncCommitted = 0, now, alive, ownPids } = input;
	const progressRunning = progress !== null && progress.state === "running" && alive(progress.pid);
	const journalLive = journal !== null && journal.finishedAt === null && alive(journal.pid);

	if (progressRunning || journalLive) {
		const items: IndexActivityItem[] = journalLive
			? journal.items.map((item) => ({
					key: item.key,
					kind: item.kind,
					id: item.id,
					state: item.state,
					phase: null,
					counts: null,
					error: item.error,
				}))
			: [];
		const localIndex = items.findIndex((item) => item.kind === "local");
		if (progressRunning) {
			const local: IndexActivityItem = {
				key: "local",
				kind: "local",
				id: null,
				state: "running",
				phase: progress.phase,
				counts: progress.counts,
				error: null,
			};
			if (localIndex < 0) items.unshift(local);
			else items[localIndex] = local;
		}
		return {
			state: "running",
			origin: originOf(journalLive ? journal : null, progress, ownPids),
			startedAt: journalLive ? journal.startedAt : (progress?.startedAt ?? null),
			finishedAt: null,
			items,
			fraction: fractionOf(items, minsyncCommitted),
			error: null,
		};
	}

	// Nothing live: what finished last, if it finished recently enough to still be news.
	const progressEnded = progress !== null && progress.state !== "running" ? time(progress.finishedAt) : 0;
	const journalEnded = journal !== null ? time(journal.finishedAt) : 0;
	const endedAt = Math.max(progressEnded, journalEnded);
	if (endedAt === 0) return IDLE_INDEX_ACTIVITY;

	const items: IndexActivityItem[] =
		journalEnded >= progressEnded && journal !== null
			? journal.items.map((item) => {
					// The librarian file belongs to this run only if it started inside it.
					const counts = item.kind === "local" && progress !== null && time(progress.startedAt) >= time(journal.startedAt) - 2_000 ? progress.counts : null;
					return { key: item.key, kind: item.kind, id: item.id, state: item.state, phase: null, counts, error: item.error };
				})
			: progress === null
				? []
				: [
						{
							key: "local",
							kind: "local",
							id: null,
							state: progress.state === "success" ? "done" : "failed",
							phase: null,
							counts: progress.counts,
							error: progress.error,
						},
					];
	const failed = items.find((item) => item.state === "failed");
	const state = failed === undefined ? "done" : "failed";
	if (now - endedAt > (state === "done" ? DONE_LINGER_MS : FAILED_LINGER_MS)) return IDLE_INDEX_ACTIVITY;
	const origin = journalEnded >= progressEnded ? originOf(journal, progress, ownPids) : originOf(null, progress, ownPids);
	return {
		state,
		origin,
		startedAt: journalEnded >= progressEnded && journal !== null ? journal.startedAt : (progress?.startedAt ?? null),
		finishedAt: new Date(endedAt).toISOString(),
		items,
		fraction: 1,
		error: failed?.error ?? null,
	};
}

export interface IndexActivityService {
	snapshot(): Promise<IndexActivitySnapshot>;
	/** Start watching; `onChange` fires only when the snapshot differs. Returns the stop function. */
	start(onChange: (snapshot: IndexActivitySnapshot) => void): () => void;
}

export interface IndexActivityDeps {
	readonly configPath: () => string;
	/** Where the librarian wrote `.autorag/refresh-progress.json`; re-resolved when the config file changes. */
	readonly resolveWorkspacePath: () => Promise<string>;
	readonly journalPath: () => string;
	readonly ownPids: () => readonly (number | null)[];
	readonly pollMs?: number;
	readonly now?: () => number;
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it exists, it is just not ours.
		return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
	}
}

export function createIndexActivityService(deps: IndexActivityDeps): IndexActivityService {
	const now = deps.now ?? Date.now;
	let current: IndexActivitySnapshot = IDLE_INDEX_ACTIVITY;
	let workspace: { readonly signature: string; readonly path: string | null } = { signature: "", path: null };

	async function workspacePath(): Promise<string | null> {
		const info = await stat(deps.configPath()).catch(() => null);
		const signature = info === null ? "missing" : `${info.mtimeMs}:${info.size}`;
		if (signature !== workspace.signature) {
			workspace = { signature, path: await deps.resolveWorkspacePath().catch(() => null) };
		}
		return workspace.path;
	}

	async function poll(): Promise<IndexActivitySnapshot> {
		const root = await workspacePath();
		const text = root === null ? null : readLibrarianFile(join(root, ".autorag", "refresh-progress.json"));
		const minsyncLog = root === null ? null : readLibrarianFile(join(root, ".autorag", "minsync", ".minsync", "progress.jsonl"));
		const minsyncLines = minsyncLog === null ? 0 : minsyncLog.split("\n").filter((line) => line.trim().length > 0).length;
		current = deriveIndexActivity({
			progress: text === null ? null : parseRefreshProgress(text),
			journal: readActivity(deps.journalPath()),
			minsyncCommitted: Math.max(0, minsyncLines - 1),
			now: now(),
			alive: processAlive,
			ownPids: [process.pid, ...deps.ownPids()].filter((pid): pid is number => pid !== null),
		});
		return current;
	}

	return {
		snapshot: poll,
		start: (onChange) => {
			let last = JSON.stringify(current);
			let busy = false;
			const timer = setInterval(() => {
				if (busy) return;
				busy = true;
				void poll()
					.then((next) => {
						const serialized = JSON.stringify(next);
						if (serialized === last) return;
						last = serialized;
						onChange(next);
					})
					.finally(() => {
						busy = false;
					});
			}, deps.pollMs ?? 1_000);
			timer.unref();
			return () => clearInterval(timer);
		},
	};
}
