import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfigRefreshResult, DataSourceSyncResult } from "../src/shared/settings-contract";
import { acquireRefreshLock, isLockHeld } from "../src/main/refresh-lock";
import {
	dueItems,
	emptyScheduleState,
	readSchedulePlan,
	readScheduleState,
	runScheduledRefresh,
	schedulePaths,
	wakeIntervalMs,
	withRefreshLock,
	writeScheduleState,
} from "../src/main/refresh-schedule";
import {
	buildCronLine,
	buildLaunchdPlist,
	createRefreshScheduler,
	CRON_MARKER,
	foreignCronLines,
	stripOwnedCronLines,
	type CommandResult,
} from "../src/main/refresh-scheduler";

const MIN = 60_000;
let dir = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "autorag-refresh-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const okLocal = (): ConfigRefreshResult => ({ ok: true, methods: ["parsed", "minsync"], scanned: 10, written: 2, deleted: 0, skipped: 8, diagnostics: [], error: null });
const okSource = (id: string): DataSourceSyncResult => ({ id, ok: true, state: "indexed", chunkCount: 5, indexedAt: null, durationMs: 1, diagnostics: [], error: null });

describe("schedule plan", () => {
	it("is empty (manual only) when nothing has an interval, so connecting a source never starts background syncing", () => {
		const plan = readSchedulePlan({ datasources: { discord: {}, slack: { type: "slack" } } });
		expect(plan).toEqual({ localIntervalMs: null, sources: [] });
		expect(wakeIntervalMs(plan)).toBeNull();
	});

	it("includes only enabled, non-live sources with an explicit interval, and floors short ones at 5 minutes", () => {
		const plan = readSchedulePlan({
			appIndexing: { refreshIntervalMs: 60 * MIN },
			datasources: {
				discord: { pollingIntervalMs: 2 * MIN },
				off: { enabled: false, pollingIntervalMs: 15 * MIN },
				lark: { pollingIntervalMs: 15 * MIN },
				disabledShortHand: false,
			},
		});
		expect(plan.localIntervalMs).toBe(60 * MIN);
		expect(plan.sources).toEqual([{ id: "discord", intervalMs: 5 * MIN }]);
	});

	it("wakes at the shortest cadence but never sleeps longer than 30 minutes", () => {
		expect(wakeIntervalMs({ localIntervalMs: 6 * 60 * MIN, sources: [] })).toBe(30 * MIN);
		expect(wakeIntervalMs({ localIntervalMs: 60 * MIN, sources: [{ id: "a", intervalMs: 15 * MIN }] })).toBe(15 * MIN);
	});
});

describe("what is due", () => {
	const plan = { localIntervalMs: 60 * MIN, sources: [{ id: "discord", intervalMs: 15 * MIN }] };
	const at = (ms: number): string => new Date(ms).toISOString();
	const now = Date.parse("2026-10-09T12:00:00Z");

	it("everything is due when nothing has ever run", () => {
		expect(dueItems(plan, emptyScheduleState(), now)).toEqual({ local: true, sourceIds: ["discord"] });
	});

	it("runs only the item whose own interval elapsed", () => {
		const state = {
			...emptyScheduleState(),
			local: { at: at(now - 20 * MIN), ok: true, error: null, durationMs: 1, detail: null },
			sources: { discord: { at: at(now - 20 * MIN), ok: true, error: null, durationMs: 1, detail: null } },
		};
		expect(dueItems(plan, state, now)).toEqual({ local: false, sourceIds: ["discord"] });
	});

	it("counts a wake-up that lands slightly early as due, so timer drift does not skip a whole cycle", () => {
		const state = { ...emptyScheduleState(), sources: { discord: { at: at(now - 14 * MIN - 30_000), ok: true, error: null, durationMs: 1, detail: null } } };
		expect(dueItems({ localIntervalMs: null, sources: plan.sources }, state, now).sourceIds).toEqual(["discord"]);
	});

	it("does not hammer a failing source: a failed run still waits out its interval", () => {
		const state = { ...emptyScheduleState(), sources: { discord: { at: at(now - 2 * MIN), ok: false, error: "x", durationMs: 1, detail: null } } };
		expect(dueItems({ localIntervalMs: null, sources: plan.sources }, state, now).sourceIds).toEqual([]);
	});
});

describe("refresh lock", () => {
	it("refuses a second holder while the first process is alive", () => {
		const path = join(dir, "lock");
		const first = acquireRefreshLock(path, { owner: "a", pid: 111, isAlive: () => true });
		expect(isLockHeld(first)).toBe(false);
		const second = acquireRefreshLock(path, { owner: "b", pid: 222, isAlive: () => true });
		expect(isLockHeld(second) && second.heldBy.pid).toBe(111);
	});

	it("takes over a lock whose process is gone", () => {
		const path = join(dir, "lock");
		acquireRefreshLock(path, { owner: "a", pid: 111, isAlive: () => true });
		const taken = acquireRefreshLock(path, { owner: "b", pid: 222, isAlive: () => false });
		expect(isLockHeld(taken)).toBe(false);
		expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(222);
	});

	it("takes over a lock older than the stale limit even when its pid is alive (pid reuse)", () => {
		const path = join(dir, "lock");
		let clock = 1_000_000;
		acquireRefreshLock(path, { owner: "a", pid: 111, now: () => clock, isAlive: () => true, staleMs: 10 * MIN });
		clock += 11 * MIN;
		const taken = acquireRefreshLock(path, { owner: "b", pid: 222, now: () => clock, isAlive: () => true, staleMs: 10 * MIN });
		expect(isLockHeld(taken)).toBe(false);
	});

	it("takes over an unreadable lock file", () => {
		const path = join(dir, "lock");
		writeFileSync(path, "not json");
		expect(isLockHeld(acquireRefreshLock(path, { owner: "b", pid: 222, isAlive: () => true }))).toBe(false);
	});

	it("release removes only the holder's own lock", () => {
		const path = join(dir, "lock");
		const mine = acquireRefreshLock(path, { owner: "a", pid: 111, isAlive: () => true });
		// Someone legitimately took over after a stale timeout.
		writeFileSync(path, JSON.stringify({ pid: 999, startedAt: new Date().toISOString(), owner: "other" }));
		if (!isLockHeld(mine)) mine.release();
		expect(existsSync(path)).toBe(true);
	});
});

describe("scheduled run", () => {
	const raw = { appIndexing: { refreshIntervalMs: 60 * MIN }, datasources: { discord: { pollingIntervalMs: 15 * MIN }, slack: { pollingIntervalMs: 60 * MIN } } };

	function deps(overrides: { clock: { now: number }; local?: () => Promise<ConfigRefreshResult>; source?: (id: string) => Promise<DataSourceSyncResult>; rawConfig?: Record<string, unknown> }) {
		const calls: string[] = [];
		return {
			calls,
			value: {
				paths: schedulePaths(join(dir, "config.json")),
				readRaw: () => overrides.rawConfig ?? raw,
				refreshLocal: overrides.local ?? (async () => (calls.push("local"), okLocal())),
				syncSource: overrides.source ?? (async (id: string) => (calls.push(id), okSource(id))),
				now: () => overrides.clock.now,
			},
		};
	}

	it("runs everything on the first wake, records each outcome, then idles until something is due again", async () => {
		const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
		const run = deps({ clock });
		const first = await runScheduledRefresh(run.value);
		expect(first).toMatchObject({ kind: "ran", local: true, sourceIds: ["discord", "slack"], failures: 0 });
		expect(run.calls).toEqual(["local", "discord", "slack"]);

		clock.now += 5 * MIN;
		expect(await runScheduledRefresh(run.value)).toEqual({ kind: "idle" });

		clock.now += 11 * MIN; // 16 min after the first run: only discord (15 min) is due
		run.calls.length = 0;
		const third = await runScheduledRefresh(run.value);
		expect(third).toMatchObject({ kind: "ran", local: false, sourceIds: ["discord"] });
		expect(run.calls).toEqual(["discord"]);

		const state = readScheduleState(run.value.paths.state);
		expect(state.local?.detail).toBe("스캔 10 · 기록 2 · 삭제 0 · 건너뜀 8");
		expect(state.sources.discord?.detail).toBe("indexed · 5개");
	});

	it("keeps going after one source fails and records the failure for that source only", async () => {
		const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
		const run = deps({
			clock,
			source: async (id) => {
				if (id === "discord") throw new Error("discrawl exploded");
				return okSource(id);
			},
		});
		const outcome = await runScheduledRefresh(run.value);
		expect(outcome).toMatchObject({ kind: "ran", failures: 1 });
		const state = readScheduleState(run.value.paths.state);
		expect(state.sources.discord).toMatchObject({ ok: false, error: "discrawl exploded" });
		expect(state.sources.slack?.ok).toBe(true);
		expect(state.local?.ok).toBe(true);
	});

	it("does nothing and leaves the other run alone when the lock is held", async () => {
		const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
		const run = deps({ clock });
		mkdirSync(run.value.paths.dir, { recursive: true });
		writeFileSync(run.value.paths.lock, JSON.stringify({ pid: process.pid, startedAt: new Date(clock.now).toISOString(), owner: "manual-refresh" }));
		const outcome = await runScheduledRefresh(run.value);
		expect(outcome.kind).toBe("locked");
		expect(run.calls).toEqual([]);
		expect(existsSync(run.value.paths.lock)).toBe(true);
	});

	it("releases the lock after a run, so a manual refresh can follow", async () => {
		const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
		const run = deps({ clock });
		await runScheduledRefresh(run.value);
		expect(existsSync(run.value.paths.lock)).toBe(false);
		const manual = await withRefreshLock(run.value.paths.lock, "manual-refresh", async () => "ran", () => "busy");
		expect(manual).toBe("ran");
	});

	it("a manual run reports busy instead of overlapping a held lock", async () => {
		const path = join(dir, "lock");
		const held = acquireRefreshLock(path, { owner: "scheduled-job" });
		expect(isLockHeld(held)).toBe(false);
		const result = await withRefreshLock(path, "manual-refresh", async () => "ran", (holder) => `busy:${holder.owner}`);
		expect(result).toBe("busy:scheduled-job");
	});

	it("survives a corrupt state file by treating everything as due", async () => {
		const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
		const run = deps({ clock });
		mkdirSync(run.value.paths.dir, { recursive: true });
		writeFileSync(run.value.paths.state, "{{{");
		expect((await runScheduledRefresh(run.value)).kind).toBe("ran");
	});

	it("round-trips state through disk", () => {
		const path = join(dir, "state.json");
		const state = { ...emptyScheduleState(), lastTickAt: "2026-10-09T12:00:00.000Z", local: { at: "2026-10-09T12:00:00.000Z", ok: true, error: null, durationMs: 5, detail: "x" } };
		writeScheduleState(path, state);
		expect(readScheduleState(path)).toEqual(state);
	});
});

describe("launchd / cron output", () => {
	const common = { execPath: "/Applications/AutoRAG.app/Contents/MacOS/AutoRAG", jobPath: "/Applications/AutoRAG.app/Contents/Resources/app.asar/out/main/refresh-job.js", logPath: "/home/u/.autorag/app-refresh/job.log", home: "/Users/u", path: "/opt/homebrew/bin:/usr/bin" };

	it("builds a plist that runs the app's runtime as plain Node on an interval, without RunAtLoad", () => {
		const plist = buildLaunchdPlist({ ...common, intervalSeconds: 900, configPath: undefined });
		expect(plist).toContain("<key>ELECTRON_RUN_AS_NODE</key>\n\t\t<string>1</string>");
		expect(plist).toContain("<key>StartInterval</key>\n\t<integer>900</integer>");
		expect(plist).toContain("<key>RunAtLoad</key>\n\t<false/>");
		expect(plist).toContain(`<string>${common.execPath}</string>`);
		expect(plist).not.toContain("AUTORAG_CONFIG");
	});

	it("escapes XML in paths and passes an explicit config through", () => {
		const plist = buildLaunchdPlist({ ...common, execPath: "/a&b/<x>", intervalSeconds: 60, configPath: "/c/config.json" });
		expect(plist).toContain("/a&amp;b/&lt;x&gt;");
		expect(plist).toContain("<key>AUTORAG_CONFIG</key>\n\t\t<string>/c/config.json</string>");
	});

	it("builds a marked cron line, quoting paths with spaces and quotes", () => {
		const line = buildCronLine({ ...common, execPath: "/Apps/My App/it's", intervalMinutes: 15, configPath: undefined });
		expect(line.startsWith("*/15 * * * * ")).toBe(true);
		expect(line).toContain(`'/Apps/My App/it'\\''s'`);
		expect(line.endsWith(CRON_MARKER)).toBe(true);
	});

	it("keeps the user's own crontab lines byte-for-byte when removing ours, and reports hand-made autorag lines as conflicts", () => {
		const table = ["MAILTO=me", "*/30 * * * * /usr/bin/true", `*/15 * * * * x ${CRON_MARKER}`, "0 3 * * * /opt/homebrew/bin/autorag refresh >> /tmp/x 2>&1", "# autorag commented out"].join("\n");
		expect(stripOwnedCronLines(table)).toBe(["MAILTO=me", "*/30 * * * * /usr/bin/true", "0 3 * * * /opt/homebrew/bin/autorag refresh >> /tmp/x 2>&1", "# autorag commented out"].join("\n"));
		expect(foreignCronLines(table)).toEqual(["0 3 * * * /opt/homebrew/bin/autorag refresh >> /tmp/x 2>&1"]);
	});
});

describe("scheduler service", () => {
	function harness(platform: NodeJS.Platform, config: Record<string, unknown>) {
		const home = join(dir, "home");
		mkdirSync(home, { recursive: true });
		const configPath = join(dir, "config.json");
		writeFileSync(configPath, JSON.stringify(config));
		const calls: string[] = [];
		let crontab = "";
		const run = async (command: string, args: readonly string[], input?: string): Promise<CommandResult> => {
			calls.push(`${command} ${args.join(" ")}`);
			if (command === "crontab" && args[0] === "-l") return crontab === "" ? { code: 1, stdout: "", stderr: "no crontab" } : { code: 0, stdout: crontab, stderr: "" };
			if (command === "crontab" && args[0] === "-") {
				crontab = input ?? "";
				return { code: 0, stdout: "", stderr: "" };
			}
			if (command === "crontab" && args[0] === "-r") {
				crontab = "";
				return { code: 0, stdout: "", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		};
		const scheduler = createRefreshScheduler({ platform, home, uid: 501, execPath: "/x/App", jobPath: "/x/refresh-job.js", configPath: () => configPath, env: { PATH: "/usr/bin" }, run });
		return { scheduler, calls, home, getCrontab: () => crontab, setCrontab: (value: string) => (crontab = value) };
	}

	it("installs a launch agent when something is wanted and reports it installed", async () => {
		const h = harness("darwin", { appIndexing: { refreshIntervalMs: 60 * MIN } });
		const status = await h.scheduler.reconcile();
		expect(existsSync(join(h.home, "Library/LaunchAgents/com.autorag.app.refresh.plist"))).toBe(true);
		expect(h.calls).toContain("launchctl bootstrap gui/501 " + join(h.home, "Library/LaunchAgents/com.autorag.app.refresh.plist"));
		expect(status).toMatchObject({ supported: true, mechanism: "launchd", wanted: true, installed: true, intervalMs: 30 * MIN });
	});

	it("removes the launch agent when nothing is wanted any more", async () => {
		const h = harness("darwin", { appIndexing: { refreshIntervalMs: 60 * MIN } });
		await h.scheduler.reconcile();
		writeFileSync(join(dir, "config.json"), JSON.stringify({}));
		const status = await h.scheduler.reconcile();
		expect(existsSync(join(h.home, "Library/LaunchAgents/com.autorag.app.refresh.plist"))).toBe(false);
		expect(status.wanted).toBe(false);
	});

	it("replaces only its own cron line and leaves the user's lines alone", async () => {
		const h = harness("linux", { datasources: { discord: { pollingIntervalMs: 15 * MIN } } });
		h.setCrontab("MAILTO=me\n0 3 * * * /usr/bin/backup\n");
		await h.scheduler.reconcile();
		await h.scheduler.reconcile();
		const table = h.getCrontab();
		expect(table.startsWith("MAILTO=me\n0 3 * * * /usr/bin/backup\n")).toBe(true);
		expect(table.split("\n").filter((line) => line.includes(CRON_MARKER))).toHaveLength(1);
		expect(table).toContain("*/15 * * * *");

		writeFileSync(join(dir, "config.json"), JSON.stringify({}));
		await h.scheduler.reconcile();
		expect(h.getCrontab()).toBe("MAILTO=me\n0 3 * * * /usr/bin/backup\n");
	});

	it("flags a hand-made autorag cron line as a conflict instead of touching it", async () => {
		const h = harness("linux", {});
		h.setCrontab("*/30 * * * * /opt/homebrew/bin/autorag watch --once\n");
		const status = await h.scheduler.status();
		expect(status.conflicts).toEqual(["cron: */30 * * * * /opt/homebrew/bin/autorag watch --once"]);
		expect(h.getCrontab()).toBe("*/30 * * * * /opt/homebrew/bin/autorag watch --once\n");
	});

	it("is unsupported (not an error) on a platform with no scheduler", async () => {
		const h = harness("freebsd", { appIndexing: { refreshIntervalMs: 60 * MIN } });
		expect(await h.scheduler.reconcile()).toMatchObject({ supported: false, mechanism: null, installed: false, error: null });
	});
});
