import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetupStatus } from "../src/shared/onboarding-contract";
import type { ConfigRefreshResult } from "../src/shared/settings-contract";
import {
	createFirstRunService,
	detectCloudFolders,
	readableExcerpt,
	parseDemoQuestions,
	readOnboardingPending,
	type FirstRunService,
	type FirstRunServiceDeps,
} from "../src/main/first-run-service";

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
		judgeDemoQuestions: async (candidates) => candidates.map(() => null),
		answerDemoQuestion: async () => null,
		scanOptions: { supportedExtensions: new Set([".txt", ".md", ".pdf"]), maxSourceBytes: 1024 * 1024 },
		language: () => "ko",
		send: () => undefined,
		openExternal: async () => undefined,
		pickFolders: async () => [],
		startPowerSaveBlocker: () => 1,
		stopPowerSaveBlocker: () => undefined,
		probeFullDiskAccess: async () => false,
		onComplete: () => undefined,
		// These tests are about the stages; the tests of the question gate turn it back on.
		requireQuestion: false,
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

describe("first-run folders", () => {
	it("offers the OS's own folders switched on and every cloud drive, iCloud Drive included, switched off", async () => {
		const directory = await workDir("autorag-firstrun-");
		const deps = await makeDeps(directory);
		await mkdir(join(deps.home, "Documents"), { recursive: true });
		const icloud = join(deps.home, "Library", "Mobile Documents", "com~apple~CloudDocs");
		await mkdir(icloud, { recursive: true });
		await mkdir(join(deps.home, "Library", "CloudStorage", "GoogleDrive-me@example.com"), { recursive: true });
		await mkdir(join(deps.home, "Library", "CloudStorage", "Dropbox"), { recursive: true });
		const service = createFirstRunService({ ...deps, iCloudDrivePath: icloud });
		expect(await service.folders()).toEqual([
			{ path: join(deps.home, "Desktop"), kind: "desktop", selected: true },
			{ path: join(deps.home, "Documents"), kind: "documents", selected: true },
			{ path: icloud, kind: "iCloudDrive", selected: false },
			{ path: join(deps.home, "Library", "CloudStorage", "GoogleDrive-me@example.com"), kind: "googleDrive", selected: false },
			{ path: join(deps.home, "Library", "CloudStorage", "Dropbox"), kind: "dropbox", selected: false },
		]);
	});

	it("finds a classic ~/Dropbox on Windows and nothing under CloudStorage there", async () => {
		const home = await workDir("autorag-firstrun-home-");
		await mkdir(join(home, "Dropbox"), { recursive: true });
		await mkdir(join(home, "Library", "CloudStorage", "GoogleDrive-me"), { recursive: true });
		expect(detectCloudFolders(home, "win32")).toEqual([{ path: join(home, "Dropbox"), kind: "dropbox" }]);
	});

	it("reads only the chosen folders, ignores paths it never offered, and keeps the choice for a retry", async () => {
		const directory = await workDir("autorag-firstrun-");
		const scanned: string[] = [];
		let fail = true;
		const deps = await makeDeps(directory, {
			scanFolders: async (paths) => {
				scanned.push(...paths);
			},
			refresh: async () => (fail ? { ...OK, ok: false, error: "boom" } : OK),
		});
		await mkdir(join(deps.home, "Documents"), { recursive: true });
		const service = createFirstRunService(deps);
		await service.start([join(deps.home, "Documents"), "/etc"]);
		await waitForStage(service, "failed");
		expect(scanned).toEqual([join(deps.home, "Documents")]);
		fail = false;
		scanned.length = 0;
		await service.start();
		await waitForStage(service, "ready");
		expect(scanned).toEqual([join(deps.home, "Documents")]);
		const config = JSON.parse(await readFile(deps.configPath, "utf8")) as Record<string, unknown>;
		expect(config.searchPaths).toEqual([join(deps.home, "Documents")]);
	});

	it("reads the folders switched on by default when start is given none", async () => {
		const directory = await workDir("autorag-firstrun-");
		const scanned: string[] = [];
		const deps = await makeDeps(directory, {
			scanFolders: async (paths) => {
				scanned.push(...paths);
			},
			cloudFolders: () => [{ path: join(directory, "cloud"), kind: "dropbox" }],
		});
		await mkdir(join(directory, "cloud"), { recursive: true });
		const service = createFirstRunService(deps);
		await service.start();
		await waitForStage(service, "ready");
		expect(scanned).toEqual([join(deps.home, "Desktop")]);
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
		expect(stages).toEqual(["scanning", "planning", "duplicates", "indexing", "preparing", "ready"]);
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

	it("scans while anonymous model access is still being provisioned, and plans only once it settles", async () => {
		const directory = await workDir("autorag-firstrun-");
		const access = Promise.withResolvers<unknown>();
		const order: string[] = [];
		const service = createFirstRunService(
			await makeDeps(directory, {
				ensureModelAccess: () => {
					order.push("access-start");
					return access.promise;
				},
				scanFolders: async () => void order.push("scan"),
				resolveModel: async () => {
					order.push("plan-needs-model");
					throw new Error("no model is configured");
				},
			}),
		);
		await service.start();
		await waitForStage(service, "scanning");
		for (let tick = 0; tick < 30 && !order.includes("scan"); tick += 1) await flush();
		expect(order).toEqual(["access-start", "scan"]);
		expect((await service.status()).stage).toBe("scanning");
		access.resolve(true);
		expect((await waitForStage(service, "ready")).stage).toBe("ready");
	});

	it("indexes on without a model when anonymous access fails", async () => {
		const directory = await workDir("autorag-firstrun-");
		const service = createFirstRunService(
			await makeDeps(directory, { ensureModelAccess: async () => Promise.reject(new Error("offline")) }),
		);
		await service.start();
		const final = await waitForStage(service, "ready");
		expect(final.stage).toBe("ready");
		expect(final.error).toBeNull();
	});

	it("scans for duplicates as soon as the folders are known and holds the first index back until that scan settles", async () => {
		const directory = await workDir("autorag-firstrun-");
		const scan = Promise.withResolvers<void>();
		const order: string[] = [];
		const service = createFirstRunService(
			await makeDeps(directory, {
				scanFolders: async () => void order.push("folders"),
				refreshDuplicates: () => {
					order.push("duplicates-start");
					return scan.promise.then(() => void order.push("duplicates-done"));
				},
				refresh: async () => {
					order.push("index");
					return OK;
				},
			}),
		);
		await service.start();
		for (let tick = 0; tick < 60 && !order.includes("duplicates-start"); tick += 1) await flush();
		for (let tick = 0; tick < 20; tick += 1) await flush();
		// Folders known, scan running, and the index has not been started behind it.
		expect(order).toEqual(["folders", "duplicates-start"]);
		scan.resolve();
		expect((await waitForStage(service, "ready")).stage).toBe("ready");
		expect(order).toEqual(["folders", "duplicates-start", "duplicates-done", "index"]);
	});

	it("indexes on when the duplicate scan fails", async () => {
		const directory = await workDir("autorag-firstrun-");
		const service = createFirstRunService(await makeDeps(directory, { refreshDuplicates: async () => Promise.reject(new Error("dupey is missing")) }));
		await service.start();
		const final = await waitForStage(service, "ready");
		expect(final.stage).toBe("ready");
		expect(final.error).toBeNull();
	});

	it("shows the duplicate scan as its own stage and moves the bar while it runs, never past the next stage's start", async () => {
		const directory = await workDir("autorag-firstrun-");
		const scan = Promise.withResolvers<void>();
		const seen: SetupStatus[] = [];
		let clock = 1_000_000;
		const service = createFirstRunService(
			await makeDeps(directory, {
				now: () => clock,
				refreshDuplicates: () => scan.promise,
				send: (_channel, payload) => seen.push(payload as SetupStatus),
			}),
		);
		await service.start();
		await waitForStage(service, "duplicates");
		const before = (await service.status()).progress;
		// Time passes with dupey still scanning: the bar creeps through its band and stops short of the index's start.
		clock += 120_000;
		for (let tick = 0; tick < 1_500 && (await service.status()).progress <= before; tick += 1) await flush();
		const during = await service.status();
		expect(during.stage).toBe("duplicates");
		expect(during.progress).toBeGreaterThan(before);
		expect(during.progress).toBeLessThan(20);
		scan.resolve();
		await waitForStage(service, "ready");
		const stages = seen.map((entry) => entry.stage);
		expect(stages.indexOf("duplicates")).toBeGreaterThan(stages.indexOf("planning"));
		expect(stages.indexOf("duplicates")).toBeLessThan(stages.indexOf("indexing"));
		// The bar only ever moves forward.
		const bars = seen.map((entry) => entry.progress);
		expect(bars).toEqual([...bars].sort((a, b) => a - b));
	});

	it("does not reach ready without the tour's question: it stops on the retry screen with the index kept", async () => {
		const directory = await workDir("autorag-firstrun-");
		const service = createFirstRunService(await makeDeps(directory, { requireQuestion: true }));
		await service.start();
		const final = await waitForStage(service, "failed");
		expect(final.stage).toBe("failed");
		expect(final.demo).toBeNull();
		expect(final.error).not.toBeNull();
		// The first index itself finished: the retry is about the question, and the index is recorded as done.
		await vi.waitFor(async () => expect(typeof (await readIndexingFinishedAt(directory))).toBe("string"), { timeout: 3_000 });
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

/** The persisted onboarding state's index record, read back from disk; undefined until the service has written one (a file caught mid-write counts as not yet written). */
async function readIndexingFinishedAt(directory: string): Promise<string | null | undefined> {
	const text = await readFile(join(directory, "onboarding", "state.json"), "utf8").catch(() => null);
	if (text === null || text.trim() === "") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || !("indexing" in parsed)) return undefined;
	const indexing = parsed.indexing;
	if (typeof indexing !== "object" || indexing === null || !("finishedAt" in indexing)) return undefined;
	return typeof indexing.finishedAt === "string" ? indexing.finishedAt : null;
}

describe("an index that outlives the first run", () => {
	const unfinished = { completed: true, indexing: { startedAt: "2026-11-17T00:00:00.000Z", finishedAt: null } };

	it("is written down as unfinished before the first file is read, so a quit leaves it to carry on", async () => {
		const directory = await workDir("autorag-firstrun-");
		const gate = Promise.withResolvers<ConfigRefreshResult>();
		const service = createFirstRunService(await makeDeps(directory, { refresh: () => gate.promise }));
		await service.start();
		await waitForStage(service, "indexing");
		for (let tick = 0; tick < 60 && (await readIndexingFinishedAt(directory)) === undefined; tick += 1) await flush();
		expect(await readIndexingFinishedAt(directory)).toBeNull();
		expect(service.isIndexing()).toBe(true);
		gate.resolve(OK);
		await waitForStage(service, "ready");
		await flush();
		expect(typeof (await readIndexingFinishedAt(directory))).toBe("string");
	});

	it("reads on at the next launch when the first run was finished but the index was not, and marks it finished", async () => {
		const directory = await workDir("autorag-firstrun-");
		await writeState(directory, unfinished);
		let refreshes = 0;
		const service = createFirstRunService(await makeDeps(directory, { refresh: async () => (refreshes += 1, OK) }));
		expect(service.pending()).toBe(false);
		service.resumeIndexing();
		expect(service.isIndexing()).toBe(true);
		for (let tick = 0; tick < 200 && service.isIndexing(); tick += 1) await flush();
		expect(refreshes).toBe(1);
		expect(typeof (await readIndexingFinishedAt(directory))).toBe("string");
		service.resumeIndexing();
		expect(refreshes).toBe(1);
	});

	it("stays unfinished when the resumed run does not succeed, so the launch after tries again", async () => {
		const directory = await workDir("autorag-firstrun-");
		await writeState(directory, unfinished);
		const service = createFirstRunService(await makeDeps(directory, { refresh: async () => ({ ...OK, ok: false, error: "another refresh holds the lock" }) }));
		service.resumeIndexing();
		for (let tick = 0; tick < 200 && service.isIndexing(); tick += 1) await flush();
		expect(await readIndexingFinishedAt(directory)).toBeNull();
	});

	it("does not resume while the first run is still pending, or when the first index finished", async () => {
		const pendingDir = await workDir("autorag-firstrun-");
		await writeState(pendingDir, { completed: false, indexing: { startedAt: "2026-11-17T00:00:00.000Z", finishedAt: null } });
		let refreshes = 0;
		const refresh = async (): Promise<ConfigRefreshResult> => (refreshes += 1, OK);
		createFirstRunService(await makeDeps(pendingDir, { refresh })).resumeIndexing();
		const doneDir = await workDir("autorag-firstrun-");
		await writeState(doneDir, { completed: true, indexing: { startedAt: "2026-11-17T00:00:00.000Z", finishedAt: "2026-11-17T00:05:00.000Z" } });
		createFirstRunService(await makeDeps(doneDir, { refresh })).resumeIndexing();
		await flush();
		expect(refreshes).toBe(0);
	});
});

describe("readableExcerpt", () => {
	const prose = "이번 분기 사업 계획의 핵심은 신규 고객 확보입니다. 영업팀은 3월까지 파일럿 세 곳을 확정하고, 연구팀은 검색 품질 평가를 마칩니다. ".repeat(4);

	it("keeps prose and strips markup and wordless lines", () => {
		const text = readableExcerpt(`<table><tr><td>${prose}</td></tr></table>\n\n= = = = = =\n12 34 56\n`);
		expect(text).toContain("신규 고객 확보");
		expect(text).not.toContain("<td>");
		expect(text).not.toContain("= = =");
	});

	it("rejects numeric logs and text too short to ask about", () => {
		expect(readableExcerpt("13 38 42\n06 38 39\n".repeat(80))).toBeNull();
		expect(readableExcerpt("( 1 / 1 )\n= = = = = = = = = =\n".repeat(30))).toBeNull();
		expect(readableExcerpt("짧은 메모")).toBeNull();
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
