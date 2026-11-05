import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DataSourceStatusService } from "../src/main/datasource-status";
import { LOCAL_ITEM, readActivity, sourceItem } from "../src/main/index-activity-journal";
import { lockDataSources } from "../src/main/locked-datasources";
import { createRefreshQueue } from "../src/main/refresh-queue";
import { schedulePaths } from "../src/main/refresh-schedule";
import type { ConfigRefreshResult, DataSourceSyncResult } from "../src/shared/settings-contract";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "refresh-queue-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});


function localResult(ok = true): ConfigRefreshResult {
	return {
		ok,
		methods: ["parsed", "minsync"],
		scanned: 5,
		written: 2,
		deleted: 0,
		skipped: 3,
		diagnostics: [],
		error: ok ? null : "local failure",
	};
}

function syncResult(id: string, ok = true): DataSourceSyncResult {
	return {
		id,
		ok,
		state: ok ? "indexed" : "failed",
		chunkCount: ok ? 10 : null,
		indexedAt: ok ? "2026-11-02T00:00:00.000Z" : null,
		durationMs: 5,
		diagnostics: [],
		error: ok ? null : `${id} failed`,
	};
}

describe("createRefreshQueue", () => {
	it("queues local refresh and multiple datasource syncs in FIFO order without overwriting earlier items", async () => {
		const paths = schedulePaths(join(dir, "config.json"));
		const queue = createRefreshQueue(paths);
		const localGate = Promise.withResolvers<ConfigRefreshResult>();
		const slackStarted = Promise.withResolvers<void>();
		const slackGate = Promise.withResolvers<DataSourceSyncResult>();
		const kakaoStarted = Promise.withResolvers<void>();
		const kakaoGate = Promise.withResolvers<DataSourceSyncResult>();
		const order: string[] = [];

		const locked = lockDataSources(
			{
				sync: (id: string) => {
					order.push(`start:${id}`);
					if (id === "slack") {
						slackStarted.resolve();
						return slackGate.promise;
					}
					kakaoStarted.resolve();
					return kakaoGate.promise;
				},
			} as DataSourceStatusService,
			paths,
			queue,
		);

		const localPromise = queue.enqueue({
			item: LOCAL_ITEM,
			owner: "manual-refresh",
			work: () => {
				order.push("start:local");
				return localGate.promise;
			},
			onBusy: () => localResult(false),
		});

		const slackPromise = locked.sync("slack");
		const kakaoPromise = locked.sync("kakao");

		// While local runs, slack and kakao are already recorded as queued in the same journal (never overwritten).
		expect(order).toEqual(["start:local"]);
		expect(readActivity(paths.activity)?.items.map((item) => `${item.key}:${item.state}`)).toEqual([
			"local:running",
			"source:slack:queued",
			"source:kakao:queued",
		]);

		localGate.resolve(localResult(true));
		expect(await localPromise).toMatchObject({ ok: true });

		await slackStarted.promise;
		expect(order).toEqual(["start:local", "start:slack"]);
		expect(readActivity(paths.activity)?.items.map((item) => `${item.key}:${item.state}`)).toEqual([
			"local:done",
			"source:slack:running",
			"source:kakao:queued",
		]);

		slackGate.resolve(syncResult("slack", true));
		expect(await slackPromise).toMatchObject({ id: "slack", ok: true });

		await kakaoStarted.promise;
		expect(order).toEqual(["start:local", "start:slack", "start:kakao"]);
		expect(readActivity(paths.activity)?.items.map((item) => `${item.key}:${item.state}`)).toEqual([
			"local:done",
			"source:slack:done",
			"source:kakao:running",
		]);

		kakaoGate.resolve(syncResult("kakao", false));
		expect(await kakaoPromise).toMatchObject({ id: "kakao", ok: false, error: "kakao failed" });

		const finished = readActivity(paths.activity);
		expect(finished?.finishedAt).not.toBeNull();
		expect(finished?.items.map((item) => `${item.key}:${item.state}`)).toEqual([
			"local:done",
			"source:slack:done",
			"source:kakao:failed",
		]);
	});

	it("coalesces duplicate requests for an item that is already queued", async () => {
		const paths = schedulePaths(join(dir, "config.json"));
		const queue = createRefreshQueue(paths);
		const localGate = Promise.withResolvers<ConfigRefreshResult>();
		let slackRuns = 0;

		const pLocal = queue.enqueue({
			item: LOCAL_ITEM,
			owner: "manual-refresh",
			work: () => localGate.promise,
			onBusy: () => localResult(false),
		});

		const pSlack1 = queue.enqueue({
			item: sourceItem("slack"),
			owner: "manual-sync",
			work: async () => {
				slackRuns += 1;
				return syncResult("slack", true);
			},
			onBusy: () => syncResult("slack", false),
		});
		const pSlack2 = queue.enqueue({
			item: sourceItem("slack"),
			owner: "manual-sync",
			work: async () => {
				slackRuns += 1;
				return syncResult("slack", true);
			},
			onBusy: () => syncResult("slack", false),
		});

		expect(readActivity(paths.activity)?.items.map((item) => item.key)).toEqual(["local", "source:slack"]);

		localGate.resolve(localResult(true));
		const [, r1, r2] = await Promise.all([pLocal, pSlack1, pSlack2]);
		expect(slackRuns).toBe(1);
		expect(r1).toEqual(r2);
	});

	it("still refuses when an external scheduled-job process holds the refresh lock", async () => {
		const paths = schedulePaths(join(dir, "config.json"));
		mkdirSync(paths.dir, { recursive: true });
		writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: "scheduled-job" }));
		const queue = createRefreshQueue(paths);

		let ran = false;
		const res = await queue.enqueue({
			item: sourceItem("slack"),
			owner: "manual-sync",
			work: async () => {
				ran = true;
				return syncResult("slack", true);
			},
			onBusy: (holder) => ({ ...syncResult("slack", false), error: `busy:${holder.owner}` }),
		});

		expect(ran).toBe(false);
		expect(res.error).toBe("busy:scheduled-job");
		expect(readActivity(paths.activity)).toBeNull();
	});
});
