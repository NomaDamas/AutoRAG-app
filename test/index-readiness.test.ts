import { describe, expect, it } from "vitest";
import { createIndexReadiness, FEW_INDEXED_DOCUMENTS, judgeIndexReadiness, type IndexReadinessDeps } from "../src/main/index-readiness";
import { IDLE_INDEX_ACTIVITY, type IndexActivitySnapshot } from "../src/shared/index-activity-contract";
import { NO_INDEX_PROBLEM, type IndexProblem } from "../src/shared/index-problem-contract";
import type { DataSourceRow, DataSourcesSnapshot } from "../src/shared/settings-contract";

const RUNNING: IndexActivitySnapshot = { ...IDLE_INDEX_ACTIVITY, state: "running", origin: "app" };
const FAILED_PROBLEM: IndexProblem = { ...NO_INDEX_PROBLEM, failure: { reason: "embedder-offline", folders: [], code: null }, at: "2026-10-26T00:00:00.000Z" };

function row(overrides: { readonly id?: string; readonly enabled?: boolean; readonly state?: DataSourceRow["index"]["state"]; readonly chunkCount?: number | null }): DataSourceRow {
	return {
		id: overrides.id ?? "slack",
		type: "slack",
		description: "",
		enabled: overrides.enabled ?? true,
		status: "ready",
		install: { state: "installed", binary: null, path: null, detail: "", app: { required: false, name: "", installed: null } },
		agent: { state: "connected", skillName: null, tags: [], detail: "" },
		index: { state: overrides.state ?? "indexed", chunkCount: overrides.chunkCount ?? 0, unit: "message", indexedAt: null, detail: "" },
	};
}

function snapshot(local: number | null, sources: readonly DataSourceRow[] = [], error: string | null = null): DataSourcesSnapshot {
	return {
		configPath: "/config.json",
		configExists: true,
		error,
		refresh: { state: "idle", phase: null, finishedAt: null },
		local: { documentCount: local, updatedAt: null },
		sources,
	};
}

function deps(overrides: Partial<IndexReadinessDeps> = {}): IndexReadinessDeps {
	return {
		activity: async () => IDLE_INDEX_ACTIVITY,
		problem: () => NO_INDEX_PROBLEM,
		sources: async () => snapshot(500),
		...overrides,
	};
}

describe("judgeIndexReadiness", () => {
	it("stays quiet for an index that holds enough and is not being built", () => {
		expect(judgeIndexReadiness({ running: false, failed: false, documents: FEW_INDEXED_DOCUMENTS })).toBeNull();
	});

	it("says indexing is unfinished whatever the index already holds", () => {
		expect(judgeIndexReadiness({ running: true, failed: false, documents: 5_000 })).toEqual({ reason: "indexing", documents: 5_000 });
	});

	it("names a stopped run when nothing is running, and a running one outranks it", () => {
		expect(judgeIndexReadiness({ running: false, failed: true, documents: 40 })).toEqual({ reason: "failed", documents: 40 });
		expect(judgeIndexReadiness({ running: true, failed: true, documents: 40 })?.reason).toBe("indexing");
	});

	it("tells an empty index from a small one, and counts the boundary as enough", () => {
		expect(judgeIndexReadiness({ running: false, failed: false, documents: 0 })).toEqual({ reason: "empty", documents: 0 });
		expect(judgeIndexReadiness({ running: false, failed: false, documents: FEW_INDEXED_DOCUMENTS - 1 })).toEqual({ reason: "few", documents: FEW_INDEXED_DOCUMENTS - 1 });
		expect(judgeIndexReadiness({ running: false, failed: false, documents: FEW_INDEXED_DOCUMENTS })).toBeNull();
	});

	it("does not call an index small when its size could not be read", () => {
		expect(judgeIndexReadiness({ running: false, failed: false, documents: null })).toBeNull();
		expect(judgeIndexReadiness({ running: true, failed: false, documents: null })).toEqual({ reason: "indexing", documents: null });
	});
});

describe("createIndexReadiness", () => {
	it("is null for an established, idle index", async () => {
		expect(await createIndexReadiness(deps())()).toBeNull();
	});

	it("reads a run in progress from the index activity, whoever started it", async () => {
		const notice = await createIndexReadiness(deps({ activity: async () => ({ ...RUNNING, origin: "scheduled" }) }))();
		expect(notice).toEqual({ reason: "indexing", documents: 500 });
	});

	it("reads a stopped run from the index problem", async () => {
		const notice = await createIndexReadiness(deps({ problem: () => FAILED_PROBLEM }))();
		expect(notice).toEqual({ reason: "failed", documents: 500 });
	});

	it("does not treat files a run skipped as an unfinished index", async () => {
		const notice = await createIndexReadiness(deps({ problem: () => ({ ...NO_INDEX_PROBLEM, skipped: 12 }) }))();
		expect(notice).toBeNull();
	});

	it("treats a folder index that was never written as empty", async () => {
		expect(await createIndexReadiness(deps({ sources: async () => snapshot(null) }))()).toEqual({ reason: "empty", documents: 0 });
	});

	it("adds what the enabled sources hold to the folder documents, so a sources-only setup is not called empty", async () => {
		const sources = async () => snapshot(0, [row({ chunkCount: 52_000 })]);
		expect(await createIndexReadiness(deps({ sources }))()).toBeNull();
	});

	it("counts only enabled sources that are indexed", async () => {
		const sources = async () =>
			snapshot(2, [
				row({ id: "off", enabled: false, chunkCount: 9_000 }),
				row({ id: "live", state: "live", chunkCount: 9_000 }),
				row({ id: "never", state: "not-indexed", chunkCount: null }),
				row({ id: "none", state: "empty", chunkCount: 0 }),
				row({ id: "ok", chunkCount: 3 }),
			]);
		expect(await createIndexReadiness(deps({ sources }))()).toEqual({ reason: "few", documents: 5 });
	});

	it("still reports a run in progress when the sources cannot be listed, but never guesses a size", async () => {
		const sources = async (): Promise<DataSourcesSnapshot> => {
			throw new Error("probe failed");
		};
		expect(await createIndexReadiness(deps({ sources }))()).toBeNull();
		expect(await createIndexReadiness(deps({ sources, activity: async () => RUNNING }))()).toEqual({ reason: "indexing", documents: null });
	});

	it("does not guess a size from a config it could not read", async () => {
		const sources = async () => snapshot(null, [], "config.json: unexpected token");
		expect(await createIndexReadiness(deps({ sources }))()).toBeNull();
	});
});
