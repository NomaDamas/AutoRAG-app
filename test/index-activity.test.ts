import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveIndexActivity, DONE_LINGER_MS, FAILED_LINGER_MS, parseRefreshProgress, type ProgressView } from "../src/main/index-activity";
import { createActivityJournal, journalSingleRun, LOCAL_ITEM, readActivity, sourceItem, type ActivityRecord } from "../src/main/index-activity-journal";
import { runScheduledRefresh, schedulePaths } from "../src/main/refresh-schedule";

const T0 = Date.parse("2026-10-10T12:00:00.000Z");
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();
const ALIVE = new Set([100, 200]);
const alive = (pid: number): boolean => ALIVE.has(pid);

function progressText(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({ version: 1, runId: "r", pid: 100, state: "running", phase: "parsed", startedAt: iso(-60_000), updatedAt: iso(-60_000), ...overrides });
}

function progress(overrides: Record<string, unknown> = {}): ProgressView | null {
	return parseRefreshProgress(progressText(overrides));
}

function record(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
	return {
		version: 1,
		pid: 200,
		owner: "scheduled-job",
		startedAt: iso(-60_000),
		finishedAt: null,
		items: [
			{ key: "local", kind: "local", id: null, state: "running", error: null },
			{ key: "source:slack", kind: "source", id: "slack", state: "queued", error: null },
		],
		...overrides,
	};
}

describe("deriveIndexActivity", () => {
	it("is idle with no files", () => {
		expect(deriveIndexActivity({ progress: null, journal: null, now: T0, alive, ownPids: [] }).state).toBe("idle");
	});

	it("shows an external librarian refresh as running by pid even when updatedAt is long stale", () => {
		// A phase can run for 12+ minutes without touching the file.
		const view = deriveIndexActivity({ progress: progress({ phase: "minsync", updatedAt: iso(-12 * 60_000) }), journal: null, now: T0, alive, ownPids: [999] });
		expect(view.state).toBe("running");
		expect(view.origin).toBe("external");
		expect(view.items[0]).toMatchObject({ key: "local", state: "running", phase: "minsync" });
		expect(view.fraction).toBeCloseTo(0.5);
	});

	it("attributes a refresh started from this app's own process to the app", () => {
		const view = deriveIndexActivity({ progress: progress(), journal: null, now: T0, alive, ownPids: [100] });
		expect(view.origin).toBe("app");
	});

	it("treats a running record whose process is gone as not running", () => {
		const view = deriveIndexActivity({ progress: progress({ pid: 4242 }), journal: null, now: T0, alive, ownPids: [] });
		expect(view.state).toBe("idle");
	});

	it("is indeterminate while a lone datasource syncs: nothing reports how far", () => {
		const journal = record({ owner: "manual-sync", items: [{ key: "source:slack", kind: "source", id: "slack", state: "running", error: null }] });
		const view = deriveIndexActivity({ progress: null, journal, now: T0, alive, ownPids: [] });
		expect(view).toMatchObject({ state: "running", origin: "app", fraction: null });
		expect(view.items.map((item) => item.phase)).toEqual([null]);
	});

	it("merges the librarian phase into the journal's local item and counts finished items", () => {
		const journal = record({
			items: [
				{ key: "local", kind: "local", id: null, state: "running", error: null },
				{ key: "source:slack", kind: "source", id: "slack", state: "queued", error: null },
				{ key: "source:rss", kind: "source", id: "rss", state: "queued", error: null },
			],
		});
		const view = deriveIndexActivity({
			progress: progress({ pid: 200, phase: "minsync", parsedCounts: { scanned: 10, written: 4, deleted: 1, skipped: 2 } }),
			journal,
			now: T0,
			alive,
			ownPids: [],
		});
		expect(view.origin).toBe("scheduled");
		expect(view.items[0]).toMatchObject({ key: "local", phase: "minsync", counts: { scanned: 10, written: 4, deleted: 1, skipped: 2 } });
		// local halfway (0.5) of three items.
		expect(view.fraction).toBeCloseTo(0.5 / 3);
	});

	it("advances the local minsync fraction from MinSync's committed-file count when available", () => {
		const view = deriveIndexActivity({
			progress: progress({ pid: 100, phase: "minsync", parsedCounts: { scanned: 100, written: 80, deleted: 0, skipped: 20 } }),
			journal: null,
			minsyncCommitted: 40,
			now: T0,
			alive,
			ownPids: [100],
		});
		// 40 of 80 written files embedded -> halfway through the minsync→datasources span (0.5 + 0.5 * 0.4 = 0.7).
		expect(view.fraction).toBeCloseTo(0.7);
	});

	it("advances the local minsync fraction from librarian 2.13.2 streamed minsync progress when present", () => {
		const view = deriveIndexActivity({
			progress: progress({
				pid: 100,
				phase: "minsync",
				parsedCounts: { scanned: 100, written: 80, deleted: 0, skipped: 20 },
				minsync: { synced: 25, total: 100 },
			}),
			journal: null,
			now: T0,
			alive,
			ownPids: [100],
		});
		// 25 of 100 files synced -> 25% of the minsync→datasources span (0.5 + 0.25 * 0.4 = 0.6).
		expect(view.fraction).toBeCloseTo(0.6);
	});

	it("advances past a finished item even when the next one is a silent datasource sync", () => {
		const journal = record({
			items: [
				{ key: "local", kind: "local", id: null, state: "done", error: null },
				{ key: "source:slack", kind: "source", id: "slack", state: "running", error: null },
			],
		});
		const view = deriveIndexActivity({ progress: null, journal, now: T0, alive, ownPids: [] });
		expect(view.fraction).toBeCloseTo(0.5);
	});

	it("shows a finished run as done, then clears after the linger", () => {
		const finished = record({ finishedAt: iso(-1_000), items: [{ key: "local", kind: "local", id: null, state: "done", error: null }] });
		const fresh = deriveIndexActivity({ progress: null, journal: finished, now: T0, alive, ownPids: [] });
		expect(fresh).toMatchObject({ state: "done", fraction: 1 });
		const cleared = deriveIndexActivity({ progress: null, journal: finished, now: T0 + DONE_LINGER_MS, alive, ownPids: [] });
		expect(cleared.state).toBe("idle");
	});

	it("keeps a failure visible longer than a success and names the error", () => {
		const failed = record({
			finishedAt: iso(-1_000),
			items: [{ key: "source:slack", kind: "source", id: "slack", state: "failed", error: "token expired" }],
		});
		const afterDone = deriveIndexActivity({ progress: null, journal: failed, now: T0 + DONE_LINGER_MS, alive, ownPids: [] });
		expect(afterDone).toMatchObject({ state: "failed", error: "token expired" });
		const afterFailed = deriveIndexActivity({ progress: null, journal: failed, now: T0 + FAILED_LINGER_MS + 1_000, alive, ownPids: [] });
		expect(afterFailed.state).toBe("idle");
	});

	it("shows an external run that finished (no journal) with the librarian's counts and error", () => {
		const view = deriveIndexActivity({
			progress: progress({ state: "failed", pid: 4242, finishedAt: iso(-500), error: "Refresh failed: Error" }),
			journal: null,
			now: T0,
			alive,
			ownPids: [],
		});
		expect(view).toMatchObject({ state: "failed", origin: "external", error: "Refresh failed: Error" });
	});

	it("rejects malformed progress", () => {
		expect(parseRefreshProgress("not json")).toBeNull();
		expect(parseRefreshProgress(JSON.stringify({ state: "running" }))).toBeNull();
	});
});

describe("activity journal", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "activity-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("records queued → running → done and closes the run", () => {
		const path = join(dir, "activity.json");
		const journal = createActivityJournal(path, { owner: "manual-refresh", pid: 7 });
		journal.begin([LOCAL_ITEM, sourceItem("slack")]);
		journal.start("local");
		expect(readActivity(path)?.items.map((item) => item.state)).toEqual(["running", "queued"]);
		journal.finish("local", true, null);
		journal.end();
		const saved = readActivity(path);
		// The never-started item must not read as still queued after the run ended.
		expect(saved?.items.map((item) => item.state)).toEqual(["done", "failed"]);
		expect(saved?.finishedAt).not.toBeNull();
	});

	it("fails the item and closes the run when the work throws", async () => {
		const path = join(dir, "activity.json");
		await expect(
			journalSingleRun(createActivityJournal(path, { owner: "manual-sync", pid: 7 }), sourceItem("slack"), async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		const saved = readActivity(path);
		expect(saved?.items[0]).toMatchObject({ state: "failed", error: "boom" });
		expect(saved?.finishedAt).not.toBeNull();
	});

	it("reads nothing from a missing or corrupt file", () => {
		expect(readActivity(join(dir, "missing.json"))).toBeNull();
		const bad = join(dir, "bad.json");
		writeFileSync(bad, "{");
		expect(readActivity(bad)).toBeNull();
	});
});

describe("scheduled run journal", () => {
	it("journals each due item and closes with each item's outcome", async () => {
		const dir = mkdtempSync(join(tmpdir(), "activity-sched-"));
		try {
			const paths = schedulePaths(join(dir, "config.json"));
			const seen: string[][] = [];
			const outcome = await runScheduledRefresh({
				paths,
				readRaw: () => ({ appIndexing: { refreshIntervalMs: 300_000 }, datasources: { slack: { type: "slack", pollingIntervalMs: 300_000 } } }),
				refreshLocal: async () => {
					seen.push(readActivity(paths.activity)?.items.map((item) => `${item.key}:${item.state}`) ?? []);
					return { ok: true, methods: ["parsed", "minsync"], scanned: 1, written: 1, deleted: 0, skipped: 0, diagnostics: [], error: null };
				},
				syncSource: async (id) => {
					seen.push(readActivity(paths.activity)?.items.map((item) => `${item.key}:${item.state}`) ?? []);
					return { id, ok: false, state: "failed", chunkCount: null, indexedAt: null, durationMs: 1, diagnostics: [], error: "no token" };
				},
			});
			expect(outcome).toMatchObject({ kind: "ran", failures: 1 });
			expect(seen).toEqual([
				["local:running", "source:slack:queued"],
				["local:done", "source:slack:running"],
			]);
			const final = readActivity(paths.activity);
			expect(final?.owner).toBe("scheduled-job");
			expect(final?.items.map((item) => `${item.key}:${item.state}`)).toEqual(["local:done", "source:slack:failed"]);
			expect(final?.items[1]?.error).toBe("no token");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
