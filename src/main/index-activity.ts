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
import { computeIndexProgress, EMPTY_RATE_HISTORY } from "../shared/index-progress";
import type { IndexProgressSnapshot } from "../shared/index-progress-contract";
import { isJsonObject } from "../shared/settings-contract";
import { readActivity, type ActivityRecord } from "./index-activity-journal";
import { createIndexProgressTracker, type IndexProgressTracker } from "./index-progress-tracker";
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

export interface ProgressMinsyncView {
	readonly synced?: number;
	readonly total?: number;
	readonly filesSkipped?: number;
}

export interface ProgressView {
	readonly state: "running" | "success" | "failed";
	readonly phase: IndexActivityPhase | null;
	readonly pid: number;
	readonly runId: string | null;
	readonly startedAt: string;
	/** Last write of the file (ms precision ISO): the librarian and MinSync rewrite it every few seconds while they work. */
	readonly updatedAt: string | null;
	readonly finishedAt: string | null;
	readonly sourceTotal: number | null;
	readonly counts: IndexActivityCounts | null;
	readonly minsync: ProgressMinsyncView | null;
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
	const rawSource = parsed.sourceFiles;
	const sourceTotal = isJsonObject(rawSource) && typeof rawSource.total === "number" ? rawSource.total : null;
	const raw = parsed.parsedCounts;
	const counts =
		isJsonObject(raw) && typeof raw.scanned === "number" && typeof raw.written === "number" && typeof raw.deleted === "number" && typeof raw.skipped === "number"
			? { scanned: raw.scanned, written: raw.written, deleted: raw.deleted, skipped: raw.skipped }
			: null;
	const rawMinsync = parsed.minsync;
	const minsync: ProgressMinsyncView | null = isJsonObject(rawMinsync)
		? {
				...(typeof rawMinsync.synced === "number" ? { synced: rawMinsync.synced } : {}),
				...(typeof rawMinsync.total === "number" ? { total: rawMinsync.total } : {}),
				...(typeof rawMinsync.filesSkipped === "number" ? { filesSkipped: rawMinsync.filesSkipped } : {}),
			}
		: null;
	return {
		state,
		phase,
		pid,
		runId: typeof parsed.runId === "string" ? parsed.runId : null,
		startedAt,
		updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
		finishedAt: typeof parsed.finishedAt === "string" ? parsed.finishedAt : null,
		sourceTotal,
		counts,
		minsync,
		error: typeof parsed.error === "string" ? parsed.error : null,
	};
}

export interface DeriveInput {
	readonly progress: ProgressView | null;
	readonly journal: ActivityRecord | null;
	/**
	 * The tracker's reading of the running local refresh (progress file, MinSync's journal, earlier polls).
	 * Without it the snapshot is measured from the progress file alone.
	 */
	readonly detail?: IndexProgressSnapshot | null;
	/** False when semantic search is off (keyword-only): MinSync builds a keyword index, not embeddings. Default true. */
	readonly embedding?: boolean;
	readonly now: number;
	readonly alive: (pid: number) => boolean;
	/** Pids of this app's own processes (main, fs worker); a refresh from any other pid is external. */
	readonly ownPids: readonly number[];
}

function time(iso: string | null): number {
	const value = iso === null ? Number.NaN : Date.parse(iso);
	return Number.isNaN(value) ? 0 : value;
}

/** Measured from the progress file alone, for a caller that keeps no history between polls. */
function measureFromFile(progress: ProgressView, embedding: boolean, now: number): IndexProgressSnapshot {
	return computeIndexProgress(
		{
			state: "running",
			phase: progress.phase,
			embedding,
			sourceTotal: progress.sourceTotal,
			parsed: progress.counts,
			minsync: progress.minsync,
			journal: null,
			heartbeatAt: time(progress.updatedAt) || null,
			now,
		},
		EMPTY_RATE_HISTORY,
	).snapshot;
}

/**
 * Bar position: finished items plus the measured part of the local refresh. `null` (indeterminate) while the local
 * refresh is in a stage that cannot be measured, or while a datasource sync is the only thing running: neither says
 * how far along it is, and a number invented for them would sit still for as long as they take.
 */
function fractionOf(items: readonly IndexActivityItem[], detail: IndexProgressSnapshot | null): number | null {
	const finished = items.filter((item) => item.state === "done" || item.state === "failed").length;
	const local = items.find((item) => item.kind === "local" && item.state === "running");
	if (local === undefined) return finished === 0 ? null : Math.min(1, finished / items.length);
	if (detail === null || detail.indeterminate) return null;
	return Math.min(1, (finished + detail.fraction) / items.length);
}

function originOf(journal: ActivityRecord | null, progress: ProgressView | null, ownPids: readonly number[]): IndexActivityOrigin {
	if (journal !== null) return journal.owner === "scheduled-job" ? "scheduled" : "app";
	return progress !== null && ownPids.includes(progress.pid) ? "app" : "external";
}

/** Pure merge of the two files into the snapshot the UI shows; time and process liveness are inputs so it tests without a clock. */
export function deriveIndexActivity(input: DeriveInput): IndexActivitySnapshot {
	const { progress, journal, now, alive, ownPids } = input;
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
		const detail = progressRunning ? (input.detail ?? measureFromFile(progress, input.embedding !== false, now)) : null;
		return {
			state: "running",
			origin: originOf(journalLive ? journal : null, progress, ownPids),
			startedAt: journalLive ? journal.startedAt : (progress?.startedAt ?? null),
			finishedAt: null,
			items,
			fraction: fractionOf(items, detail),
			progress: detail,
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
		progress: null,
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
	/** Whether semantic search is on; false is keyword-only. Re-read when the config file changes. Default true. */
	readonly semanticSearch?: () => boolean;
	readonly pollMs?: number;
	readonly now?: () => number;
	/** Reads the progress files into stage counts; the app passes none and gets its own. */
	readonly tracker?: IndexProgressTracker;
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
	const tracker = deps.tracker ?? createIndexProgressTracker({ now });
	let current: IndexActivitySnapshot = IDLE_INDEX_ACTIVITY;
	let workspace: { readonly signature: string; readonly path: string | null; readonly semantic: boolean } = { signature: "", path: null, semantic: true };

	function semanticSearch(): boolean {
		try {
			return deps.semanticSearch?.() ?? true;
		} catch {
			// An unreadable config says nothing about the switch; the default stays on.
			return true;
		}
	}

	/** The workspace and the semantic-search switch, both from the config file and both re-read only when it changes. */
	async function workspaceConfig(): Promise<{ readonly path: string | null; readonly semantic: boolean }> {
		const info = await stat(deps.configPath()).catch(() => null);
		const signature = info === null ? "missing" : `${info.mtimeMs}:${info.size}`;
		if (signature !== workspace.signature) {
			workspace = { signature, path: await deps.resolveWorkspacePath().catch(() => null), semantic: semanticSearch() };
		}
		return workspace;
	}

	async function poll(): Promise<IndexActivitySnapshot> {
		const { path: root, semantic } = await workspaceConfig();
		const text = root === null ? null : readLibrarianFile(join(root, ".autorag", "refresh-progress.json"));
		const progress = text === null ? null : parseRefreshProgress(text);
		// Only a refresh whose process is alive has a run to follow; a dead one's file is the past.
		const live = progress !== null && progress.state === "running" && processAlive(progress.pid);
		const detail = root === null ? null : tracker.poll(root, live ? progress : null, { embedding: semantic });
		current = deriveIndexActivity({
			progress,
			journal: readActivity(deps.journalPath()),
			detail,
			embedding: semantic,
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
