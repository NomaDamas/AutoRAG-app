import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DataSourceSyncResult } from "../src/shared/settings-contract";
import type { DataSourceStatusService } from "../src/main/datasource-status";
import { readActivity } from "../src/main/index-activity-journal";
import { lockDataSources } from "../src/main/locked-datasources";
import { schedulePaths } from "../src/main/refresh-schedule";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "locked-ds-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function result(id: string, ok: boolean): DataSourceSyncResult {
	return { id, ok, state: ok ? "indexed" : "failed", chunkCount: ok ? 3 : null, indexedAt: null, durationMs: 1, diagnostics: [], error: ok ? null : "no token" };
}

/** Only `sync` is exercised; the rest of the service is never called by the wrapper. */
function service(sync: DataSourceStatusService["sync"]): DataSourceStatusService {
	return { sync } as DataSourceStatusService;
}

describe("lockDataSources", () => {
	it("journals the sync while it runs and records the outcome after", async () => {
		const paths = schedulePaths(join(dir, "config.json"));
		const seen: string[] = [];
		const locked = lockDataSources(
			service(async (id) => {
				seen.push(readActivity(paths.activity)?.items.map((item) => `${item.key}:${item.state}`).join(",") ?? "none");
				return result(id, true);
			}),
			paths,
		);
		await locked.sync("slack");
		expect(seen).toEqual(["source:slack:running"]);
		const saved = readActivity(paths.activity);
		expect(saved?.owner).toBe("manual-sync");
		expect(saved?.items.map((item) => item.state)).toEqual(["done"]);
		expect(saved?.finishedAt).not.toBeNull();
	});

	it("marks the item failed with the sync's own error", async () => {
		const paths = schedulePaths(join(dir, "config.json"));
		await lockDataSources(service(async (id) => result(id, false)), paths).sync("slack");
		expect(readActivity(paths.activity)?.items[0]).toMatchObject({ state: "failed", error: "no token" });
	});

	it("does not start while another refresh holds the lock, and leaves its journal alone", async () => {
		const paths = schedulePaths(join(dir, "config.json"));
		mkdirSync(paths.dir, { recursive: true });
		writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: "scheduled-job" }));
		let started = false;
		const outcome = await lockDataSources(
			service(async (id) => {
				started = true;
				return result(id, true);
			}),
			paths,
		).sync("slack");
		expect(started).toBe(false);
		expect(outcome).toMatchObject({ ok: false, error: "백그라운드 새로 고침이 실행 중입니다. 끝난 뒤 다시 시도하세요." });
		expect(readActivity(paths.activity)).toBeNull();
	});
});
