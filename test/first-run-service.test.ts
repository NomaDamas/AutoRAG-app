import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SetupStatus } from "../src/shared/onboarding-contract";
import type { ConfigRefreshResult } from "../src/shared/settings-contract";
import {
	createFirstRunService,
	pickVerifiedDemo,
	parseDemoQuestions,
	readOnboardingPending,
	type FirstRunService,
	type FirstRunServiceDeps,
} from "../src/main/first-run-service";
import { SKIP_INDEX_PLAN_FINAL, seedSkipIndexFixtureHome } from "../src/main/skip-index-fixture";

/** Yields to the event loop: the run waits on real timers and disk, so microtasks alone are not enough. */
const flush = (): Promise<void> => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, 3);
	return promise;
};
const waitForStage = async (service: FirstRunService, stage: SetupStatus["stage"]): Promise<SetupStatus> => {
	for (let tick = 0; tick < 500; tick += 1) {
		const status = await service.status();
		if (status.stage === stage) return status;
		await flush();
	}
	return service.status();
};

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

async function workDir(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

const OK: ConfigRefreshResult = { ok: true, methods: ["parsed", "minsync"], scanned: 12, written: 12, deleted: 0, skipped: 0, diagnostics: [], error: null };

async function makeDeps(userDataDir: string, overrides: Partial<FirstRunServiceDeps> = {}): Promise<FirstRunServiceDeps> {
	const home = await workDir("autorag-firstrun-home-");
	const workspace = await workDir("autorag-firstrun-ws-");
	// The first run only pre-scans default folders that exist; one is enough.
	await mkdir(join(home, "Desktop"), { recursive: true });
	return {
		userDataDir,
		env: {},
		cwd: "/repo",
		platform: "darwin",
		home,
		knownFolders: { desktop: join(home, "Desktop"), documents: join(home, "Documents"), downloads: join(home, "Downloads") },
		iCloudDrivePath: null,
		configPath: join(userDataDir, "config.json"),
		resolveWorkspacePath: async () => workspace,
		refresh: async () => OK,
		recordIndex: () => undefined,
		scanFolders: async () => undefined,
		folderTotals: () => 12,
		refreshDuplicates: async () => undefined,
		// No model configured: smart indexing and the tour's question both give up silently.
		resolveModel: async () => Promise.reject(new Error("no model is configured")),
		complete: async () => Promise.reject(new Error("no model is configured")),
		retrieve: async () => [],
		scanOptions: { supportedExtensions: new Set([".txt", ".md", ".pdf"]), maxSourceBytes: 1024 * 1024 },
		language: () => "ko",
		send: () => undefined,
		openExternal: async () => undefined,
		startPowerSaveBlocker: () => 1,
		stopPowerSaveBlocker: () => undefined,
		probeFullDiskAccess: async () => false,
		onComplete: () => undefined,
		...overrides,
	};
}

async function writeState(directory: string, state: unknown): Promise<void> {
	await mkdir(join(directory, "onboarding"), { recursive: true });
	await writeFile(join(directory, "onboarding", "state.json"), JSON.stringify(state), "utf8");
}

describe("readOnboardingPending", () => {
	it("is pending on a fresh profile unless the QA skip flag is set", async () => {
		const directory = await workDir("autorag-firstrun-");
		expect(readOnboardingPending(directory, {})).toBe(true);
		expect(readOnboardingPending(directory, { AUTORAG_SKIP_ONBOARDING: "1" })).toBe(false);
	});

	it("follows the stored completed flag once a state file exists, even an old-format one", async () => {
		const directory = await workDir("autorag-firstrun-");
		await writeState(directory, { completed: true, draft: null });
		expect(readOnboardingPending(directory, { AUTORAG_SKIP_ONBOARDING: "1" })).toBe(false);

		await writeState(directory, { completed: false, draft: null });
		expect(readOnboardingPending(directory, { AUTORAG_SKIP_ONBOARDING: "1" })).toBe(true);
	});
});

describe("createFirstRunService run", () => {
	it("walks scanning → planning → indexing → preparing → ready and ends at a full bar", async () => {
		const directory = await workDir("autorag-firstrun-");
		const seen: SetupStatus[] = [];
		const service = createFirstRunService(await makeDeps(directory, { send: (_channel, payload) => seen.push(payload as SetupStatus) }));
		expect(service.pending()).toBe(true);
		await service.start();
		const final = await waitForStage(service, "ready");
		expect(final.stage).toBe("ready");
		expect(final.progress).toBe(100);
		expect(final.demo).toBeNull();
		expect(final.error).toBeNull();
		const stages = [...new Set(seen.map((entry) => entry.stage))];
		expect(stages).toEqual(["scanning", "planning", "indexing", "preparing", "ready"]);
		expect(Math.min(...seen.map((entry) => entry.progress))).toBeGreaterThanOrEqual(0);
		expect(final.progress).toBeGreaterThanOrEqual(Math.max(...seen.slice(0, -1).map((entry) => entry.progress)));
	});

	it("writes a keyword-only config and never an embedder block", async () => {
		const directory = await workDir("autorag-firstrun-");
		const deps = await makeDeps(directory);
		const service = createFirstRunService(deps);
		await service.start();
		await waitForStage(service, "ready");
		const config = JSON.parse(await readFile(deps.configPath, "utf8")) as Record<string, unknown>;
		expect(config.searchPaths).toEqual([join(deps.home, "Desktop")]);
		expect(config.appIndexing).toEqual({ semanticSearch: false });
		expect(config.minSync).toBeUndefined();
		// The cwd seed is replaced by the AutoRAG home workspace.
		expect(typeof config.workspacePath).toBe("string");
		expect(config.workspacePath).not.toBe("/repo");
	});

	it("returns the run in flight instead of starting a second one", async () => {
		const directory = await workDir("autorag-firstrun-");
		const gate = Promise.withResolvers<ConfigRefreshResult>();
		let refreshes = 0;
		const service = createFirstRunService(
			await makeDeps(directory, {
				refresh: () => {
					refreshes += 1;
					return gate.promise;
				},
			}),
		);
		await service.start();
		await waitForStage(service, "indexing");
		const second = await service.start();
		expect(second.stage).toBe("indexing");
		expect(refreshes).toBe(1);
		gate.resolve(OK);
		await waitForStage(service, "ready");
		// A finished run is returned as is, never restarted.
		expect((await service.start()).stage).toBe("ready");
		expect(refreshes).toBe(1);
	});

	it("records a failed index, then restarts the run on the next start", async () => {
		const directory = await workDir("autorag-firstrun-");
		const outcomes: boolean[] = [];
		let attempt = 0;
		const service = createFirstRunService(
			await makeDeps(directory, {
				refresh: async () => {
					attempt += 1;
					return attempt === 1 ? { ...OK, ok: false, error: "the disk is full" } : OK;
				},
				recordIndex: (outcome) => outcomes.push(outcome.ok),
			}),
		);
		await service.start();
		const failed = await waitForStage(service, "failed");
		expect(failed.error).toBe("the disk is full");
		expect(outcomes).toEqual([false]);
		await service.start();
		await waitForStage(service, "ready");
		expect(attempt).toBe(2);
		expect(outcomes).toEqual([false, true]);
	});

	it("leaves out a default folder whose pre-scan failed and still finishes the index", async () => {
		const directory = await workDir("autorag-firstrun-");
		const base = await makeDeps(directory);
		await mkdir(join(base.home, "Documents"), { recursive: true });
		const scanned: string[] = [];
		const service = createFirstRunService({
			...base,
			scanFolders: async (paths) => {
				scanned.push(...paths);
			},
			scanFailed: (path) => path.endsWith("Documents"),
		});
		await service.start();
		const final = await waitForStage(service, "ready");
		expect(final.stage).toBe("ready");
		// Scanned one at a time, and only the readable folder reaches searchPaths.
		expect(scanned).toEqual([join(base.home, "Desktop"), join(base.home, "Documents")]);
		const written = JSON.parse(await readFile(base.configPath, "utf8")) as { searchPaths: string[] };
		expect(written.searchPaths).toEqual([join(base.home, "Desktop")]);
	});

	it("stubIndex seeds the tour demo and refreshes duplicates over the mini-fixture home without scanning or indexing", async () => {
		const directory = await workDir("autorag-firstrun-");
		const base = await makeDeps(directory);
		seedSkipIndexFixtureHome(base.home);
		const seen: SetupStatus[] = [];
		let indexedOrScanned = false;
		let duplicatesRefreshed = 0;
		const service = createFirstRunService({
			...base,
			stubIndex: true,
			stubStepDelayMs: 5,
			send: (_channel, payload) => seen.push(payload as SetupStatus),
			scanFolders: async () => {
				indexedOrScanned = true;
			},
			refresh: async () => {
				indexedOrScanned = true;
				return OK;
			},
			refreshDuplicates: async () => {
				duplicatesRefreshed += 1;
			},
		});
		await service.start();
		const final = await waitForStage(service, "ready");
		expect(indexedOrScanned).toBe(false);
		expect(duplicatesRefreshed).toBe(1);
		expect(final.stage).toBe("ready");
		expect(final.progress).toBe(100);
		expect(final.demo).toEqual({
			question: "3분기 마케팅 비용이랑 신규 고객 수는 어떻게 바뀌었어?",
			sourcePath: join(base.home, "Documents", SKIP_INDEX_PLAN_FINAL),
			latencyMs: 14,
		});
		expect([...new Set(seen.map((entry) => entry.stage))]).toEqual(["scanning", "planning", "indexing", "preparing", "ready"]);
		const written = JSON.parse(await readFile(base.configPath, "utf8")) as { appIndexing?: { semanticSearch?: boolean }; searchPaths?: string[] };
		expect(written.appIndexing?.semanticSearch).toBe(false);
		expect(written.searchPaths).toEqual([join(base.home, "Desktop"), join(base.home, "Documents"), join(base.home, "Downloads")]);
	});
});

describe("createFirstRunService complete", () => {
	it("persists completion so the next service reports no pending run", async () => {
		const directory = await workDir("autorag-firstrun-");
		const service = createFirstRunService(await makeDeps(directory));
		await service.complete();
		expect(service.pending()).toBe(false);
		const persisted = JSON.parse(await readFile(join(directory, "onboarding", "state.json"), "utf8")) as { completed: boolean };
		expect(persisted.completed).toBe(true);
		expect(createFirstRunService(await makeDeps(directory)).pending()).toBe(false);
	});
});

describe("pickVerifiedDemo", () => {
	const docs = [
		{ sourcePath: "/docs/a.pdf", realSourcePath: "/docs/a.pdf" },
		{ sourcePath: "/docs/b.pdf", realSourcePath: "/docs/b.pdf" },
	];

	it("keeps the question whose document keyword retrieval returns, preferring the best rank then the lower latency", async () => {
		const retrieve = async (query: string): Promise<readonly { source: string }[]> =>
			query === "second question" ? [{ source: "/docs/b.pdf" }] : [{ source: "/other.pdf" }, { source: "/docs/a.pdf" }];
		let clock = 0;
		const demo = await pickVerifiedDemo(
			docs,
			[
				{ doc: 1, question: "first question" },
				{ doc: 2, question: "second question" },
			],
			retrieve,
			() => (clock += 5),
		);
		expect(demo).toEqual({ question: "second question", sourcePath: "/docs/b.pdf", latencyMs: 5 });
	});

	it("returns null when no question is answered from its own document", async () => {
		const demo = await pickVerifiedDemo(docs, [{ doc: 1, question: "off target" }], async () => [{ source: "/other.pdf" }]);
		expect(demo).toBeNull();
	});

	it("prefers the lower latency when two questions rank the same", async () => {
		let clock = 0;
		const retrieve = async (query: string): Promise<readonly { source: string }[]> => {
			clock += query === "slow" ? 50 : 5;
			return [{ source: query === "slow" ? "/docs/a.pdf" : "/docs/b.pdf" }];
		};
		const demo = await pickVerifiedDemo(
			docs,
			[
				{ doc: 1, question: "slow" },
				{ doc: 2, question: "fast" },
			],
			retrieve,
			() => clock,
		);
		expect(demo).toEqual({ question: "fast", sourcePath: "/docs/b.pdf", latencyMs: 5 });
	});
});

describe("parseDemoQuestions", () => {
	it("reads the model's JSON array and drops malformed entries", () => {
		expect(parseDemoQuestions('Here you go:\n[{"doc":1,"question":"What is X?"},{"doc":"2","question":""},{"nope":1}]')).toEqual([
			{ doc: 1, question: "What is X?" },
		]);
		expect(parseDemoQuestions("no json here")).toEqual([]);
	});
});
