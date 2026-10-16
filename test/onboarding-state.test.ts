import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ONBOARDING_CHANNELS, type DetectedSource, type OnboardingDraft, type SourceDetection } from "../src/shared/onboarding-contract";
import type { AppSettings, ConfigRefreshResult } from "../src/shared/settings-contract";
import type { OnboardingServiceDeps } from "../src/main/onboarding-service";
import { createOnboardingService, readOnboardingPending } from "../src/main/onboarding-service";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
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
	errorReporting: true,
	showHiddenFiles: false,
	dupeyScanIntervalMinutes: 60,
	osMenuIntegration: false,
};

function makeDeps(userDataDir: string, env: NodeJS.ProcessEnv = {}): OnboardingServiceDeps {
	return {
		userDataDir,
		env,
		cwd: "/repo",
		platform: "darwin",
		home: "/Users/me",
		knownFolders: { desktop: "/Users/me/Desktop", documents: "/Users/me/Documents", downloads: "/Users/me/Downloads", pictures: "/Users/me/Pictures" },
		iCloudDrivePath: null,
		cloudDrives: async () => [],
		ocrEnabled: async () => false,
		configPath: join(userDataDir, "config.json"),
		resolveWorkspacePath: async () => userDataDir,
		refresh: async () => ({ ok: true, methods: [], scanned: 0, written: 0, deleted: 0, skipped: 0, diagnostics: [], error: null }),
		credentials: { list: async () => [], set: async () => [], remove: async () => [], load: async () => [] },
		settings: { get: async () => DEFAULT_SETTINGS, set: async (patch) => ({ ...DEFAULT_SETTINGS, ...patch }) },
		detectSources: async () => ({ sources: [] }),
		gitToken: async () => null,
		useManagedModel: async () => undefined,
		detectModels: async () => [],
		verifyModel: async () => ({ ok: false, error: "unused" }),
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
			model: null,
		});
		expect(status.state).toBe("running");
		expect(requestedMethods).toEqual([["parsed", "minsync"]]);
		expect(service.isIndexing()).toBe(true);
		gate.resolve({ ok: true, methods: ["parsed", "minsync"], scanned: 0, written: 0, deleted: 0, skipped: 0, diagnostics: [], error: null });
		// Flush microtasks; no wall-clock wait.
		for (let tick = 0; tick < 20 && service.isIndexing(); tick += 1) await Promise.resolve();
		expect((await service.indexStatus()).state).toBe("success");
		expect(service.isIndexing()).toBe(false);
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
		await service.startIndexing({ folders: ["/Users/me/Documents"], sources: [], plan: "byok", model: null });
		expect(service.pending()).toBe(true);
		expect(service.isIndexing()).toBe(true);

		await service.complete();
		await service.complete();
		expect(service.pending()).toBe(false);
		expect(completedCalls).toBe(1);
		expect(service.isIndexing()).toBe(true);

		gate.resolve({ ok: true, methods: ["parsed", "minsync"], scanned: 3, written: 3, deleted: 0, skipped: 0, diagnostics: [], error: null });
		for (let tick = 0; tick < 20 && service.isIndexing(); tick += 1) await Promise.resolve();
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
			model: null,
		});

		// Completing onboarding while local indexing is still in flight waits for local indexing to finish first.
		await service.complete();
		expect(syncedAliases).toEqual([]);

		gate.resolve({ ok: true, methods: ["parsed", "minsync"], scanned: 1, written: 1, deleted: 0, skipped: 0, diagnostics: [], error: null });
		for (let tick = 0; tick < 20 && syncedAliases.length === 0; tick += 1) await Promise.resolve();
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
			model: null,
		});
		for (let tick = 0; tick < 20 && service.isIndexing(); tick += 1) await Promise.resolve();
		// Not completed yet -> datasources have not started.
		expect(syncedAliases).toEqual([]);

		await service.complete();
		for (let tick = 0; tick < 20 && syncedAliases.length === 0; tick += 1) await Promise.resolve();
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
			model: null,
		});
		await service.complete();
		gate.resolve({ ok: false, methods: ["parsed", "minsync"], scanned: 0, written: 0, deleted: 0, skipped: 0, diagnostics: [], error: "disk full" });
		for (let tick = 0; tick < 20 && service.isIndexing(); tick += 1) await Promise.resolve();
		expect((await service.indexStatus()).state).toBe("failed");
		expect(syncedAliases).toEqual([]);
	});

	it("points the agent at the account's models on a managed plan, and leaves BYOK alone", async () => {
		const managedCalls: string[] = [];
		const run = async (plan: "free" | "air" | "pro" | "byok", useManagedModel: () => Promise<unknown>): Promise<void> => {
			const directory = await workDir();
			const service = createOnboardingService({ ...makeDeps(directory), useManagedModel });
			await service.startIndexing({ folders: ["/Users/me/Documents"], sources: [], plan, model: null });
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

		const status = await service.startIndexing({ folders: ["/Users/me/Documents"], sources: [], plan: "pro", model: null });

		expect(status.state).toBe("running");
		service.dispose();
	});

	it("configures Dazzi cloud embedding when indexing with embed=cloud", async () => {
		const directory = await workDir();
		const env: NodeJS.ProcessEnv = { AUTORAG_API_KEY: "dz_cloud_token", AUTORAG_BASE_URL: "https://api.dazziapp.com" };
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
			model: null,
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
			model: null,
		});
		service2.dispose();
		const rewritten = JSON.parse(await readFile(join(directory, "config.json"), "utf8")) as {
			minSync?: { embedder?: Record<string, unknown> };
		};
		expect(rewritten.minSync?.embedder).toEqual({
			profile: "qwen3-embedding-0.6b",
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
		await service.startIndexing({ folders: ["/Users/me/Documents"], sources: [{ id: "whatsapp" }], plan: "free", model: null });

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
