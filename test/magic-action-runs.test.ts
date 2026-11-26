import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMagicActionRunLog, MAGIC_RUNS_KEPT } from "../src/main/magic-action-runs";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function logIn(): Promise<{ file: string; clock: { now: number } }> {
	const dir = await mkdtemp(join(tmpdir(), "magic-runs-"));
	dirs.push(dir);
	return { file: join(dir, "magic-action-runs.json"), clock: { now: 1_000 } };
}

const started = (runId: string, actionId: string, paths: readonly string[] = ["/a.pdf"]) =>
	({ type: "started", runId, actionId, actionLabel: actionId, executionKind: "agent", paths }) as const;

describe("the right-click actions' run log", () => {
	it("keeps each finished run newest first, in an automation run's shape, and skips a stopped one", async () => {
		const { file, clock } = await logIn();
		const log = createMagicActionRunLog({ file, now: () => clock.now });
		log.record(started("r1", "summary", ["/a.pdf", "/b.pdf"]));
		clock.now = 3_000;
		log.record({ type: "done", runId: "r1", result: { actionId: "summary", actionLabel: "summary", executionKind: "agent", paths: [], output: "ok", durationMs: 2_000 } });
		log.record(started("r2", "summary"));
		clock.now = 4_000;
		log.record({ type: "error", runId: "r2", actionLabel: "summary", message: "model unavailable" });
		log.record(started("r3", "summary"));
		log.record({ type: "cancelled", runId: "r3", actionLabel: "summary" });

		expect(await log.history("summary")).toEqual([
			{ startedAt: 3_000, durationMs: 1_000, eventCount: 1, exitCode: null, signal: null, timedOut: false, files: ["/a.pdf"], error: "model unavailable" },
			{ startedAt: 1_000, durationMs: 2_000, eventCount: 2, exitCode: 0, signal: null, timedOut: false, files: ["/a.pdf", "/b.pdf"] },
		]);
		expect(await log.history("other")).toEqual([]);
		// A new log over the same file reads what was kept.
		expect(await createMagicActionRunLog({ file }).history("summary")).toHaveLength(2);
	});

	it("keeps only the newest runs of an action", async () => {
		const { file, clock } = await logIn();
		const log = createMagicActionRunLog({ file, now: () => clock.now });
		for (let i = 0; i < MAGIC_RUNS_KEPT + 5; i++) {
			log.record(started(`r${i}`, "a"));
			clock.now += 10;
			log.record({ type: "done", runId: `r${i}`, result: { actionId: "a", actionLabel: "a", executionKind: "script", paths: [], output: "", exitCode: i % 2, durationMs: 10 } });
		}
		const runs = await log.history("a");
		expect(runs).toHaveLength(MAGIC_RUNS_KEPT);
		expect(runs[0]!.startedAt).toBeGreaterThan(runs[1]!.startedAt);
	});
});
