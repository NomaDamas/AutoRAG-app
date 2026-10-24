import { mkdtemp, rm } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexingStatus } from "../src/shared/onboarding-contract";
import { ONBOARDING_CHANNELS } from "../src/shared/onboarding-contract";
import type { AppSettings, ConfigRefreshResult } from "../src/shared/settings-contract";
import type { OnboardingServiceDeps } from "../src/main/onboarding-service";
import { createOnboardingService } from "../src/main/onboarding-service";

/**
 * Holds the first read of `refresh-progress.json`, which keeps one poll tick in flight across the
 * end of the refresh: the interleaving that used to overwrite the final status. `lateTickDone`
 * resolves when that held tick has made its last read, so the tests wait on the tick itself and
 * never on a guessed duration.
 */
interface TickGate {
	held: Promise<void> | null;
	progressCalls: number;
	journalReads: number;
	lateTickDone: PromiseWithResolvers<void>;
}
const gate = vi.hoisted(
	(): TickGate => ({ held: null, progressCalls: 0, journalReads: 0, lateTickDone: Promise.withResolvers<void>() }),
);

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof FsPromises>();
	return {
		...original,
		stat: async (...args: Parameters<typeof original.stat>) => {
			const path = String(args[0]);
			if (path.endsWith("refresh-progress.json")) {
				gate.progressCalls += 1;
				if (gate.progressCalls === 1 && gate.held !== null) await gate.held;
			}
			try {
				return await original.stat(...args);
			} finally {
				// `settle` makes the first journal read; the held tick makes the second and last.
				if (path.endsWith("progress.jsonl")) {
					gate.journalReads += 1;
					if (gate.journalReads === 2) gate.lateTickDone.resolve();
				}
			}
		},
	};
});

const SETTINGS: AppSettings = {
	appearance: "light",
	language: "ko",
	launchAtLogin: false,
	showInMenuBar: true,
	autoInstallUpdates: true,
	errorReporting: false,
	usageAnalytics: false,
	showHiddenFiles: false,
	dupeyScanIntervalMinutes: 60,
	osMenuIntegration: false,
};

const directories: string[] = [];

beforeEach(() => {
	gate.held = null;
	gate.progressCalls = 0;
	gate.journalReads = 0;
	gate.lateTickDone = Promise.withResolvers<void>();
	vi.useFakeTimers();
});

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

interface Harness {
	readonly service: ReturnType<typeof createOnboardingService>;
	readonly emitted: IndexingStatus[];
	/** Ends the refresh, and resolves once the service has reported a final state. */
	readonly endRefresh: (outcome: ConfigRefreshResult | Error) => Promise<void>;
	/** Lets the held tick finish, and resolves once it has made its last read and settled. */
	readonly finishLateTick: () => Promise<void>;
}

async function start(): Promise<Harness> {
	const directory = await mkdtemp(join(tmpdir(), "autorag-onboarding-race-"));
	directories.push(directory);
	const refreshing = Promise.withResolvers<ConfigRefreshResult>();
	const tickHeld = Promise.withResolvers<void>();
	const finalReported = Promise.withResolvers<void>();
	gate.held = tickHeld.promise;
	const emitted: IndexingStatus[] = [];
	const deps: OnboardingServiceDeps = {
		userDataDir: directory,
		env: {},
		agentDir: directory,
		cwd: "/repo",
		platform: "darwin",
		home: "/Users/me",
		knownFolders: { desktop: "/Users/me/Desktop", documents: "/Users/me/Documents", downloads: "/Users/me/Downloads", pictures: "/Users/me/Pictures" },
		iCloudDrivePath: null,
		cloudDrives: async () => [],
		ocrEnabled: async () => false,
		configPath: join(directory, "config.json"),
		localSpec: async () => ({ eligible: true }),
		ensureLocalModel: async () => null,
		resolveWorkspacePath: async () => directory,
		refresh: () => refreshing.promise,
		credentials: { list: async () => [], set: async () => [], remove: async () => [], load: async () => [] },
		settings: { get: async () => SETTINGS, set: async (patch) => ({ ...SETTINGS, ...patch }) },
		detectSources: async () => ({ sources: [] }),
		gitToken: async () => null,
		useManagedModel: async () => undefined,
		send: (channel, payload) => {
			if (channel !== ONBOARDING_CHANNELS.indexProgress) return;
			const status = payload as IndexingStatus;
			emitted.push(status);
			if (status.state !== "running") finalReported.resolve();
		},
		openExternal: async () => undefined,
		relaunch: () => undefined,
		appBundlePath: () => "/Applications/AutoRAG.app",
		startDrag: () => undefined,
		pickFolders: async () => [],
		showNotification: async () => true,
		notificationsSupported: () => true,
		loginItemApplied: () => true,
		startPowerSaveBlocker: () => 1,
		stopPowerSaveBlocker: () => undefined,
		probeFullDiskAccess: async () => false,
		checkNetwork: async () => ({ ok: true, error: null }),
		startScans: async () => undefined,
		folderTotals: () => 10,
		onComplete: () => undefined,
	};
	const service = createOnboardingService(deps);
	await service.startIndexing({ folders: ["/Users/me/Documents"], sources: [], plan: "free" });
	// One poll interval elapses: that tick reads the progress file and is now held inside `stat`.
	await vi.advanceTimersByTimeAsync(1000);
	expect(gate.progressCalls).toBe(1);
	return {
		service,
		emitted,
		endRefresh: async (outcome) => {
			if (outcome instanceof Error) refreshing.reject(outcome);
			else refreshing.resolve(outcome);
			await finalReported.promise;
		},
		finishLateTick: async () => {
			tickHeld.resolve();
			await gate.lateTickDone.promise;
			// The tick's remaining work after its last read is microtasks only.
			await vi.advanceTimersByTimeAsync(0);
		},
	};
}

const OK: ConfigRefreshResult = { ok: true, methods: ["parsed", "minsync"], scanned: 3, written: 3, deleted: 0, skipped: 0, diagnostics: [], error: null };
const FAILED: ConfigRefreshResult = { ...OK, ok: false, error: "embedder unavailable" };

describe("the final indexing status", () => {
	it("stays failed, with its error, when a poll tick that began earlier completes after the refresh failed", async () => {
		const { service, emitted, endRefresh, finishLateTick } = await start();

		await endRefresh(FAILED);
		expect((await service.indexStatus()).state).toBe("failed");
		await finishLateTick();

		const final = await service.indexStatus();
		expect(final.state).toBe("failed");
		expect(final.error).toBe("embedder unavailable");
		expect(emitted.at(-1)?.state).toBe("failed");
		expect(service.isIndexing()).toBe(false);
		service.dispose();
	});

	it("stays failed when the refresh throws instead of returning", async () => {
		const { service, emitted, endRefresh, finishLateTick } = await start();

		await endRefresh(new Error("spawn minsync ENOENT"));
		await finishLateTick();

		const final = await service.indexStatus();
		expect(final.state).toBe("failed");
		expect(final.error).toBe("spawn minsync ENOENT");
		expect(emitted.at(-1)?.state).toBe("failed");
		service.dispose();
	});

	it("stays success at 100 % when a late poll tick completes after the refresh succeeded", async () => {
		const { service, emitted, endRefresh, finishLateTick } = await start();

		await endRefresh(OK);
		await finishLateTick();

		const final = await service.indexStatus();
		expect(final).toMatchObject({ state: "success", progress: 100, remainingMinutes: null, error: null });
		expect(emitted.at(-1)?.state).toBe("success");
		service.dispose();
	});

	it("never reports running after it has reported a final state", async () => {
		const { service, emitted, endRefresh, finishLateTick } = await start();

		await endRefresh(FAILED);
		await finishLateTick();

		const firstFinal = emitted.findIndex((status) => status.state !== "running");
		expect(firstFinal).toBeGreaterThan(-1);
		expect(emitted.slice(firstFinal).every((status) => status.state === "failed")).toBe(true);
		service.dispose();
	});
});
