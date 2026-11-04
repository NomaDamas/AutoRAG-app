import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIndexProgressTracker, readStagedSizes, type TrackedRefresh } from "../src/main/index-progress-tracker";
import { MINSYNC_JOURNAL_PARTS } from "../src/main/index-progress-journal";
import type { IndexProgressSnapshot, IndexStageProgress } from "../src/shared/index-progress-contract";

const T0 = Date.parse("2026-10-20T09:00:00.000Z");
const MIN = 60_000;

function refresh(overrides: Partial<TrackedRefresh> = {}): TrackedRefresh {
	return {
		state: "running",
		phase: "minsync",
		pid: 1,
		startedAt: new Date(T0).toISOString(),
		runId: "run-1",
		updatedAt: new Date(T0).toISOString(),
		sourceTotal: 4,
		counts: { scanned: 4, written: 4, deleted: 0, skipped: 0 },
		minsync: { total: 4 },
		...overrides,
	};
}

function embedOf(snapshot: IndexProgressSnapshot | null): IndexStageProgress {
	const embed = snapshot?.stages.find((stage) => stage.id === "embed");
	if (embed === undefined) throw new Error("no embed stage");
	return embed;
}

describe("the progress tracker", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "progress-tracker-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function stage(name: string, size: number): void {
		const path = join(root, ".autorag", "minsync", "files", name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "x".repeat(size));
	}

	function journalLine(item: string, outcome = "committed"): string {
		return `{"item":"${item}","version":"sha256:aa","outcome":${JSON.stringify(outcome)}}\n`;
	}

	function writeJournal(lines: string, mtimeMs: number): void {
		const path = join(root, ...MINSYNC_JOURNAL_PARTS);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `{"format":3,"stage":"vector","run_token":"t"}\n${lines}`);
		utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
	}

	it("lists the staged documents with their sizes", async () => {
		stage("Users/me/a.pdf.md", 100);
		stage("Users/me/deep/b.md", 250);
		const sizes = await readStagedSizes(root);
		expect(sizes.bytes.get("files/Users/me/a.pdf.md")).toBe(100);
		expect(sizes.bytes.get("files/Users/me/deep/b.md")).toBe(250);
		expect(sizes.total).toBe(350);
		expect((await readStagedSizes(join(root, "missing"))).bytes.size).toBe(0);
	});

	it("counts the journal's files and, once the staged sizes are read, their bytes", async () => {
		stage("a.md", 1_000);
		stage("b.md", 3_000);
		stage("c.md", 4_000);
		stage("d.md", 2_000);
		writeJournal(journalLine("files/a.md") + journalLine("files/b.md"), T0);
		const tracker = createIndexProgressTracker({ now: () => T0 });

		const first = tracker.poll(root, refresh());
		expect(embedOf(first).counts).toEqual({ done: 2, skipped: 0, failed: 0, total: 4 });
		expect(first?.pulse.lastFile).toBe("b");
		// Sizes load in the background; a later poll has them.
		await vi.waitFor(() => expect(embedOf(tracker.poll(root, refresh())).bytes).toEqual({ done: 4_000, total: 10_000 }));
		expect(embedOf(tracker.poll(root, refresh())).fraction).toBe(0.5);
	});

	it("shows no byte total when the staged documents are not the files this sync was told to index", async () => {
		stage("a.md", 1_000);
		stage("b.md", 1_000);
		stage("c.md", 1_000);
		writeJournal(journalLine("files/a.md"), T0);
		const tracker = createIndexProgressTracker({ now: () => T0 });
		// An incremental sync of 1 changed file out of 3 staged: 3 KB would overstate its work.
		// Once the sizes are in, the committed file's size shows and the total stays unknown.
		await vi.waitFor(() => expect(embedOf(tracker.poll(root, refresh({ minsync: { total: 1 } }))).bytes).toEqual({ done: 1_000, total: null }));
	});

	it("projects the end from the journal as it grows over the minutes between polls", () => {
		let now = T0;
		const tracker = createIndexProgressTracker({ now: () => now });
		writeJournal("", now);
		expect(tracker.poll(root, refresh({ minsync: { total: 1_000 } }))?.etaState).toBe("calculating");
		let lines = "";
		for (let minute = 1; minute <= 2; minute += 1) {
			now = T0 + minute * MIN;
			for (let file = 0; file < 50; file += 1) lines += journalLine(`files/f${minute}-${file}.md`);
			writeJournal(lines, now);
			tracker.poll(root, refresh({ minsync: { total: 1_000 }, updatedAt: new Date(now).toISOString() }));
		}
		const snapshot = tracker.poll(root, refresh({ minsync: { total: 1_000 }, updatedAt: new Date(now).toISOString() }));
		// 100 files in 2 minutes with 900 left.
		expect(snapshot).toMatchObject({ etaState: "estimated", etaMinutes: 18 });
	});

	it("starts over for a new run and forgets a run that is not live", () => {
		const tracker = createIndexProgressTracker({ now: () => T0 });
		writeJournal(journalLine("files/a.md"), T0);
		expect(embedOf(tracker.poll(root, refresh())).counts?.done).toBe(1);
		expect(tracker.poll(root, refresh({ state: "success" }))).toBeNull();
		expect(tracker.poll(root, null)).toBeNull();
		writeJournal(journalLine("files/a.md") + journalLine("files/b.md"), T0);
		const next = tracker.poll(root, refresh({ runId: "run-2" }));
		expect(embedOf(next).counts?.done).toBe(2);
		expect(next?.pulse.stalled).toBe(false);
	});

	it("keeps an earlier run's journal out of the read stage's numbers", () => {
		writeJournal(journalLine("files/a.md") + journalLine("files/b.md"), T0);
		const tracker = createIndexProgressTracker({ now: () => T0 });
		const reading = tracker.poll(root, refresh({ phase: "parsed", minsync: null, sourceTotal: 10, counts: { scanned: 3, written: 3, deleted: 0, skipped: 0 } }));
		expect(reading?.stage).toBe("parse");
		expect(embedOf(reading).counts).toBeNull();
	});

	it("counts files MinSync failed apart from the finished ones", () => {
		writeJournal(journalLine("files/a.md") + journalLine("files/b.md", "failed"), T0);
		const tracker = createIndexProgressTracker({ now: () => T0 });
		expect(embedOf(tracker.poll(root, refresh())).counts).toEqual({ done: 1, skipped: 0, failed: 1, total: 4 });
	});
});
