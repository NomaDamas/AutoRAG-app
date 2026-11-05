import { lstat, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { IndexActivityCounts, IndexActivityPhase } from "../shared/index-activity-contract";
import {
	computeIndexProgress,
	EMPTY_RATE_HISTORY,
	type MinsyncJournalTally,
	type RateHistory,
} from "../shared/index-progress";
import type { IndexProgressSnapshot } from "../shared/index-progress-contract";
import { MINSYNC_JOURNAL_PARTS, tallyMinsyncJournal } from "./index-progress-journal";
import { readLibrarianFile, statLibrarianFile } from "./librarian-file";

/**
 * Turns the files a refresh leaves on disk into an {@link IndexProgressSnapshot}. The first-run indexing
 * screen and the activity service (sidebar, Settings > Indexing) each own one tracker and feed it the
 * librarian's `refresh-progress.json`; both then run the same {@link computeIndexProgress}, so what they
 * show cannot differ.
 *
 * The tracker adds what the progress file lacks:
 *  - MinSync's `progress.jsonl`, for the files the embedding stage has finished one by one;
 *  - the size of every staged document, read once per run, so progress can also be told in bytes;
 *  - the observations of earlier polls, so the remaining time comes from a rolling rate.
 */

/** The part of `refresh-progress.json` the tracker reads. */
export interface TrackedRefresh {
	readonly state: "running" | "success" | "failed";
	readonly phase: IndexActivityPhase | null;
	readonly pid: number;
	readonly startedAt: string;
	readonly runId: string | null;
	readonly updatedAt: string | null;
	readonly sourceTotal: number | null;
	readonly counts: IndexActivityCounts | null;
	readonly minsync: { readonly synced?: number; readonly total?: number; readonly filesSkipped?: number } | null;
}

export interface TrackExtras {
	/** False for keyword-only indexing. */
	readonly embedding?: boolean;
	/** Name of the file the read stage handled last. */
	readonly parseFile?: string | null;
}

export interface IndexProgressTracker {
	/** `refresh` is `null` when no refresh is live: the tracker forgets the run. */
	poll(root: string, refresh: TrackedRefresh | null, extras?: TrackExtras): IndexProgressSnapshot | null;
	reset(): void;
}

export interface StagedSizes {
	/** Bytes by item key (`files/<path>.md`, relative to the MinSync workspace, `/`-separated). */
	readonly bytes: ReadonlyMap<string, number>;
	readonly total: number;
}

/** Size of every document staged for MinSync under `<root>/.autorag/minsync/files`. */
export async function readStagedSizes(root: string): Promise<StagedSizes> {
	const workspace = join(root, ".autorag", "minsync");
	const bytes = new Map<string, number>();
	let total = 0;
	const pending: string[] = [join(workspace, "files")];
	while (pending.length > 0) {
		const dir = pending.pop();
		if (dir === undefined) break;
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		const files: string[] = [];
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile()) files.push(path);
		}
		// Stat in slices so a folder of tens of thousands of files does not open them all at once.
		for (let start = 0; start < files.length; start += 256) {
			const slice = files.slice(start, start + 256);
			const sizes = await Promise.all(slice.map((path) => lstat(path).then((info) => info.size, () => null)));
			slice.forEach((path, index) => {
				const size = sizes[index];
				if (size === null || size === undefined) return;
				bytes.set(relative(workspace, path).split(sep).join("/"), size);
				total += size;
			});
		}
	}
	return { bytes, total };
}

interface RunState {
	readonly key: string;
	history: RateHistory;
	journalSignature: string;
	tally: MinsyncJournalTally | null;
	sizes: StagedSizes | null;
	sizesLoading: boolean;
}

function parseTime(iso: string | null): number | null {
	const value = iso === null ? Number.NaN : Date.parse(iso);
	return Number.isNaN(value) ? null : value;
}

export function createIndexProgressTracker(deps: { readonly now?: () => number } = {}): IndexProgressTracker {
	const now = deps.now ?? Date.now;
	let run: RunState | null = null;

	function startRun(key: string): RunState {
		return { key, history: EMPTY_RATE_HISTORY, journalSignature: "", tally: null, sizes: null, sizesLoading: false };
	}

	function loadSizes(root: string, target: RunState): void {
		if (target.sizes !== null || target.sizesLoading) return;
		target.sizesLoading = true;
		void readStagedSizes(root)
			.then((sizes) => {
				target.sizes = sizes;
				// Re-tally the journal with sizes on the next poll.
				target.journalSignature = "";
			})
			.catch(() => undefined)
			.finally(() => {
				target.sizesLoading = false;
			});
	}

	function readTally(root: string, target: RunState): MinsyncJournalTally | null {
		const path = join(root, ...MINSYNC_JOURNAL_PARTS);
		const info = statLibrarianFile(path);
		if (info === null) {
			target.tally = null;
			target.journalSignature = "";
			return null;
		}
		const signature = `${info.mtimeMs}:${info.size}`;
		if (signature === target.journalSignature) return target.tally;
		const text = readLibrarianFile(path);
		if (text === null) return target.tally;
		const sizes = target.sizes;
		target.journalSignature = signature;
		target.tally = tallyMinsyncJournal(text, { sizeOf: sizes === null ? undefined : (item) => sizes.bytes.get(item), modifiedAt: info.mtimeMs });
		return target.tally;
	}

	return {
		reset: () => {
			run = null;
		},
		poll: (root, refresh, extras = {}) => {
			if (refresh === null || refresh.state !== "running") {
				run = null;
				return null;
			}
			const key = refresh.runId ?? `${refresh.pid}:${refresh.startedAt}`;
			if (run === null || run.key !== key) run = startRun(key);
			const current = run;
			let tally: MinsyncJournalTally | null = null;
			if (refresh.phase === "minsync") {
				loadSizes(root, current);
				tally = readTally(root, current);
			}
			// A byte total only describes this stage when the staged documents are exactly the files MinSync was told to index;
			// an incremental sync indexes a few of many, and the staged total would overstate it.
			const sizes = current.sizes;
			const embedBytesTotal = sizes !== null && sizes.bytes.size === refresh.minsync?.total ? sizes.total : null;
			const result = computeIndexProgress(
				{
					state: "running",
					phase: refresh.phase,
					...(extras.embedding === undefined ? {} : { embedding: extras.embedding }),
					sourceTotal: refresh.sourceTotal,
					parsed: refresh.counts,
					minsync: refresh.minsync,
					journal: tally,
					embedBytesTotal,
					parseFile: extras.parseFile ?? null,
					heartbeatAt: parseTime(refresh.updatedAt),
					now: now(),
				},
				current.history,
			);
			current.history = result.history;
			return result.snapshot;
		},
	};
}
