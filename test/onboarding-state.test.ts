import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OnboardingDraft } from "../src/shared/onboarding-contract";
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
	account: null,
	notifications: false,
	network: false,
	launchAtLogin: false,
	folders: [{ path: "/Users/me/Documents", selected: true }],
	sources: [],
	plan: "free",
	planConfirmed: false,
	paid: null,
	model: null,
};

const DEFAULT_SETTINGS: AppSettings = {
	appearance: "light",
	language: "ko",
	launchAtLogin: false,
	showInMenuBar: true,
	autoInstallUpdates: true,
	telemetry: false,
	showHiddenFiles: false,
	dupeyScanIntervalMinutes: 60,
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
		credentials: { list: () => [], set: () => [], remove: () => [], load: () => [] },
		settings: { get: async () => DEFAULT_SETTINGS, set: async (patch) => ({ ...DEFAULT_SETTINGS, ...patch }) },
		detectSources: async () => ({ sources: [] }),
		gitToken: async () => null,
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
		applyLoginItem: () => undefined,
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

	it("starts the index and settles to success when the refresh resolves", async () => {
		const directory = await workDir();
		const gate = Promise.withResolvers<ConfigRefreshResult>();
		const deps: OnboardingServiceDeps = { ...makeDeps(directory), refresh: () => gate.promise };
		const service = createOnboardingService(deps);
		const status = await service.startIndexing({ folders: ["/Users/me/Documents"], sources: [], plan: "byok", model: null });
		expect(status.state).toBe("running");
		expect(service.isIndexing()).toBe(true);
		gate.resolve({ ok: true, methods: ["parsed"], scanned: 0, written: 0, deleted: 0, skipped: 0, diagnostics: [], error: null });
		// Flush microtasks; no wall-clock wait.
		for (let tick = 0; tick < 20 && service.isIndexing(); tick += 1) await Promise.resolve();
		expect((await service.indexStatus()).state).toBe("success");
		expect(service.isIndexing()).toBe(false);
	});
});
