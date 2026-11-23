import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { createProfileSession } from "@autorag/librarian/profiles";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutoRagConfigService } from "../src/main/autorag-config-service";
import { createSearchCustomizerToolkit, searchCustomizerProfile } from "../src/main/agents/profiles/search-customizer";
import type { CustomizerToolkit } from "../src/main/agents/profiles/customizer-kit";
import { createSettingsService } from "../src/main/settings-service";
import type { AppSettings, RefreshScheduleStatus } from "../src/shared/settings-contract";

const cleanups: Array<() => Promise<void> | void> = [];
let root: string;
let extraRoot: string;
let pickedDir: string;
let agentDir: string;
let settingsDir: string;
let env: NodeJS.ProcessEnv;

const SCHEDULE_STATUS: RefreshScheduleStatus = {
	supported: true,
	mechanism: "launchd",
	installed: true,
	wanted: true,
	intervalMs: 900_000,
	lastTickAt: null,
	local: null,
	sources: {},
	paused: null,
	conflicts: [],
	error: null,
};

const TOOL_NAMES = ["get_search_settings", "update_duplicates", "update_index_options", "update_index_scope"];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "search-agent-root-"));
	extraRoot = await mkdtemp(join(tmpdir(), "search-agent-extra-"));
	pickedDir = await mkdtemp(join(tmpdir(), "search-agent-picked-"));
	agentDir = await mkdtemp(join(tmpdir(), "search-agent-dir-"));
	settingsDir = join(root, "settings");
	env = { HOME: root, AUTORAG_CONFIG: join(root, "config.json") };
	await writeFile(env.AUTORAG_CONFIG!, `${JSON.stringify({ searchPaths: [root, extraRoot], workspacePath: root, memoryPath: join(root, "memory.json") }, null, 2)}\n`);
	cleanups.push(
		() => rm(root, { recursive: true, force: true }),
		() => rm(extraRoot, { recursive: true, force: true }),
		() => rm(pickedDir, { recursive: true, force: true }),
		() => rm(agentDir, { recursive: true, force: true }),
	);
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function register(): FauxProviderRegistration {
	const registration = registerFauxProvider({
		api: `faux-search-customizer-${Math.random().toString(36).slice(2)}`,
		provider: "faux-search-customizer",
		models: [{ id: "search-customizer", reasoning: true }],
	});
	cleanups.push(() => registration.unregister());
	return registration;
}

function createStubSettings(options: { readonly reconcile?: () => Promise<RefreshScheduleStatus> } = {}) {
	const reconcile = vi.fn(options.reconcile ?? (async () => SCHEDULE_STATUS));
	return {
		reconcile,
		settings: createSettingsService({
			directory: settingsDir,
			dataSources: { list: vi.fn(), setEnabled: vi.fn(), setDescription: vi.fn(), sync: vi.fn() } as never,
			models: { resolve: vi.fn(), catalog: vi.fn() } as never,
			config: createAutoRagConfigService({ env, cwd: root }),
			refreshConfig: vi.fn() as never,
			credentials: { list: vi.fn(), set: vi.fn(), remove: vi.fn() } as never,
			refreshScheduler: { status: vi.fn(), reconcile, remove: vi.fn() } as never,
			onSettingsChanged: undefined as never,
		}),
	};
}

async function readConfig(): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(env.AUTORAG_CONFIG!, "utf8")) as Record<string, unknown>;
}

async function readState(): Promise<AppSettings> {
	const raw = JSON.parse(await readFile(join(settingsDir, "settings-state.json"), "utf8")) as { settings: AppSettings };
	return raw.settings;
}

function parse(res: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): Record<string, unknown> {
	const first = res.content[0];
	return JSON.parse(first?.type === "text" && typeof first.text === "string" ? first.text : "{}") as Record<string, unknown>;
}

type ToolExecute = (callId: string, params: unknown, ...rest: unknown[]) => Promise<{ readonly content: readonly { readonly type: string; readonly text?: string }[] }>;

function tool(kit: CustomizerToolkit, name: string): { readonly execute: ToolExecute; readonly parameters: unknown; readonly name: string } {
	const found = kit.tools.find((t) => t.name === name);
	if (found === undefined) throw new Error(`missing tool ${name}`);
	return found as unknown as { readonly execute: ToolExecute; readonly parameters: unknown; readonly name: string };
}

function warningsOf(parsed: Record<string, unknown>): readonly string[] {
	return Array.isArray(parsed.warnings) ? (parsed.warnings as readonly string[]) : [];
}

describe("search-customizer pi agent profile & toolkit", () => {
	it("exposes only the five closed tools, states the no-refresh/no-delete invariants, and never offers an index-run or file tool", () => {
		const { settings } = createStubSettings();
		const kit = createSearchCustomizerToolkit({ settings, platform: "darwin", language: () => "ko" });
		const profile = searchCustomizerProfile({ language: "ko", surface: "indexing", toolkit: kit });

		expect(profile.id).toBe("search-customizer");
		expect(profile.tools).toEqual([]);
		expect(profile.customTools?.map((t) => t.name).sort()).toEqual(TOOL_NAMES);

		expect(profile.systemPrompt).toMatch(/language the person writes in/iu);
		expect(profile.systemPrompt).toContain("if it is unclear, reply in Korean");
		expect(profile.systemPrompt).not.toMatch(/[\uac00-\ud7af\u3040-\u30ff\u4e00-\u9fff]/u);
		expect(profile.systemPrompt).toContain("never");
		expect(profile.systemPrompt).toContain("refresh");
		for (const forbidden of ["run", "delete", "move", "trash"]) {
			expect(profile.systemPrompt.toLowerCase()).toContain(forbidden);
		}
	});

	it("reports the current scope, cadence, watch, doc-language and duplicate settings", async () => {
		const { settings } = createStubSettings();
		const kit = createSearchCustomizerToolkit({ settings, language: () => "ko" });
		const parsed = parse(await tool(kit, "get_search_settings").execute("call-1", {}, undefined, undefined, undefined));

		expect(parsed.searchPaths).toEqual([root, extraRoot]);
		expect(parsed.excludePaths).toEqual([]);
		expect(parsed.refreshIntervalMs).toBe(0);
		expect(parsed.fileNameWatch).toBe(true);
		expect(parsed.fsearchFalse).toBe(false);
		expect(parsed.excludeCodeFolders).toBe(true);
		expect(parsed.excludeExactDuplicates).toBe(true);
		expect(parsed.dupeyEnabled).toBe(true);
		expect(parsed.dupeyScanIntervalMinutes).toBe(60);
	});

	it("adds a real folder to searchPaths and refuses a nonexistent folder", async () => {
		const { settings } = createStubSettings();
		const kit = createSearchCustomizerToolkit({ settings, language: () => "ko" });
		const update = tool(kit, "update_index_scope");

		const picked = pickedDir;
		const parsed = parse(await update.execute("call-1", { addFolders: [picked] }, undefined, undefined, undefined));
		expect(parsed.ok).toBe(true);
		expect((await readConfig()).searchPaths).toEqual([root, extraRoot, picked]);
		// Scope edits never touch the app-managed paths.
		expect((await readConfig()).workspacePath).toBe(root);
		expect((await readConfig()).memoryPath).toBe(join(root, "memory.json"));

		const missing = join(root, "does-not-exist");
		const parsed2 = parse(await update.execute("call-2", { addFolders: [missing] }, undefined, undefined, undefined));
		expect(parsed2.ok).toBe(true);
		expect(warningsOf(parsed2).length).toBeGreaterThanOrEqual(1);
		expect(warningsOf(parsed2).some((w) => w.includes(missing))).toBe(true);
		expect((await readConfig()).searchPaths).toEqual([root, extraRoot, picked]);
	});

	it("refuses a subfolder of an existing root and a duplicate, with reasons", async () => {
		const { settings } = createStubSettings();
		const kit = createSearchCustomizerToolkit({ settings, language: () => "ko" });
		const update = tool(kit, "update_index_scope");

		const sub = join(root, "nested");
		await mkdir(sub);
		const parsed = parse(await update.execute("call-1", { addFolders: [sub, root] }, undefined, undefined, undefined));
		expect(parsed.ok).toBe(true);
		const warnings = warningsOf(parsed);
		expect(warnings.some((w) => w.includes(sub) && w.includes("inside-target"))).toBe(true);
		expect(warnings.some((w) => w.includes(root) && w.includes("duplicate"))).toBe(true);
		expect((await readConfig()).searchPaths).toEqual([root, extraRoot]);
	});

	it("removes a folder and drops the exclusions that only meant something under it, keeping the glob", async () => {
		const { settings } = createStubSettings();
		const kit = createSearchCustomizerToolkit({ settings, language: () => "ko" });
		const update = tool(kit, "update_index_scope");

		const nested = join(root, "secret");
		await mkdir(nested);
		const glob = "/var/log/**/*.old";
		await update.execute("call-1", { addExclusions: [nested, glob] }, undefined, undefined, undefined);
		expect((await readConfig()).excludePaths).toEqual([nested, glob]);

		const parsed = parse(await update.execute("call-2", { removeFolders: [root] }, undefined, undefined, undefined));
		expect(parsed.ok).toBe(true);
		const config = await readConfig();
		expect(config.searchPaths).toEqual([extraRoot]);
		expect(config.excludePaths).toEqual([glob]);
	});

	it("accepts a glob exclusion and refuses a bare relative non-glob exclusion", async () => {
		const { settings } = createStubSettings();
		const kit = createSearchCustomizerToolkit({ settings, language: () => "ko" });
		const update = tool(kit, "update_index_scope");

		const parsed = parse(await update.execute("call-1", { addExclusions: ["**/node_modules", "relative-folder"] }, undefined, undefined, undefined));
		expect(parsed.ok).toBe(true);
		expect(warningsOf(parsed).some((w) => w.includes("relative-folder"))).toBe(true);
		expect((await readConfig()).excludePaths).toEqual(["**/node_modules"]);

		// A duplicate exclusion is skipped, not warned twice.
		const parsed2 = parse(await update.execute("call-2", { addExclusions: ["**/node_modules"] }, undefined, undefined, undefined));
		expect(parsed2.ok).toBe(true);
		expect((await readConfig()).excludePaths).toEqual(["**/node_modules"]);
	});

	it("validates the cadence, applies it, and calls refreshScheduleApply best-effort", async () => {
		const { settings, reconcile } = createStubSettings();
		const kit = createSearchCustomizerToolkit({ settings, language: () => "ko" });
		const update = tool(kit, "update_index_options");

		const bad = parse(await update.execute("call-bad", { refreshIntervalMs: 12_345 }, undefined, undefined, undefined));
		expect(bad.ok).toBe(true);
		expect(warningsOf(bad).length).toBeGreaterThanOrEqual(1);
		expect(reconcile).not.toHaveBeenCalled();
		expect((await readConfig()).appIndexing).toBeUndefined();

		const good = parse(await update.execute("call-good", { refreshIntervalMs: 900_000 }, undefined, undefined, undefined));
		expect(good.ok).toBe(true);
		expect((await readConfig()).appIndexing).toEqual({ refreshIntervalMs: 900_000 });
		expect(reconcile).toHaveBeenCalledTimes(1);
	});

	it("turns a refreshScheduleApply failure into a warning without failing the tool", async () => {
		const { settings } = createStubSettings({
			reconcile: async () => {
				throw new Error("scheduler unavailable");
			},
		});
		const kit = createSearchCustomizerToolkit({ settings, language: () => "ko" });
		const update = tool(kit, "update_index_options");

		const parsed = parse(await update.execute("call-1", { refreshIntervalMs: 300_000 }, undefined, undefined, undefined));
		expect(parsed.ok).toBe(true);
		expect(warningsOf(parsed).some((w) => w.includes("scheduler unavailable"))).toBe(true);
		expect((await readConfig()).appIndexing).toEqual({ refreshIntervalMs: 300_000 });
	});

	it("writes fileNameWatch and excludeCodeFolders, but refuses watch when fsearch is off", async () => {
		const { settings } = createStubSettings();
		const kit = createSearchCustomizerToolkit({ settings, language: () => "ko" });
		const update = tool(kit, "update_index_options");

		await update.execute("call-1", { fileNameWatch: false, excludeCodeFolders: false }, undefined, undefined, undefined);
		let config = await readConfig();
		expect(config.fsearch).toEqual({ watch: false });
		expect(config.appIndexing).toEqual({ excludeCodeFolders: false });

		await writeFile(env.AUTORAG_CONFIG!, `${JSON.stringify({ ...(await readConfig()), fsearch: false }, null, 2)}\n`);
		const parsed = parse(await update.execute("call-2", { fileNameWatch: true }, undefined, undefined, undefined));
		expect(parsed.ok).toBe(true);
		expect(warningsOf(parsed).some((w) => w.includes("fsearch"))).toBe(true);
		expect((await readConfig()).fsearch).toBe(false);
	});

	it("writes the duplicate toggles in the page's shapes, including a bare dupey:false flipping to enabled", async () => {
		const { settings } = createStubSettings();
		const kit = createSearchCustomizerToolkit({ settings, language: () => "ko" });
		const update = tool(kit, "update_duplicates");

		await update.execute("call-1", { excludeExactDuplicates: false, versionScan: false }, undefined, undefined, undefined);
		let config = await readConfig();
		expect(config.excludeExactDuplicates).toBe(false);
		expect(config.dupey).toEqual({ enabled: false });

		await update.execute("call-2", { versionScan: true }, undefined, undefined, undefined);
		expect((await readConfig()).dupey).toEqual({ enabled: true });

		await writeFile(env.AUTORAG_CONFIG!, `${JSON.stringify({ ...(await readConfig()), dupey: false }, null, 2)}\n`);
		await update.execute("call-3", { versionScan: true }, undefined, undefined, undefined);
		expect((await readConfig()).dupey).toEqual({ enabled: true });
	});

	it("puts the scan interval in settings-state.json and never in config.json", async () => {
		const { settings } = createStubSettings();
		const kit = createSearchCustomizerToolkit({ settings, language: () => "ko" });
		const update = tool(kit, "update_duplicates");

		const parsed = parse(await update.execute("call-1", { scanIntervalMinutes: 180 }, undefined, undefined, undefined));
		expect(parsed.ok).toBe(true);
		expect((await readState()).dupeyScanIntervalMinutes).toBe(180);
		expect((await readConfig()).dupeyScanIntervalMinutes).toBeUndefined();

		const bad = parse(await update.execute("call-2", { scanIntervalMinutes: 7 }, undefined, undefined, undefined));
		expect(bad.ok).toBe(true);
		expect(warningsOf(bad).length).toBeGreaterThanOrEqual(1);
		expect((await readState()).dupeyScanIntervalMinutes).toBe(180);
	});

	it("runs the profile on pi's faux provider, accepts the i intent field, and applies the change", async () => {
		const registration = register();
		const { settings } = createStubSettings();
		const kit = createSearchCustomizerToolkit({ settings, language: () => "ko" });
		const profile = searchCustomizerProfile({ language: "ko", surface: "indexing", toolkit: kit });

		const session = await createProfileSession({
			profile,
			cwd: root,
			agentDir,
			env,
			model: { model: registration.getModel()! },
		});
		cleanups.push(() => session.dispose());

		registration.setResponses([
			fauxAssistantMessage([fauxToolCall("update_index_options", { i: "새로고침 주기를 바꾸는 중", refreshIntervalMs: 900_000 })]),
			fauxAssistantMessage("새로고침 주기를 15분으로 바꿨습니다."),
		]);

		await session.prompt("새로고침을 15분마다 하게 해줘");

		expect((await readConfig()).appIndexing?.refreshIntervalMs).toBe(900_000);
		expect(kit.takeChanges()[0]?.kind).toBe("search");
	});
});
