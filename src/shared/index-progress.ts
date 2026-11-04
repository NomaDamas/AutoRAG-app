/**
 * The one computation behind every indexing progress display: the first-run
 * screen, the sidebar activity entry and Settings > Indexing.
 *
 * Rules it keeps:
 *  - Only measured completion moves a number. Elapsed time never fills a bar.
 *  - A stage counts one unit (files) from start to end, so `done` can never
 *    pass `total`; skipped and failed files are counted apart from `done`.
 *  - The estimate is the rate of the last {@link RATE_WINDOW_MS} of observed
 *    movement; with too little movement it says so instead of guessing.
 *  - While work remains the bar never reaches 95%: the last tenth belongs to the
 *    final stage, which cannot be measured and is drawn as indeterminate.
 *
 * It is a pure function of what the processes wrote down plus a small history
 * of earlier observations that the caller keeps between polls.
 */

import type { IndexActivityCounts, IndexActivityPhase } from "./index-activity-contract";
import {
	indexStagesFor,
	isFileCountStage,
	type IndexEtaState,
	type IndexProgressSnapshot,
	type IndexStageBytes,
	type IndexStageCounts,
	type IndexStageId,
	type IndexStageProgress,
	type IndexStageState,
} from "./index-progress-contract";

/** How far back the rate looks. Older movement says little about how fast the work goes now. */
export const RATE_WINDOW_MS = 10 * 60_000;
/** The rate needs at least this much observed time; shorter spans are noise. */
export const MIN_RATE_SPAN_MS = 60_000;
/** A new rate sample is stored at most this often while the count does not move. */
export const SAMPLE_EVERY_MS = 5_000;
/** No file finished for this long, with files left: "may be stalled". */
export const STALL_AFTER_MS = 10 * 60_000;

/** Where each stage sits on the whole-run bar. A layout choice, not a duration; a run has either the embedding or the keyword stage. */
const STAGE_SHARE: Readonly<Record<IndexStageId, number>> = { discover: 0, parse: 0.4, embed: 0.5, keyword: 0.5, finalize: 0.1 };

/** The stage MinSync's work shows up as: embedding the files, or building the keyword index when nothing is embedded. */
function isMinsyncStage(id: IndexStageId): boolean {
	return id === "embed" || id === "keyword";
}

/** What MinSync's `progress.jsonl` says so far (see `index-progress-journal.ts`). */
export interface MinsyncJournalTally {
	/** Files whose index entries are durable. */
	readonly committed: number;
	/** Files removed from the index because their source is gone. */
	readonly deleted: number;
	/** Files that failed and were left for the next run. */
	readonly failed: number;
	/** Bytes of the committed files; `null` when their sizes are not known. */
	readonly bytesDone: number | null;
	/** Display name of the file most recently written to the journal. */
	readonly lastFile: string | null;
	/** Modification time of the journal (ms): the last moment a file finished. */
	readonly modifiedAt: number | null;
}

export interface IndexProgressInput {
	readonly state: "running" | "success" | "failed";
	/** The librarian's phase from `refresh-progress.json`; `null` before the first one is written. */
	readonly phase: IndexActivityPhase | null;
	/** False for keyword-only indexing (semantic search off): MinSync builds a keyword index instead of embedding. Default true. */
	readonly embedding?: boolean;
	/** `sourceFiles.total`: how many files the read stage will go through, once the librarian has listed them. */
	readonly sourceTotal: number | null;
	readonly parsed: IndexActivityCounts | null;
	readonly minsync: { readonly synced?: number; readonly total?: number; readonly filesSkipped?: number } | null;
	readonly journal: MinsyncJournalTally | null;
	/** Bytes of every file MinSync's stage (embedding, or the keyword index) will go through, when known. */
	readonly embedBytesTotal?: number | null;
	/** Name of the file the read stage handled last (from the parsed mirror); MinSync's stage reads the journal's instead. */
	readonly parseFile?: string | null;
	/** `updatedAt` of `refresh-progress.json` (ms): MinSync rewrites it every few seconds while it works. */
	readonly heartbeatAt: number | null;
	readonly now: number;
}

export interface RateSample {
	readonly at: number;
	readonly done: number;
	readonly bytes: number | null;
}

/** What earlier polls observed about the running stage; owned by the caller and handed back each poll. */
export interface RateHistory {
	readonly stage: IndexStageId | null;
	/** When this stage was first seen running. */
	readonly since: number;
	readonly samples: readonly RateSample[];
	/** Files handled at the last poll. */
	readonly handled: number;
	/** When the handled count last rose (or the journal's own timestamp for work done before this app looked). */
	readonly lastCompletedAt: number | null;
}

export const EMPTY_RATE_HISTORY: RateHistory = { stage: null, since: 0, samples: [], handled: 0, lastCompletedAt: null };

export interface IndexProgressResult {
	readonly snapshot: IndexProgressSnapshot;
	readonly history: RateHistory;
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, value));
}

function nonNegative(value: number | undefined): number {
	return value === undefined || !Number.isFinite(value) || value < 0 ? 0 : Math.floor(value);
}

function iso(ms: number | null): string | null {
	return ms === null || !Number.isFinite(ms) || ms <= 0 ? null : new Date(ms).toISOString();
}

/** The stage a running run is in, from the librarian's phase and what it has reported. */
export function activeStage(input: Pick<IndexProgressInput, "phase" | "sourceTotal" | "parsed" | "embedding">): IndexStageId {
	switch (input.phase) {
		case null:
			return "discover";
		case "parsed":
			return input.sourceTotal === null && input.parsed === null ? "discover" : "parse";
		case "minsync":
			return input.embedding === false ? "keyword" : "embed";
		default:
			return "finalize";
	}
}

function fractionOf(counts: IndexStageCounts | null): number | null {
	if (counts === null || counts.total === null) return null;
	if (counts.total <= 0) return 1;
	return clamp((counts.done + counts.skipped + counts.failed) / counts.total, 0, 1);
}

function handledOf(counts: IndexStageCounts | null): number {
	return counts === null ? 0 : counts.done + counts.skipped + counts.failed;
}

/** Counts of the read stage. The librarian's `scanned` includes the files it skipped, so skipped is taken back out of `done`. */
function parseCounts(input: IndexProgressInput, finished: boolean): IndexStageCounts | null {
	const total = input.sourceTotal ?? (input.parsed === null ? null : input.parsed.scanned);
	if (input.parsed === null && total === null) return null;
	const scanned = nonNegative(input.parsed?.scanned);
	const handled = total === null ? scanned : Math.min(scanned, total);
	const skipped = Math.min(nonNegative(input.parsed?.skipped), handled);
	const counts: IndexStageCounts = { done: handled - skipped, skipped, failed: 0, total };
	// A finished stage has gone through everything it listed.
	return finished && total !== null ? { done: Math.max(0, total - skipped), skipped, failed: 0, total } : counts;
}

/**
 * Counts of MinSync's stage, whether it embeds or builds the keyword index. MinSync's denominator (`minsync.total`) is the number of files this sync has to
 * index, so the numerator is only ever MinSync's own count of files it finished: never the read stage's count.
 */
function embedCounts(input: IndexProgressInput, finished: boolean): IndexStageCounts | null {
	const total = input.minsync?.total ?? null;
	const journal = input.journal;
	if (total === null && journal === null && input.minsync === null) return null;
	const journalHandled = journal === null ? 0 : journal.committed + journal.deleted + journal.failed;
	const reported = nonNegative(input.minsync?.synced);
	const rawHandled = Math.max(journalHandled, reported);
	const handled = total === null ? rawHandled : Math.min(rawHandled, total);
	const failed = Math.min(Math.max(journal?.failed ?? 0, nonNegative(input.minsync?.filesSkipped)), handled);
	if (finished && total !== null) return { done: Math.max(0, total - failed), skipped: 0, failed, total };
	return { done: handled - failed, skipped: 0, failed, total };
}

function bytesOf(stage: IndexStageId, input: IndexProgressInput): IndexStageBytes | null {
	// The read stage has no byte figure: the parsed mirror lists every file of earlier runs too, so it cannot say what this run has read.
	if (isMinsyncStage(stage)) {
		const done = input.journal?.bytesDone;
		if (done === undefined || done === null) return null;
		const total = input.embedBytesTotal ?? null;
		return { done: total === null ? done : Math.min(done, total), total };
	}
	return null;
}

function stageProgress(id: IndexStageId, state: IndexStageState, input: IndexProgressInput): IndexStageProgress {
	if (state === "pending") return { id, state, counts: null, bytes: null, fraction: 0 };
	const finished = state === "done";
	let counts: IndexStageCounts | null = null;
	if (id === "discover") {
		const found = input.sourceTotal ?? (input.parsed === null ? null : input.parsed.scanned);
		counts = found === null ? null : { done: found, skipped: 0, failed: 0, total: found };
	} else if (id === "parse") {
		counts = parseCounts(input, finished);
	} else if (isMinsyncStage(id)) {
		counts = embedCounts(input, finished);
	}
	const bytes = bytesOf(id, input);
	const measured = fractionOf(counts);
	// The final stage has nothing to count: it is either finished or being worked on.
	const fraction = finished ? 1 : id === "finalize" || id === "discover" ? null : measured;
	return { id, state, counts, bytes, fraction };
}

function lastFileOf(stage: IndexStageId, input: IndexProgressInput): string | null {
	return isMinsyncStage(stage) ? (input.journal?.lastFile ?? null) : stage === "parse" ? (input.parseFile ?? null) : null;
}

/** Projects the end of the running stage from the rate of the samples in the window; `null` when they say too little. */
function projectMinutes(
	samples: readonly RateSample[],
	current: { readonly done: number; readonly bytes: number | null },
	remaining: { readonly files: number; readonly bytes: number | null },
	now: number,
): number | null {
	const first = samples[0];
	if (first === undefined) return null;
	const span = now - first.at;
	if (span < MIN_RATE_SPAN_MS) return null;
	const movedFiles = current.done - first.done;
	const movedBytes = current.bytes !== null && first.bytes !== null ? current.bytes - first.bytes : null;
	// Big files make a file count a poor yardstick: when sizes are known and moved, they set the pace.
	let rate: number;
	let left: number;
	if (movedBytes !== null && movedBytes > 0 && remaining.bytes !== null) {
		rate = movedBytes / span;
		left = remaining.bytes;
	} else if (movedFiles > 0) {
		rate = movedFiles / span;
		left = remaining.files;
	} else {
		return null;
	}
	if (left <= 0) return null;
	// `left` is positive, so this is at least one minute: a run with work remaining never shows 0.
	return Math.ceil(left / rate / 60_000);
}

function nextHistory(history: RateHistory, stage: IndexStageId, handled: number, bytes: number | null, journalAt: number | null, now: number): RateHistory {
	const sameStage = history.stage === stage && handled >= history.handled;
	if (!sameStage) {
		// First look at this stage (or its count went backwards: a new pass). Work the journal timestamps already show counts as done.
		const lastCompletedAt = handled > 0 ? (journalAt ?? now) : null;
		return { stage, since: now, samples: [{ at: now, done: handled, bytes }], handled, lastCompletedAt };
	}
	const rose = handled > history.handled;
	const last = history.samples[history.samples.length - 1];
	const keep = history.samples.filter((sample) => sample.at >= now - RATE_WINDOW_MS);
	const stored = rose || last === undefined || now - last.at >= SAMPLE_EVERY_MS ? [...keep, { at: now, done: handled, bytes }] : keep;
	return {
		stage,
		since: history.since,
		samples: stored,
		handled,
		lastCompletedAt: rose ? now : history.lastCompletedAt,
	};
}

/**
 * The last snapshot carried over while nothing newer can be measured. Where the run stands is kept; the remaining time
 * is not, because no rate is being observed any more.
 */
export function holdIndexProgress(snapshot: IndexProgressSnapshot | null): IndexProgressSnapshot | null {
	if (snapshot === null || snapshot.etaState === "none") return snapshot;
	return { ...snapshot, etaState: "calculating", etaMinutes: null };
}

/** The whole-run snapshot for one poll, and the history to hand back at the next. */
export function computeIndexProgress(input: IndexProgressInput, history: RateHistory = EMPTY_RATE_HISTORY): IndexProgressResult {
	const embedding = input.embedding !== false;
	const order = indexStagesFor(embedding);
	const heartbeat = iso(input.heartbeatAt);

	if (input.state === "success") {
		const stages = order.map((id) => stageProgress(id, "done", input));
		return {
			snapshot: {
				stage: null,
				stages,
				fraction: 1,
				indeterminate: false,
				etaState: "none",
				etaMinutes: null,
				pulse: { lastCompletedAt: iso(history.lastCompletedAt), heartbeatAt: heartbeat, lastFile: lastFileOf(embedding ? "embed" : "keyword", input), stalled: false },
			},
			history: EMPTY_RATE_HISTORY,
		};
	}

	const active = activeStage({ phase: input.phase, sourceTotal: input.sourceTotal, parsed: input.parsed, embedding });
	const activeIndex = order.indexOf(active);
	const stages = order.map((id, index) => stageProgress(id, index < activeIndex ? "done" : index === activeIndex ? "running" : "pending", input));
	const running = stages[activeIndex];
	const counts = running?.counts ?? null;
	const measured = running?.fraction ?? null;

	let position = 0;
	for (const stage of stages) {
		if (stage.state === "done") position += STAGE_SHARE[stage.id];
		else if (stage.state === "running" && measured !== null) position += STAGE_SHARE[stage.id] * measured;
	}
	// A stage that has counted everything but not yet closed (MinSync is still writing its index) has nothing left to measure either.
	const waitingToClose = counts !== null && counts.total !== null && counts.total > 0 && handledOf(counts) >= counts.total && active !== "finalize";
	const indeterminate = measured === null || waitingToClose;

	// The read stage and MinSync's are the ones with files to count; discovery and the final tidy-up have none.
	const countable = isFileCountStage(active);
	const handled = handledOf(counts);
	const total = counts?.total ?? null;
	const bytes = running?.bytes?.done ?? null;
	const journalAt = isMinsyncStage(active) ? (input.journal?.modifiedAt ?? null) : null;
	const nextRate = input.state === "running" && countable && counts !== null ? nextHistory(history, active, handled, bytes, journalAt, input.now) : { ...EMPTY_RATE_HISTORY, stage: active, since: history.stage === active ? history.since : input.now };

	let etaState: IndexEtaState = "none";
	let etaMinutes: number | null = null;
	if (input.state === "running") {
		if (countable && total !== null && handled < total) {
			const remainingBytes = running?.bytes?.total != null ? Math.max(0, running.bytes.total - (bytes ?? 0)) : null;
			etaMinutes = projectMinutes(nextRate.samples, { done: handled, bytes }, { files: total - handled, bytes: remainingBytes }, input.now);
			etaState = etaMinutes === null ? "calculating" : "estimated";
		} else if (active === "discover" || countable) {
			// Nothing to project from yet: the size of the stage is unknown, or every file is counted and the stage has yet to close.
			etaState = "calculating";
		}
	}

	const quietFor = input.now - (nextRate.lastCompletedAt ?? nextRate.since);
	const stalled = input.state === "running" && countable && total !== null && handled < total && quietFor >= STALL_AFTER_MS;

	return {
		snapshot: {
			stage: active,
			stages,
			fraction: clamp(position, 0, input.state === "running" ? 0.99 : 1),
			indeterminate: input.state === "running" ? indeterminate : false,
			etaState,
			etaMinutes,
			pulse: {
				lastCompletedAt: iso(nextRate.lastCompletedAt),
				heartbeatAt: heartbeat,
				lastFile: lastFileOf(active, input),
				stalled,
			},
		},
		history: nextRate,
	};
}
