import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ONBOARDING_CHANNELS, type DetectedSource, type OnboardingDraft, type SourceDetection } from "../src/shared/onboarding-contract";
import type { AppSettings, ConfigRefreshResult } from "../src/shared/settings-contract";
import { DEFAULT_SIDEBAR_SETTINGS } from "../src/shared/sidebar-contract";
import type { OnboardingServiceDeps } from "../src/main/onboarding-service";
import { createOnboardingService, readOnboardingPending } from "../src/main/onboarding-service";
import { storeDazziPlanCredential } from "../src/main/dazzi-plan-credential";
import { modelTotalBytes, nativeQwen3Spec } from "../src/main/model-download";

/** Yields to the event loop: the final status read after a refresh touches the disk, so microtasks alone are not enough. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2));

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

async function workDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "autorag-onboarding-"));
	directories.push(directory);
	return directory;
}

async function writeState(directory: string, state: unknown): Promise<void> {
	await mkdir(join(directory, "onboarding"), { recursive: true });
	await writeFile(join(directory, "onboarding", "state.json"), JSON.stringify(state), "utf8");
}

const DRAFT: OnboardingDraft = {
	version: 1,
	stepId: "folders",
	notifications: false,
	network: false,
	launchAtLogin: false,
	folders: [{ path: "/Users/me/Documents", selected: true }],
	embed: "local",
	cloudConsent: false,
	sources: [],
	plan: "free",
	planConfirmed: false,
	model: null,
};

const DEFAULT_SETTINGS: AppSettings = {
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
	approvalMode: "auto",
	sidebar: DEFAULT_SIDEBAR_SETTINGS,
};

function makeDeps(userDataDir: string, env: NodeJS.ProcessEnv = {}): OnboardingServiceDeps {
	return {
		userDataDir,
		env,
		// Pi's agent home is the user data dir here, so a test never reads the developer's own sign-in.
		agentDir: userDataDir,
		cwd: "/repo",
		platform: "darwin",
		home: "/Users/me",
		knownFolders: { desktop: "/Users/me/Desktop", documents: "/Users/me/Documents", downloads: "/Users/me/Downloads", pictures: "/Users/me/Pictures" },
		iCloudDrivePath: null,
		cloudDrives: async () => [],
		ocrEnabled: async () => false,
		localSpec: async () => ({ eligible: true }),
		configPath: join(userDataDir, "config.json"),
		resolveWorkspacePath: async () => userDataDir,
		refresh: async () => ({ ok: true, methods: [], scanned: 0, written: 0, deleted: 0, skipped: 0, diagnostics: [], error: null }),
		ensureLocalModel: async () => null,
		recordIndex: () => undefined,
		refreshKeyword: async () => undefined,
		credentials: { list: async () => [], set: async () => [], remove: async () => [], load: async () => [] },
		settings: { get: async () => DEFAULT_SETTINGS, set: async (patch) => ({ ...DEFAULT_SETTINGS, ...patch }) },
		detectSources: async () => ({ sources: [] }),
		gitToken: async () => null,
		useManagedModel: async () => undefined,
		checkModel: async () => ({ ok: true, latencyMs: 1 }),
		send: () => undefined,
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
		folderTotals: () => 0,
		onComplete: () => undefined,
	};
}

describe("readOnboardingPending", () => {
	it("is pending on a fresh profile unless the skip flag is set", async () => {
		const directory = await workDir();
		expect(readOnboardingPending(directory, {})).toBe(true);
		expect(readOnboardingPending(directory, { AUTORAG_SKIP_ONBOARDING: "1" })).toBe(false);
	});

	it("follows the stored completed flag once a state file exists", async () => {
		const directory = await workDir();
		await writeState(directory, { completed: true, draft: null });
		expect(readOnboardingPending(directory, { AUTORAG_SKIP_ONBOARDING: "1" })).toBe(false);

		await writeState(directory, { completed: false, draft: null });
		expect(readOnboardingPending(directory, { AUTORAG_SKIP_ONBOARDING: "1" })).toBe(true);
	});
});

describe("createOnboardingService persistence", () => {
	it("saves the draft and resumes at the same step on reload", async () => {
		const directory = await workDir();
		const service = createOnboardingService(makeDeps(directory));
		expect(service.pending()).toBe(true);
		await service.save(DRAFT);
		const reloaded = createOnboardingService(makeDeps(directory));
		const snapshot = await reloaded.load();
		expect(snapshot.pending).toBe(true);
		expect(snapshot.draft).toEqual(DRAFT);
	});

	it("keeps a draft that chose any listed plan, Max included, and refuses an unknown one", async () => {
		const directory = await workDir();
		for (const plan of ["free", "air", "pro", "max", "byok"] as const) {
			await createOnboardingService(makeDeps(directory)).save({ ...DRAFT, plan });
			expect((await createOnboardingService(makeDeps(directory)).load()).draft?.plan).toBe(plan);
		}
		await expect(createOnboardingService(makeDeps(directory)).save({ ...DRAFT, plan: "ultra" })).rejects.toThrow();
	});

	it("starts indexing for an account on Max", async () => {
		const directory = await workDir();
		const service = createOnboardingService(makeDeps(directory));
		await expect(service.startIndexing({ folders: ["/Users/me/Documents"], embed: "none", sources: [], plan: "max", model: null })).resolves.toBeDefined();
	});

	it("rejects a malformed draft", async () => {
		const directory = await workDir();
		const service = createOnboardingService(makeDeps(directory));
		await expect(service.save({ stepId: "folders" })).rejects.toThrow();
	});

	it("marks onboarding done and stops reporting pending", async () => {
		const directory = await workDir();
		const service = createOnboardingService(makeDeps(directory));
		await service.save(DRAFT);
		await service.complete();
		expect(service.pending()).toBe(false);
		const persisted = JSON.parse(await readFile(join(directory, "onboarding", "state.json"), "utf8")) as { completed: boolean };
		expect(persisted.completed).toBe(true);
		const fresh = createOnboardingService(makeDeps(directory));
		expect(fresh.pending()).toBe(false);
		expect((await fresh.load()).draft).toEqual(DRAFT);
	});

	it("starts local-only indexing (parsed + minsync) and settles to success when the refresh resolves", async () => {
		const directory = await workDir();
		const gate = Promise.withResolvers<ConfigRefreshResult>();
		const requestedMethods: Array<readonly string[] | undefined> = [];
		const deps: OnboardingServiceDeps = {
			...makeDeps(directory),
			refresh: (methods) => {
				requestedMethods.push(methods);
				return gate.promise;
			},
		};
		const service = createOnboardingService(deps);
		const status = await service.startIndexing({
			folders: ["/Users/me/Documents"],
			sources: [{ id: "slack" }],
			plan: "byok",
		});
		expect(status.state).toBe("running");
		expect(requestedMethods).toEqual([["parsed", "minsync"]]);
		expect(service.isIndexing()).toBe(true);
		gate.resolve({ ok: true, methods: ["parsed", "minsync"], scanned: 0, written: 0, deleted: 0, skipped: 0, diagnostics: [], error: null });
		// Flush microtasks; no wall-clock wait.
		for (let tick = 0; tick < 100 && service.isIndexing(); tick += 1) await flush();
		expect((await service.indexStatus()).state).toBe("success");
		expect(service.isIndexing()).toBe(false);
	});

	it("writes the native Qwen3 embedder on first index and detects the native MinSync model cache", async () => {
		const directory = await workDir();
		const nativeSnapshot = join(
			directory,
			".cache",
			"minsync",
			"models",
			"models--Qwen--Qwen3-Embedding-0.6B",
			"snapshots",
			"97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3",
		);
		await mkdir(nativeSnapshot, { recursive: true });
		const service = createOnboardingService({ ...makeDeps(directory), home: directory });
		// Only some of the files: the model is not usable, so it must not read as downloaded.
		await writeFile(join(nativeSnapshot, "model.safetensors"), "weights");
		expect((await service.embedding()).cached).toBe(false);

		// Every file at its pinned size and the ref written (sparse files: no 1.2 GB on disk).
		const spec = nativeQwen3Spec();
		for (const file of spec.files) {
			await writeFile(join(nativeSnapshot, file.name), "");
			await truncate(join(nativeSnapshot, file.name), file.bytes);
		}
		await mkdir(join(nativeSnapshot, "..", "..", "refs"), { recursive: true });
		await writeFile(join(nativeSnapshot, "..", "..", "refs", "main"), spec.revision);
		const info = await service.embedding();
		expect(info.profile).toBe("native:Qwen/Qwen3-Embedding-0.6B");
		expect(info.cached).toBe(true);
		expect(info.modelBytes).toBe(modelTotalBytes(spec));
		expect(info.localModel).toBe(true);

		await service.startIndexing({
			folders: ["/Users/me/Documents"],
			sources: [],
			plan: "byok",
		});
		for (let tick = 0; tick < 100 && service.isIndexing(); tick += 1) await flush();

		const config = JSON.parse(await readFile(join(directory, "config.json"), "utf8")) as {
			minSync?: { embedder?: Record<string, unknown> };
		};
		expect(config.minSync?.embedder).toEqual({ id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 });
		service.dispose();
	});

	it("on a machine below the local spec: reports it, refuses a local first index, and writes no embedder", async () => {
		const directory = await workDir();
		const weak = { eligible: false, reason: "apple-base-chip", vars: { chip: "Apple M2" } } as const;
		const service = createOnboardingService({ ...makeDeps(directory), localSpec: async () => weak });

		expect((await service.embedding()).localSpec).toEqual(weak);
		await expect(service.startIndexing({ folders: ["/Users/me/Documents"], embed: "local", sources: [], plan: "free" })).rejects.toThrow(/Apple M2/u);
		expect(service.isIndexing()).toBe(false);
		await expect(readFile(join(directory, "config.json"), "utf8")).rejects.toThrow();

		// Keyword-only search needs no model, so the same machine can still index.
		await service.startIndexing({ folders: ["/Users/me/Documents"], embed: "none", sources: [], plan: "free" });
		for (let tick = 0; tick < 100 && service.isIndexing(); tick += 1) await flush();
		service.dispose();
	});

	it("on a machine that meets the local spec: reports it eligible", async () => {
		const directory = await workDir();
		expect((await createOnboardingService(makeDeps(directory)).embedding()).localSpec).toEqual({ eligible: true });
	});

	describe("the on-device model download", () => {
		const request = { folders: ["/Users/me/Documents"], sources: [], plan: "free" } as const;

		it("waits for the model before the first index and refreshes once it is there", async () => {
			const directory = await workDir();
			const order: string[] = [];
			const gate = Promise.withResolvers<string | null>();
			const service = createOnboardingService({
				...makeDeps(directory),
				ensureLocalModel: () => {
					order.push("model");
					return gate.promise;
				},
				refresh: async () => {
					order.push("refresh");
					return { ok: true, methods: [], scanned: 0, written: 0, deleted: 0, skipped: 0, diagnostics: [], error: null };
				},
			});

			await service.startIndexing({ ...request, embed: "local" });
			await flush();
			expect(order).toEqual(["model"]);
			expect((await service.indexStatus()).state).toBe("running");

			gate.resolve(null);
			for (let tick = 0; tick < 100 && service.isIndexing(); tick += 1) await flush();
			expect(order).toEqual(["model", "refresh"]);
			expect((await service.indexStatus()).state).toBe("success");
			service.dispose();
		});

		it("fails the first index with the download's error and never refreshes", async () => {
			const directory = await workDir();
			let refreshed = false;
			const service = createOnboardingService({
				...makeDeps(directory),
				ensureLocalModel: async () => "no network",
				refresh: async () => {
					refreshed = true;
					return { ok: true, methods: [], scanned: 0, written: 0, deleted: 0, skipped: 0, diagnostics: [], error: null };
				},
			});

			await service.startIndexing({ ...request, embed: "local" });
			for (let tick = 0; tick < 100 && service.isIndexing(); tick += 1) await flush();

			const status = await service.indexStatus();
			expect(status.state).toBe("failed");
			expect(status.error).toContain("no network");
			expect(refreshed).toBe(false);
			service.dispose();
		});

		it("does not touch the model for keyword-only or cloud embedding", async () => {
			const directory = await workDir();
			let asked = 0;
			for (const embed of ["none", "cloud"] as const) {
				const service = createOnboardingService({
					...makeDeps(await workDir()),
					ensureLocalModel: async () => {
						asked += 1;
						return null;
					},
				});
				await service.startIndexing({ ...request, embed });
				for (let tick = 0; tick < 100 && service.isIndexing(); tick += 1) await flush();
				service.dispose();
			}
			expect(asked).toBe(0);
			expect(directory).toBeDefined();
		});

		it("tells the embedding step that no download is needed when the config already names a server of the user's own", async () => {
			const directory = await workDir();
			await writeFile(join(directory, "config.json"), JSON.stringify({ minSync: { embedder: { id: "tei:bge", baseUrl: "http://10.0.0.5:8080" } } }));

			expect((await createOnboardingService(makeDeps(directory)).embedding()).localModel).toBe(false);
			expect((await createOnboardingService(makeDeps(await workDir())).embedding()).localModel).toBe(true);
		});

		it("does not download when the user's own server is already configured", async () => {
			const directory = await workDir();
			await writeFile(join(directory, "config.json"), JSON.stringify({ minSync: { embedder: { id: "openai:text-embedding-3-small", baseUrl: "https://example.com" } } }));
			let asked = 0;
			const service = createOnboardingService({
				...makeDeps(directory),
				ensureLocalModel: async () => {
					asked += 1;
					return null;
				},
			});
			await service.startIndexing({ ...request, embed: "local" });
			for (let tick = 0; tick < 100 && service.isIndexing(); tick += 1) await flush();
			expect(asked).toBe(0);
			service.dispose();
		});
	});

	it("saves and resumes a draft whose model comes from any provider the Settings page can connect", async () => {
		const directory = await workDir();
		const service = createOnboardingService(makeDeps(directory));
		const draft: OnboardingDraft = { ...DRAFT, plan: "byok", stepId: "model", model: { provider: "openai-codex", modelId: "gpt-x", verified: true } };
		await service.save(draft);
		expect((await createOnboardingService(makeDeps(directory)).load()).draft).toEqual(draft);
		await expect(service.save({ ...draft, model: { provider: "", modelId: "gpt-x", verified: true } })).rejects.toThrow();
	});

	it("resumes a draft saved on the role step, and runs the model check through the injected caller", async () => {
		const directory = await workDir();
		const calls: string[] = [];
		const service = createOnboardingService({ ...makeDeps(directory), checkModel: async () => (calls.push("check"), { ok: false, error: "401" }) });
		const draft: OnboardingDraft = { ...DRAFT, plan: "byok", stepId: "roles", model: { provider: "custom-x", modelId: "m", verified: true } };
		await service.save(draft);
		expect((await createOnboardingService(makeDeps(directory)).load()).draft).toEqual(draft);
		expect(await service.checkModel()).toEqual({ ok: false, error: "401" });
		expect(calls).toEqual(["check"]);
	});

	it("leaves the model connected on the model step alone when the BYOK first index starts, and never swaps in the Dazzi account's", async () => {
		const directory = await workDir();
		const configured = { provider: "anthropic", id: "claude-x", apiKeyEnv: "ANTHROPIC_API_KEY" };
		await writeFile(join(directory, "config.json"), JSON.stringify({ model: configured }), "utf8");
		let managed = 0;
		const service = createOnboardingService({ ...makeDeps(directory), useManagedModel: async () => void (managed += 1) });
		await service.startIndexing({ folders: ["/Users/me/Documents"], embed: "none", sources: [], plan: "byok" });
		for (let tick = 0; tick < 100 && service.isIndexing(); tick += 1) await flush();
		expect(JSON.parse(await readFile(join(directory, "config.json"), "utf8")).model).toEqual(configured);
		expect(managed).toBe(0);
		service.dispose();
	});

	describe("how a first index ends", () => {
		const request = { folders: ["/Users/me/Documents"], sources: [], plan: "free" } as const;
		const settled = async (service: ReturnType<typeof createOnboardingService>): Promise<void> => {
			for (let tick = 0; tick < 100 && service.isIndexing(); tick += 1) await flush();
		};
		const result = (patch: Partial<ConfigRefreshResult>): ConfigRefreshResult => ({
			ok: true,
			methods: ["parsed", "minsync"],
			scanned: 0,
			written: 0,
			deleted: 0,
			skipped: 0,
			diagnostics: [],
			error: null,
			...patch,
		});

		it("says what stopped a failed run and shows no skipped files", async () => {
			const directory = await workDir();
			const service = createOnboardingService({
				...makeDeps(directory),
				refresh: async () =>
					result({
						ok: false,
						error: "HTTP 402",
						diagnostics: [{ code: "embedder-preflight-failed", severity: "error", message: "HTTP 402", reason: "rejected" }],
					}),
			});
			await service.startIndexing({ ...request, embed: "cloud" });
			await settled(service);
			const status = await service.indexStatus();
			expect(status.state).toBe("failed");
			expect(status.failure).toEqual({ reason: "embedder-config", folders: [], code: "embedder-preflight-failed" });
			expect(status.skipped).toBe(0);
			expect(status.remainingMinutes).toBeNull();
			service.dispose();
		});

		it("tells a full disk from any other failed download", async () => {
			const directory = await workDir();
			const service = createOnboardingService({ ...makeDeps(directory), ensureLocalModel: async () => "write failed (ENOSPC: no space left on device)" });
			await service.startIndexing({ ...request, embed: "local" });
			await settled(service);
			expect((await service.indexStatus()).failure?.reason).toBe("disk-full");

			const offline = createOnboardingService({ ...makeDeps(await workDir()), ensureLocalModel: async () => "no network" });
			await offline.startIndexing({ ...request, embed: "local" });
			await settled(offline);
			expect((await offline.indexStatus()).failure?.reason).toBe("model-download");
			service.dispose();
			offline.dispose();
		});

		it("counts the files a successful run left out", async () => {
			const directory = await workDir();
			const service = createOnboardingService({
				...makeDeps(directory),
				refresh: async () =>
					result({
						diagnostics: [
							{ code: "files-left-out", severity: "warning", message: "x", count: 4 },
							{ code: "parse-killed", severity: "warning", message: "x", count: 2 },
							{ code: "minsync-file-skipped", severity: "warning", message: "x" },
						],
					}),
			});
			await service.startIndexing({ ...request, embed: "local" });
			await settled(service);
			const status = await service.indexStatus();
			expect(status.state).toBe("success");
			expect(status.skipped).toBe(7);
			expect(status.failure).toBeNull();
			service.dispose();
		});

		it("hands the finished run to the Finder's problem record", async () => {
			const directory = await workDir();
			const recorded: Array<{ ok: boolean; error: string | null }> = [];
			const service = createOnboardingService({
				...makeDeps(directory),
				refresh: async () => result({ ok: false, error: "boom" }),
				recordIndex: (outcome) => recorded.push({ ok: outcome.ok, error: outcome.error }),
			});
			await service.startIndexing({ ...request, embed: "local" });
			await settled(service);
			expect(recorded).toEqual([{ ok: false, error: "boom" }]);
			service.dispose();
		});

		it("starts the keyword index when Dazzi is opened after a failed run, and not after a good one", async () => {
			let keyword = 0;
			const failed = createOnboardingService({
				...makeDeps(await workDir()),
				refresh: async () => result({ ok: false, error: "boom" }),
				refreshKeyword: async () => {
					keyword += 1;
				},
			});
			await failed.startIndexing({ ...request, embed: "local" });
			await settled(failed);
			await failed.complete();
			expect(keyword).toBe(1);

			const good = createOnboardingService({
				...makeDeps(await workDir()),
				refreshKeyword: async () => {
					keyword += 1;
				},
			});
			await good.startIndexing({ ...request, embed: "local" });
			await settled(good);
			await good.complete();
			expect(keyword).toBe(1);
			failed.dispose();
			good.dispose();
		});
	});

	it("saves and reloads a draft that chose keyword-only search", async () => {
		const directory = await workDir();
		const service = createOnboardingService(makeDeps(directory));
		await service.save({ ...DRAFT, embed: "none" });
		expect((await createOnboardingService(makeDeps(directory)).load()).draft?.embed).toBe("none");
	});

	it("indexes keyword-only with embed=none: no embedder is written, semantic search is switched off, and a later local run switches it back on", async () => {
		const directory = await workDir();
		const service = createOnboardingService(makeDeps(directory));
		await service.startIndexing({ folders: ["/Users/me/Documents"], embed: "none", sources: [], plan: "free" });
		for (let tick = 0; tick < 100 && service.isIndexing(); tick += 1) await flush();
		const read = async (): Promise<{ minSync?: { embedder?: unknown }; appIndexing?: Record<string, unknown> }> =>
			JSON.parse(await readFile(join(directory, "config.json"), "utf8"));

		const none = await read();
		expect(none.minSync?.embedder).toBeUndefined();
		expect(none.appIndexing).toEqual({ semanticSearch: false });
		service.dispose();

		const again = createOnboardingService(makeDeps(directory));
		await again.startIndexing({ folders: ["/Users/me/Documents"], embed: "local", sources: [], plan: "free" });
		for (let tick = 0; tick < 100 && again.isIndexing(); tick += 1) await flush();
		const local = await read();
		expect(local.minSync?.embedder).toEqual({ id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 });
		expect(local.appIndexing).toBeUndefined();
		again.dispose();
	});

	it("suggests Desktop, Documents, Downloads and iCloud Drive already selected, and leaves Pictures and cloud drives for the user to add", async () => {
		const directory = await workDir();
		const folders = { desktop: join(directory, "Desktop"), documents: join(directory, "Documents"), downloads: join(directory, "Downloads"), pictures: join(directory, "Pictures") };
		const icloud = join(directory, "iCloud");
		const cloud = join(directory, "Drive");
		for (const path of [...Object.values(folders), icloud, cloud]) await mkdir(path, { recursive: true });
		const service = createOnboardingService({ ...makeDeps(directory), knownFolders: folders, iCloudDrivePath: icloud, cloudDrives: async () => [{ path: cloud, name: "Drive" }] });

		const candidates = await service.folderCandidates();

		expect(candidates.map((candidate) => [candidate.kind, candidate.defaultSelected])).toEqual([
			["desktop", true],
			["documents", true],
			["icloud", true],
			["downloads", true],
			["pictures", false],
			["cloud", false],
		]);
	});

	it("keeps the smart-indexing proposals in the draft across a reload and refuses malformed ones", async () => {
		const directory = await workDir();
		const scope = [{ path: "/Users/me/Documents/Zoom", root: "/Users/me/Documents", reason: "Recordings", files: 12, bytes: 4096, excluded: true }];
		const service = createOnboardingService(makeDeps(directory));
		await service.save({ ...DRAFT, smartScope: scope });

		expect((await createOnboardingService(makeDeps(directory)).load()).draft?.smartScope).toEqual(scope);
		await expect(service.save({ ...DRAFT, smartScope: [{ path: "relative", root: "/Users/me/Documents", reason: "x", files: 1, bytes: 1, excluded: true }] })).rejects.toThrow();
		await expect(service.save({ ...DRAFT, smartScope: "nope" })).rejects.toThrow();
	});

	it("writes the excluded folders into excludePaths beside the user's own and counts only the files that remain", async () => {
		const directory = await workDir();
		await writeFile(join(directory, "config.json"), JSON.stringify({ excludePaths: ["/keep"] }), "utf8");
		const service = createOnboardingService({ ...makeDeps(directory), folderTotals: () => 10 });

		const started = await service.startIndexing({
			folders: ["/Users/me/Documents"],
			embed: "none",
			sources: [],
			plan: "free",
			excludePaths: ["/Users/me/Documents/Zoom"],
			excludedFiles: 3,
		});
		for (let tick = 0; tick < 100 && service.isIndexing(); tick += 1) await flush();

		expect(started.totalFiles).toBe(7);
		expect((await service.indexStatus()).totalFiles).toBe(7);
		const written = JSON.parse(await readFile(join(directory, "config.json"), "utf8")) as { excludePaths?: string[] };
		expect(written.excludePaths).toEqual(["/keep", "/Users/me/Documents/Zoom"]);
		service.dispose();
	});

	it("refuses an indexing request whose exclusions are not absolute paths or whose excluded count is not a count", async () => {
		const directory = await workDir();
		const service = createOnboardingService(makeDeps(directory));
		const base = { folders: ["/Users/me/Documents"], embed: "none" as const, sources: [], plan: "free" as const };

		await expect(service.startIndexing({ ...base, excludePaths: ["relative/Zoom"] })).rejects.toThrow();
		await expect(service.startIndexing({ ...base, excludedFiles: -1 })).rejects.toThrow();
		service.dispose();
	});

	it("reports what a run that finished before the first poll actually read", async () => {
		const directory = await workDir();
		const documents = join(directory, "Documents");
		await mkdir(join(directory, ".autorag", "parsed"), { recursive: true });
		const entry = (name: string, updatedAt: string) => ({ sourcePath: join(documents, name), updatedAt });
		await writeFile(
			join(directory, ".autorag", "parsed", "index.json"),
			JSON.stringify({ entries: { a: entry("a.md", "2026-01-01T00:00:00Z"), b: entry("b.md", "2026-01-02T00:00:00Z") }, skipped: {} }),
		);
		const service = createOnboardingService({ ...makeDeps(directory), folderTotals: () => 2 });

		await service.startIndexing({ folders: [documents], embed: "none", sources: [], plan: "free" });
		for (let tick = 0; tick < 50 && service.isIndexing(); tick += 1) await new Promise((resolve) => setTimeout(resolve, 5));

		expect(await service.indexStatus()).toMatchObject({ state: "success", progress: 100, totalFiles: 2, processedFiles: 2, recentFile: "b.md", recentFolder: "Documents" });
		service.dispose();
	});

	it("allows completing onboarding while indexing is still running in the background", async () => {
		const directory = await workDir();
		const gate = Promise.withResolvers<ConfigRefreshResult>();
		let completedCalls = 0;
		const service = createOnboardingService({
			...makeDeps(directory),
			refresh: () => gate.promise,
			onComplete: () => {
				completedCalls += 1;
			},
		});
		await service.startIndexing({ folders: ["/Users/me/Documents"], sources: [], plan: "byok" });
		expect(service.pending()).toBe(true);
		expect(service.isIndexing()).toBe(true);

		await service.complete();
		await service.complete();
		expect(service.pending()).toBe(false);
		expect(completedCalls).toBe(1);
		expect(service.isIndexing()).toBe(true);

		gate.resolve({ ok: true, methods: ["parsed", "minsync"], scanned: 3, written: 3, deleted: 0, skipped: 0, diagnostics: [], error: null });
		for (let tick = 0; tick < 100 && service.isIndexing(); tick += 1) await flush();
		expect(service.isIndexing()).toBe(false);
		expect((await service.indexStatus()).state).toBe("success");
	});

	it("triggers background datasource indexing only after both local indexing and onboarding completion finish", async () => {
		const directory = await workDir();
		const gate = Promise.withResolvers<ConfigRefreshResult>();
		const syncedAliases: string[][] = [];
		const mailcrawl: DetectedSource = { id: "mailcrawl", facts: { accounts: ["gmail", "work"] } };
		const obsidian: DetectedSource = { id: "obsidian", facts: { vaults: ["/v1", "/v2"] } };
		const service = createOnboardingService({
			...makeDeps(directory),
			detectSources: async (onFound): Promise<SourceDetection> => {
				onFound?.(mailcrawl);
				onFound?.(obsidian);
				return { sources: [mailcrawl, obsidian] };
			},
			refresh: () => gate.promise,
			syncDatasources: async (aliases) => {
				syncedAliases.push([...aliases]);
			},
		});

		await service.detectSources();
		await service.startIndexing({
			folders: ["/Users/me/Documents"],
			sources: [{ id: "mailcrawl" }, { id: "obsidian" }],
			plan: "free",
		});

		// Completing onboarding while local indexing is still in flight waits for local indexing to finish first.
		await service.complete();
		expect(syncedAliases).toEqual([]);

		gate.resolve({ ok: true, methods: ["parsed", "minsync"], scanned: 1, written: 1, deleted: 0, skipped: 0, diagnostics: [], error: null });
		for (let tick = 0; tick < 100 && syncedAliases.length === 0; tick += 1) await flush();
		expect(syncedAliases).toEqual([["mailcrawl-gmail", "mailcrawl-work", "obsidian", "obsidian-2"]]);
	});

	it("triggers background datasource indexing on complete() when local indexing already finished", async () => {
		const directory = await workDir();
		const syncedAliases: string[][] = [];
		const whatsapp: DetectedSource = { id: "whatsapp", facts: { chats: 2, messages: 9 } };
		const service = createOnboardingService({
			...makeDeps(directory),
			detectSources: async (onFound): Promise<SourceDetection> => {
				onFound?.(whatsapp);
				return { sources: [whatsapp] };
			},
			syncDatasources: async (aliases) => {
				syncedAliases.push([...aliases]);
			},
		});

		await service.detectSources();
		await service.startIndexing({
			folders: ["/Users/me/Documents"],
			sources: [{ id: "whatsapp" }],
			plan: "free",
		});
		for (let tick = 0; tick < 100 && service.isIndexing(); tick += 1) await flush();
		// Not completed yet -> datasources have not started.
		expect(syncedAliases).toEqual([]);

		await service.complete();
		for (let tick = 0; tick < 100 && syncedAliases.length === 0; tick += 1) await flush();
		expect(syncedAliases).toEqual([["whatsapp"]]);
	});
	it("does not trigger background datasource indexing when local indexing fails", async () => {
		const directory = await workDir();
		const gate = Promise.withResolvers<ConfigRefreshResult>();
		const syncedAliases: string[][] = [];
		const whatsapp: DetectedSource = { id: "whatsapp", facts: { chats: 2, messages: 9 } };
		const service = createOnboardingService({
			...makeDeps(directory),
			detectSources: async (onFound): Promise<SourceDetection> => {
				onFound?.(whatsapp);
				return { sources: [whatsapp] };
			},
			refresh: () => gate.promise,
			syncDatasources: async (aliases) => {
				syncedAliases.push([...aliases]);
			},
		});

		await service.detectSources();
		await service.startIndexing({
			folders: ["/Users/me/Documents"],
			sources: [{ id: "whatsapp" }],
			plan: "free",
		});
		await service.complete();
		gate.resolve({ ok: false, methods: ["parsed", "minsync"], scanned: 0, written: 0, deleted: 0, skipped: 0, diagnostics: [], error: "disk full" });
		for (let tick = 0; tick < 100 && service.isIndexing(); tick += 1) await flush();
		expect((await service.indexStatus()).state).toBe("failed");
		expect(syncedAliases).toEqual([]);
	});

	it("points the agent at the account's models on a managed plan, and leaves BYOK alone", async () => {
		const managedCalls: string[] = [];
		const run = async (plan: "free" | "air" | "pro" | "byok", useManagedModel: () => Promise<unknown>): Promise<void> => {
			const directory = await workDir();
			const service = createOnboardingService({ ...makeDeps(directory), useManagedModel });
			await service.startIndexing({ folders: ["/Users/me/Documents"], sources: [], plan });
			service.dispose();
		};
		for (const plan of ["free", "air", "pro"] as const) await run(plan, async () => managedCalls.push(plan));
		await run("byok", async () => managedCalls.push("byok"));

		expect(managedCalls).toEqual(["free", "air", "pro"]);
	});

	it("still indexes when the account's models cannot be reached", async () => {
		const directory = await workDir();
		const service = createOnboardingService({
			...makeDeps(directory),
			useManagedModel: async () => {
				throw new Error("offline");
			},
		});

		const status = await service.startIndexing({ folders: ["/Users/me/Documents"], sources: [], plan: "pro" });

		expect(status.state).toBe("running");
		service.dispose();
	});

	it("configures Dazzi cloud embedding when indexing with embed=cloud", async () => {
		const directory = await workDir();
		const env: NodeJS.ProcessEnv = { AUTORAG_BASE_URL: "https://api.dazziapp.com" };
		await storeDazziPlanCredential(directory, "dz_cloud_token");
		const stored = new Map<string, string>();
		const service = createOnboardingService({
			...makeDeps(directory, env),
			credentials: {
				list: async () => [],
				set: async (name, secret) => {
					stored.set(name, secret);
					env[name] = secret;
					return [];
				},
				remove: async (name) => {
					stored.delete(name);
					delete env[name];
					return [];
				},
				load: async () => [],
			},
		});

		await service.startIndexing({
			folders: ["/Users/me/Documents"],
			embed: "cloud",
			sources: [],
			plan: "pro",
		});
		const written = JSON.parse(await readFile(join(directory, "config.json"), "utf8")) as {
			minSync?: { embedder?: Record<string, unknown> };
		};
		expect(written.minSync?.embedder).toEqual({
			id: "openai:qwen/qwen3-embedding-0.6b",
			baseUrl: "https://api.dazziapp.com",
			dimension: 1024,
			apiKeyEnv: "OPENAI_API_KEY",
		});
		expect(env.OPENAI_API_KEY).toBe("dz_cloud_token");
		expect(stored.get("OPENAI_API_KEY")).toBe("dz_cloud_token");
		service.dispose();

		// Re-running with embed=local replaces the Dazzi cloud embedder with the local profile.
		const service2 = createOnboardingService({
			...makeDeps(directory, env),
			credentials: {
				list: async () => [],
				set: async (name, secret) => {
					stored.set(name, secret);
					env[name] = secret;
					return [];
				},
				remove: async (name) => {
					stored.delete(name);
					delete env[name];
					return [];
				},
				load: async () => [],
			},
		});
		await service2.startIndexing({
			folders: ["/Users/me/Documents"],
			embed: "local",
			sources: [],
			plan: "pro",
		});
		service2.dispose();
		const rewritten = JSON.parse(await readFile(join(directory, "config.json"), "utf8")) as {
			minSync?: { embedder?: Record<string, unknown> };
		};
		expect(rewritten.minSync?.embedder).toEqual({
			id: "native:Qwen/Qwen3-Embedding-0.6B",
			dimension: 1024,
		});
		expect(stored.has("OPENAI_API_KEY")).toBe(false);
	});
});

describe("createOnboardingService source detection", () => {
	const kakao: DetectedSource = { id: "kakao", facts: {} };
	const whatsapp: DetectedSource = { id: "whatsapp", facts: { chats: 2, messages: 9 } };

	it("pushes each find as it lands and closes the run with sourcesDone", async () => {
		const directory = await workDir();
		const sent: Array<{ channel: string; payload: unknown }> = [];
		const gate = Promise.withResolvers<void>();
		const service = createOnboardingService({
			...makeDeps(directory),
			send: (channel, payload) => sent.push({ channel, payload }),
			detectSources: async (onFound) => {
				onFound?.(kakao);
				await gate.promise;
				onFound?.(whatsapp);
				return { sources: [kakao, whatsapp] };
			},
		});

		await service.detectSources();
		expect(sent).toEqual([{ channel: ONBOARDING_CHANNELS.sourceDetected, payload: kakao }]);

		gate.resolve();
		for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
		expect(sent.map((event) => event.channel)).toEqual([
			ONBOARDING_CHANNELS.sourceDetected,
			ONBOARDING_CHANNELS.sourceDetected,
			ONBOARDING_CHANNELS.sourcesDone,
		]);
	});

	it("silences a superseded run so its late finds never reach a reset list", async () => {
		const directory = await workDir();
		const sent: string[] = [];
		const first = Promise.withResolvers<void>();
		let call = 0;
		const service = createOnboardingService({
			...makeDeps(directory),
			send: (channel, payload) => sent.push(`${channel}:${(payload as DetectedSource | null)?.id ?? "-"}`),
			detectSources: async (onFound) => {
				call += 1;
				if (call === 1) {
					await first.promise;
					onFound?.(kakao);
					return { sources: [kakao] };
				}
				onFound?.(whatsapp);
				return { sources: [whatsapp] };
			},
		});

		await service.detectSources();
		await service.detectSources();
		first.resolve();
		for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();

		expect(sent).toEqual([
			`${ONBOARDING_CHANNELS.sourceDetected}:whatsapp`,
			`${ONBOARDING_CHANNELS.sourcesDone}:-`,
		]);
	});

	it("starts the first index from the probe run the sources step already made", async () => {
		const directory = await workDir();
		let probes = 0;
		const service = createOnboardingService({
			...makeDeps(directory),
			detectSources: async (onFound): Promise<SourceDetection> => {
				probes += 1;
				onFound?.(whatsapp);
				return { sources: [whatsapp] };
			},
		});

		await service.detectSources();
		await service.startIndexing({ folders: ["/Users/me/Documents"], sources: [{ id: "whatsapp" }], plan: "free" });

		expect(probes).toBe(1);
		const written = JSON.parse(await readFile(join(directory, "config.json"), "utf8")) as { datasources: Record<string, unknown> };
		expect(Object.keys(written.datasources)).toEqual(["whatsapp"]);
		expect(written.datasources.whatsapp).not.toHaveProperty("description");
	});
});

describe("createOnboardingService launch at login", () => {
	it("keeps the setting on, with no correction write, when the OS login item took", async () => {
		const directory = await workDir();
		const stored: boolean[] = [];
		const service = createOnboardingService({
			...makeDeps(directory),
			settings: {
				get: async () => DEFAULT_SETTINGS,
				set: async (patch) => {
					stored.push(patch.launchAtLogin === true);
					return { ...DEFAULT_SETTINGS, ...patch };
				},
			},
			loginItemApplied: () => true,
		});

		expect(await service.setLaunchAtLogin(true)).toBe(true);
		expect(stored).toEqual([true]);
	});

	it("does not leave the setting claiming on when the OS refused, and persists the correction", async () => {
		const directory = await workDir();
		const stored: boolean[] = [];
		const service = createOnboardingService({
			...makeDeps(directory),
			settings: {
				get: async () => DEFAULT_SETTINGS,
				set: async (patch) => {
					stored.push(patch.launchAtLogin === true);
					return { ...DEFAULT_SETTINGS, ...patch };
				},
			},
			loginItemApplied: () => false,
		});

		expect(await service.setLaunchAtLogin(true)).toBe(false);
		expect(stored).toEqual([true, false]);
	});
});
