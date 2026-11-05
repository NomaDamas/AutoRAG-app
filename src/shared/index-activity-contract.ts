import type { IndexProgressSnapshot } from "./index-progress-contract";

/**
 * What the app is indexing right now: the local-folder refresh (parsed mirror →
 * MinSync → Jikji …) and every datasource sync, whoever started it — this app,
 * the OS-scheduled background job, or `autorag watch` outside the app.
 */

export const INDEX_ACTIVITY_CHANNELS = {
	get: "indexActivity:get",
	changed: "indexActivity:changed",
} as const;

/** Phases the librarian's `refresh()` reports in `refresh-progress.json`, in run order. */
export const INDEX_ACTIVITY_PHASES = ["parsed", "minsync", "datasources", "jikji", "everything", "fsearch", "finalizing"] as const;
export type IndexActivityPhase = (typeof INDEX_ACTIVITY_PHASES)[number];

export type IndexActivityItemState = "queued" | "running" | "done" | "failed";

/** Who started the work: this app, its OS-scheduled job, or a process the app does not own. */
export type IndexActivityOrigin = "app" | "scheduled" | "external";

export interface IndexActivityCounts {
	readonly scanned: number;
	readonly written: number;
	readonly deleted: number;
	readonly skipped: number;
}

export interface IndexActivityItem {
	/** `local` for the folder refresh, `source:<id>` for a datasource. */
	readonly key: string;
	readonly kind: "local" | "source";
	/** Datasource id; `null` for the local folders. */
	readonly id: string | null;
	readonly state: IndexActivityItemState;
	/** Librarian phase of the local refresh while it runs; `null` for a datasource (its sync reports none). */
	readonly phase: IndexActivityPhase | null;
	/** Parsed-mirror result of the local refresh, once its parse phase finished. */
	readonly counts: IndexActivityCounts | null;
	readonly error: string | null;
}

export interface IndexActivitySnapshot {
	/**
	 * `done` / `failed` describe the last run this app saw end; they stay until the
	 * next run starts, and the renderer decides how long to show them.
	 */
	readonly state: "idle" | "running" | "done" | "failed";
	readonly origin: IndexActivityOrigin | null;
	readonly startedAt: string | null;
	readonly finishedAt: string | null;
	readonly items: readonly IndexActivityItem[];
	/**
	 * Bar position, 0..1; `null` = indeterminate (something runs but nothing it
	 * reports says how far). Counts finished items plus the measured part of the
	 * local refresh's stage (see `progress`); nothing here is filled by elapsed time.
	 */
	readonly fraction: number | null;
	/**
	 * Stage-by-stage counts, bytes, remaining time and liveness of the local refresh while it
	 * runs; `null` when no local refresh is running. Onboarding shows the same shape.
	 */
	readonly progress: IndexProgressSnapshot | null;
	readonly error: string | null;
}

export const IDLE_INDEX_ACTIVITY: IndexActivitySnapshot = {
	state: "idle",
	origin: null,
	startedAt: null,
	finishedAt: null,
	items: [],
	fraction: null,
	progress: null,
	error: null,
};

export interface IndexActivityBridge {
	get(): Promise<IndexActivitySnapshot>;
	/** Pushed whenever the snapshot changes; returns the unsubscribe. */
	onChange(listener: (snapshot: IndexActivitySnapshot) => void): () => void;
}
