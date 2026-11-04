import { describe, expect, it } from "vitest";
import {
	computeIndexProgress,
	EMPTY_RATE_HISTORY,
	holdIndexProgress,
	MIN_RATE_SPAN_MS,
	RATE_WINDOW_MS,
	STALL_AFTER_MS,
	type IndexProgressInput,
	type MinsyncJournalTally,
	type RateHistory,
} from "../src/shared/index-progress";
import type { IndexProgressSnapshot, IndexStageId } from "../src/shared/index-progress-contract";

const T0 = Date.parse("2026-10-20T09:00:00.000Z");
const MIN = 60_000;

function journal(overrides: Partial<MinsyncJournalTally> = {}): MinsyncJournalTally {
	return { committed: 0, deleted: 0, failed: 0, bytesDone: null, lastFile: null, modifiedAt: null, ...overrides };
}

function embedInput(overrides: Partial<IndexProgressInput> = {}): IndexProgressInput {
	return {
		state: "running",
		phase: "minsync",
		sourceTotal: 29_595,
		parsed: { scanned: 29_595, written: 29_595, deleted: 0, skipped: 0 },
		minsync: { total: 29_595 },
		journal: null,
		heartbeatAt: T0,
		now: T0,
		...overrides,
	};
}

function stage(snapshot: IndexProgressSnapshot, id: IndexStageId) {
	const found = snapshot.stages.find((candidate) => candidate.id === id);
	if (found === undefined) throw new Error(`no ${id} stage`);
	return found;
}

/** Feed a sequence of (time, finished files) observations through the history, as the poller does. */
function observe(
	points: readonly (readonly [number, number])[],
	base: Partial<IndexProgressInput> = {},
	tally: Partial<MinsyncJournalTally> = {},
): { snapshot: IndexProgressSnapshot; history: RateHistory } {
	let history = EMPTY_RATE_HISTORY;
	let snapshot: IndexProgressSnapshot | null = null;
	for (const [at, committed] of points) {
		const result = computeIndexProgress(embedInput({ now: at, journal: journal({ committed, ...tally }), heartbeatAt: at, ...base }), history);
		history = result.history;
		snapshot = result.snapshot;
	}
	if (snapshot === null) throw new Error("no observations");
	return { snapshot, history };
}

describe("the 0.1.7 case: 12,950 of 29,595 files done while the screen said 95%", () => {
	const input = embedInput({
		journal: journal({ committed: 12_950, bytesDone: 4_255_000_000 }),
		embedBytesTotal: 18_500_000_000,
	});

	it("reports the journal's 44% of the files and 23% of the bytes", () => {
		const { snapshot } = computeIndexProgress(input);
		const embed = stage(snapshot, "embed");
		expect(embed.counts).toEqual({ done: 12_950, skipped: 0, failed: 0, total: 29_595 });
		expect(embed.fraction).toBeCloseTo(0.4376, 3);
		expect(Math.round((embed.fraction ?? 0) * 100)).toBe(44);
		expect(embed.bytes).toEqual({ done: 4_255_000_000, total: 18_500_000_000 });
		expect((embed.bytes?.done ?? 0) / (embed.bytes?.total ?? 1)).toBeCloseTo(0.23, 2);
	});

	it("does not sit at 95% with no time left: the bar is the read stage plus the measured part of embedding", () => {
		const { snapshot } = computeIndexProgress(input);
		expect(snapshot.stage).toBe("embed");
		expect(snapshot.fraction).toBeCloseTo(0.4 + 0.5 * 0.4376, 3);
		expect(snapshot.fraction).toBeLessThan(0.95);
		expect(snapshot.etaMinutes).not.toBe(0);
	});

	it("keeps the read stage's own file universe, so a bigger processed count than total cannot happen", () => {
		// The old screen showed 38,891 / 20,484: the mirror's lifetime entries over the pre-scan's count.
		const { snapshot } = computeIndexProgress(
			embedInput({ phase: "parsed", sourceTotal: 20_484, parsed: { scanned: 38_891, written: 100, deleted: 0, skipped: 500 }, minsync: null }),
		);
		const parse = stage(snapshot, "parse");
		expect(parse.counts).toEqual({ done: 19_984, skipped: 500, failed: 0, total: 20_484 });
		expect(parse.fraction).toBe(1);
	});
});

describe("measured completion only", () => {
	it("does not move when an hour passes without a single file finishing", () => {
		const at = (offset: number) => computeIndexProgress(embedInput({ now: T0 + offset, journal: journal({ committed: 100 }) })).snapshot;
		expect(at(60 * MIN).fraction).toBe(at(0).fraction);
		expect(at(60 * MIN).etaState).toBe("calculating");
	});

	it("never counts more files done than there are", () => {
		const over = computeIndexProgress(embedInput({ journal: journal({ committed: 40_000 }), minsync: { synced: 41_000, total: 29_595 } })).snapshot;
		const embed = stage(over, "embed");
		expect(embed.counts).toEqual({ done: 29_595, skipped: 0, failed: 0, total: 29_595 });
		expect(embed.fraction).toBe(1);
	});

	it("leaves the bar short of 95% and indeterminate while MinSync has counted every file but not yet finished", () => {
		const { snapshot } = computeIndexProgress(embedInput({ journal: journal({ committed: 29_595 }) }));
		expect(snapshot.stage).toBe("embed");
		expect(snapshot.fraction).toBeCloseTo(0.9);
		expect(snapshot.indeterminate).toBe(true);
		expect(snapshot.etaState).toBe("calculating");
		expect(snapshot.etaMinutes).toBeNull();
	});

	it("is indeterminate with an unknown total instead of inventing a denominator", () => {
		const { snapshot } = computeIndexProgress(embedInput({ minsync: null, journal: journal({ committed: 12 }) }));
		expect(stage(snapshot, "embed").counts?.total).toBeNull();
		expect(stage(snapshot, "embed").fraction).toBeNull();
		expect(snapshot.indeterminate).toBe(true);
		expect(snapshot.etaState).toBe("calculating");
	});

	it("counts skipped and failed files apart from the finished ones", () => {
		const parse = computeIndexProgress(embedInput({ phase: "parsed", parsed: { scanned: 100, written: 70, deleted: 0, skipped: 20 }, sourceTotal: 400, minsync: null })).snapshot;
		expect(stage(parse, "parse").counts).toEqual({ done: 80, skipped: 20, failed: 0, total: 400 });
		expect(stage(parse, "parse").fraction).toBeCloseTo(0.25);
		const embed = computeIndexProgress(embedInput({ journal: journal({ committed: 90, failed: 10 }) })).snapshot;
		expect(stage(embed, "embed").counts).toEqual({ done: 90, skipped: 0, failed: 10, total: 29_595 });
	});

	it("takes the larger of MinSync's own count and the journal's, whichever has caught up further", () => {
		const { snapshot } = computeIndexProgress(embedInput({ minsync: { synced: 500, total: 29_595 }, journal: journal({ committed: 450 }) }));
		expect(stage(snapshot, "embed").counts?.done).toBe(500);
	});
});

describe("stages", () => {
	it("is discovering until the librarian has listed the files", () => {
		const { snapshot } = computeIndexProgress(embedInput({ phase: "parsed", sourceTotal: null, parsed: null, minsync: null }));
		expect(snapshot.stage).toBe("discover");
		expect(snapshot.stages.map((s) => [s.id, s.state])).toEqual([
			["discover", "running"],
			["parse", "pending"],
			["embed", "pending"],
			["finalize", "pending"],
		]);
		expect(snapshot.indeterminate).toBe(true);
		expect(snapshot.fraction).toBe(0);
	});

	it("moves discover -> parse -> embed -> finalize and finishes at 1", () => {
		const parse = computeIndexProgress(embedInput({ phase: "parsed", minsync: null, parsed: { scanned: 10, written: 10, deleted: 0, skipped: 0 } })).snapshot;
		expect(parse.stages.map((s) => s.state)).toEqual(["done", "running", "pending", "pending"]);
		const embed = computeIndexProgress(embedInput({ minsync: { synced: 1, total: 10 } })).snapshot;
		expect(embed.stages.map((s) => s.state)).toEqual(["done", "done", "running", "pending"]);
		const finalize = computeIndexProgress(embedInput({ phase: "jikji", minsync: { synced: 10, total: 10 } })).snapshot;
		expect(finalize.stage).toBe("finalize");
		expect(finalize.stages.map((s) => s.state)).toEqual(["done", "done", "done", "running"]);
		expect(finalize.fraction).toBeCloseTo(0.9);
		expect(finalize.indeterminate).toBe(true);
		expect(finalize.etaState).toBe("none");
		const done = computeIndexProgress(embedInput({ state: "success", minsync: { synced: 10, total: 10 } })).snapshot;
		expect(done.stages.every((s) => s.state === "done")).toBe(true);
		expect(done.fraction).toBe(1);
		expect(done.indeterminate).toBe(false);
	});

	it("goes through the same four stages for keyword-only indexing, with MinSync's step named the keyword index", () => {
		const reading = computeIndexProgress(embedInput({ embedding: false, phase: "parsed", minsync: null, sourceTotal: 100, parsed: { scanned: 50, written: 50, deleted: 0, skipped: 0 } })).snapshot;
		expect(reading.stages.map((s) => s.id)).toEqual(["discover", "parse", "keyword", "finalize"]);
		// The read stage keeps its 40% of the bar; the half-read share is 20%.
		expect(reading.fraction).toBeCloseTo(0.2);
		const indexing = computeIndexProgress(embedInput({ embedding: false, minsync: { total: 100 }, journal: journal({ committed: 30, bytesDone: 3_000 }), embedBytesTotal: 10_000 })).snapshot;
		expect(indexing.stage).toBe("keyword");
		expect(indexing.stages.map((s) => s.state)).toEqual(["done", "done", "running", "pending"]);
		expect(stage(indexing, "keyword").counts).toEqual({ done: 30, skipped: 0, failed: 0, total: 100 });
		expect(stage(indexing, "keyword").bytes).toEqual({ done: 3_000, total: 10_000 });
		expect(indexing.indeterminate).toBe(false);
		expect(indexing.etaState).toBe("calculating");
		expect(indexing.pulse.lastFile).toBeNull();
	});

	it("puts a keyword-only run at the same place on the bar as an embedding run with the same file counts", () => {
		const base = { minsync: { synced: 30, total: 100 }, sourceTotal: 100, parsed: { scanned: 100, written: 100, deleted: 0, skipped: 0 } };
		const keyword = computeIndexProgress(embedInput({ ...base, embedding: false })).snapshot;
		const embed = computeIndexProgress(embedInput({ ...base, embedding: true })).snapshot;
		expect(keyword.fraction).toBeCloseTo(0.55);
		expect(keyword.fraction).toBeCloseTo(embed.fraction);
		expect(stage(keyword, "keyword").counts).toEqual(stage(embed, "embed").counts);
		// A keyword-only run has no stage called embedding, and an embedding run none called keyword.
		expect(keyword.stages.some((s) => s.id === "embed")).toBe(false);
		expect(embed.stages.some((s) => s.id === "keyword")).toBe(false);
	});

	it("keeps the final tidy-up a stage of its own after the keyword index", () => {
		const finalize = computeIndexProgress(embedInput({ embedding: false, phase: "jikji", minsync: { synced: 100, total: 100 } })).snapshot;
		expect(finalize.stage).toBe("finalize");
		expect(finalize.stages.map((s) => s.state)).toEqual(["done", "done", "done", "running"]);
		expect(finalize.fraction).toBeCloseTo(0.9);
		expect(finalize.indeterminate).toBe(true);
		const done = computeIndexProgress(embedInput({ embedding: false, state: "success", minsync: { synced: 100, total: 100 } })).snapshot;
		expect(done.stages.map((s) => [s.id, s.state])).toEqual([
			["discover", "done"],
			["parse", "done"],
			["keyword", "done"],
			["finalize", "done"],
		]);
	});

	it("never reaches 1 while the run is still running", () => {
		const { snapshot } = computeIndexProgress(embedInput({ phase: "finalizing", journal: journal({ committed: 29_595 }), minsync: { synced: 29_595, total: 29_595 } }));
		expect(snapshot.fraction).toBeLessThan(0.95);
	});
});

describe("remaining time from the observed rate", () => {
	it("says it is calculating until a minute of movement has been seen", () => {
		const { snapshot } = observe([
			[T0, 0],
			[T0 + MIN_RATE_SPAN_MS - 1_000, 40],
		]);
		expect(snapshot.etaState).toBe("calculating");
		expect(snapshot.etaMinutes).toBeNull();
	});

	it("projects the end from files per minute over the window", () => {
		// 100 files in 2 minutes = 50 per minute; 29,495 left -> about 590 minutes.
		const { snapshot } = observe([
			[T0, 0],
			[T0 + 2 * MIN, 100],
		]);
		expect(snapshot.etaState).toBe("estimated");
		expect(snapshot.etaMinutes).toBe(Math.ceil(29_495 / 50));
	});

	it("is at least a minute while any work remains", () => {
		const { snapshot } = observe(
			[
				[T0, 29_000],
				[T0 + 2 * MIN, 29_590],
			],
			{ minsync: { total: 29_595 } },
		);
		expect(snapshot.etaState).toBe("estimated");
		expect(snapshot.etaMinutes).toBe(1);
	});

	it("forgets movement older than the window, so a slowdown shows", () => {
		const points: (readonly [number, number])[] = [
			[T0, 0],
			[T0 + 2 * MIN, 2_000],
			[T0 + 20 * MIN, 2_000],
			[T0 + 30 * MIN, 2_100],
		];
		const { snapshot } = observe(points);
		// Only the last 10 minutes count: 100 files over 10 minutes, not 2,100 over 30.
		expect(snapshot.etaMinutes).toBe(Math.ceil((29_595 - 2_100) / 10));
		expect(RATE_WINDOW_MS).toBe(10 * MIN);
	});

	it("paces a run by bytes when sizes are known, so a stretch of huge files is not mistaken for a fast one", () => {
		// 100 small files in 10 minutes would give 10 min for the last 100; the bytes moved say otherwise.
		const run = (bytesDone: number) => computeIndexProgress(embedInput({ now: T0 + 10 * MIN, minsync: { total: 200 }, journal: journal({ committed: 100, bytesDone }), embedBytesTotal: 10_000_000_000 }), {
			...EMPTY_RATE_HISTORY,
			stage: "embed",
			since: T0,
			handled: 0,
			samples: [{ at: T0, done: 0, bytes: 0 }],
		});
		const { snapshot } = run(1_000_000_000);
		// 1 GB in 10 minutes, 9 GB left -> 90 minutes (not the 10 minutes the file count suggests).
		expect(snapshot.etaMinutes).toBe(90);
	});

	it("does not estimate a run that is not moving", () => {
		const { snapshot } = observe([
			[T0, 500],
			[T0 + 5 * MIN, 500],
		]);
		expect(snapshot.etaState).toBe("calculating");
	});

	it("has nothing to project for a finished or failed run", () => {
		expect(computeIndexProgress(embedInput({ state: "success" })).snapshot).toMatchObject({ etaState: "none", etaMinutes: null });
		expect(computeIndexProgress(embedInput({ state: "failed" })).snapshot).toMatchObject({ etaState: "none", etaMinutes: null });
	});
});

describe("activity and the stall warning", () => {
	it("reports the last completion, the last file and the heartbeat", () => {
		const { snapshot } = observe(
			[
				[T0, 10],
				[T0 + 3_000, 12],
			],
			{},
			{ lastFile: "report.pdf" },
		);
		expect(snapshot.pulse).toEqual({
			lastCompletedAt: new Date(T0 + 3_000).toISOString(),
			heartbeatAt: new Date(T0 + 3_000).toISOString(),
			lastFile: "report.pdf",
			stalled: false,
		});
	});

	it("warns once no file has finished for ten minutes with files left, however fresh the heartbeat", () => {
		const quiet = observe([
			[T0, 500],
			[T0 + STALL_AFTER_MS - MIN, 500],
		]);
		expect(quiet.snapshot.pulse.stalled).toBe(false);
		const stalled = observe([
			[T0, 500],
			[T0 + STALL_AFTER_MS + 1_000, 500],
		]);
		expect(stalled.snapshot.pulse.stalled).toBe(true);
		expect(stalled.snapshot.pulse.heartbeatAt).toBe(new Date(T0 + STALL_AFTER_MS + 1_000).toISOString());
		const resumed = observe([
			[T0, 500],
			[T0 + STALL_AFTER_MS + 1_000, 500],
			[T0 + STALL_AFTER_MS + 2_000, 501],
		]);
		expect(resumed.snapshot.pulse.stalled).toBe(false);
	});

	it("does not call a stage with nothing left, or one that cannot be counted, stalled", () => {
		const finalizing = computeIndexProgress(embedInput({ phase: "jikji", now: T0 + 2 * STALL_AFTER_MS }), { ...EMPTY_RATE_HISTORY, stage: "finalize", since: T0 }).snapshot;
		expect(finalizing.pulse.stalled).toBe(false);
		const complete = observe([
			[T0, 29_595],
			[T0 + 2 * STALL_AFTER_MS, 29_595],
		]);
		expect(complete.snapshot.pulse.stalled).toBe(false);
	});

	it("starts the quiet clock from the journal's own time when the app begins watching a run already under way", () => {
		const { snapshot } = computeIndexProgress(embedInput({ now: T0, journal: journal({ committed: 300, modifiedAt: T0 - 15 * MIN }) }));
		expect(snapshot.pulse.lastCompletedAt).toBe(new Date(T0 - 15 * MIN).toISOString());
		expect(snapshot.pulse.stalled).toBe(true);
	});
});

describe("holding the last snapshot", () => {
	it("keeps where the run stands and drops the remaining time nobody is measuring any more", () => {
		const estimated = observe(
			[
				[T0, 100],
				[T0 + 2 * MIN, 300],
			],
			{ minsync: { total: 1_000 } },
		).snapshot;
		expect(estimated.etaState).toBe("estimated");
		const held = holdIndexProgress(estimated);
		expect(held).toMatchObject({ stage: "embed", fraction: estimated.fraction, indeterminate: estimated.indeterminate, etaState: "calculating", etaMinutes: null });
		expect(held?.stages).toEqual(estimated.stages);
	});

	it("passes through what has nothing to project, and nothing at all", () => {
		const finalizing = computeIndexProgress(embedInput({ phase: "jikji" })).snapshot;
		expect(holdIndexProgress(finalizing)).toBe(finalizing);
		expect(holdIndexProgress(null)).toBeNull();
	});
});
