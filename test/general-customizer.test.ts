import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { createProfileSession } from "@autorag/librarian/profiles";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutoRagConfigService } from "../src/main/autorag-config-service";
import type { CustomizerToolkit } from "../src/main/agents/profiles/customizer-kit";
import { createGeneralCustomizerToolkit } from "../src/main/agents/profiles/general-customizer";
import { settingsCustomizerProfile } from "../src/main/agents/profiles/settings-customizer";
import { createSettingsService } from "../src/main/settings-service";
import type { AppSettings } from "../src/shared/settings-contract";

const cleanups: Array<() => Promise<void> | void> = [];
let root: string;
let agentDir: string;
let settingsDir: string;
let env: NodeJS.ProcessEnv;

const ALLOWED_UPDATE_KEYS = [
	"appearance",
	"autoInstallUpdates",
	"errorReporting",
	"language",
	"launchAtLogin",
	"osMenuIntegration",
	"quickSearchChord",
	"quickSearchEnabled",
	"showHiddenFiles",
	"usageAnalytics",
];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "general-agent-root-"));
	agentDir = await mkdtemp(join(tmpdir(), "general-agent-dir-"));
	settingsDir = join(root, "settings");
	env = { HOME: root, AUTORAG_CONFIG: join(root, "config.json") };
	await writeFile(env.AUTORAG_CONFIG!, `${JSON.stringify({ searchPaths: [root], workspacePath: root, memoryPath: join(root, "memory.json") }, null, 2)}\n`);
	cleanups.push(
		() => rm(root, { recursive: true, force: true }),
		() => rm(agentDir, { recursive: true, force: true }),
	);
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function register(): FauxProviderRegistration {
	const registration = registerFauxProvider({
		api: `faux-general-customizer-${Math.random().toString(36).slice(2)}`,
		provider: "faux-general-customizer",
		models: [{ id: "general-customizer", reasoning: true }],
	});
	cleanups.push(() => registration.unregister());
	return registration;
}

function createStubSettings(
	options: {
		readonly onSettingsChanged?: () => void;
		readonly applyOsMenu?: (next: AppSettings, previous: AppSettings) => Promise<void>;
	} = {},
) {
	return createSettingsService({
		directory: settingsDir,
		dataSources: { list: vi.fn(), setEnabled: vi.fn(), setDescription: vi.fn(), sync: vi.fn() } as never,
		models: { resolve: vi.fn(), catalog: vi.fn() } as never,
		config: createAutoRagConfigService({ env, cwd: root }),
		refreshConfig: vi.fn() as never,
		credentials: { list: vi.fn(), set: vi.fn(), remove: vi.fn() } as never,
		...(options.applyOsMenu === undefined ? {} : { applyOsMenu: options.applyOsMenu }),
		onSettingsChanged: options.onSettingsChanged as never,
	});
}

/** Reads the persisted settings exactly as the pages see them (settings-state.json on disk). */
async function readState(): Promise<AppSettings> {
	const parsed = JSON.parse(await readFile(join(settingsDir, "settings-state.json"), "utf8")) as { settings: AppSettings };
	return parsed.settings;
}

function tool(kit: CustomizerToolkit, name: string): ToolDefinition {
	const found = kit.tools.find((candidate) => candidate.name === name);
	if (found === undefined) throw new Error(`missing tool ${name}`);
	return found;
}

function textOf(res: AgentToolResult<unknown>): string {
	const first = res.content[0];
	if (first !== undefined && typeof first === "object" && first !== null && "type" in first && first.type === "text" && "text" in first && typeof first.text === "string") {
		return first.text;
	}
	return "{}";
}

function parse(res: AgentToolResult<unknown>): Record<string, unknown> {
	return JSON.parse(textOf(res)) as Record<string, unknown>;
}

/** The declared parameter property names of a tool, for asserting exactly what the model may send. */
function parameterKeys(definition: ToolDefinition): string[] {
	const parameters: unknown = definition.parameters;
	if (parameters !== null && typeof parameters === "object" && "properties" in parameters && parameters.properties !== null && typeof parameters.properties === "object") {
		return Object.keys(parameters.properties as Record<string, unknown>);
	}
	return [];
}

function execute(definition: ToolDefinition, callId: string, params: unknown): Promise<AgentToolResult<unknown>> {
	return definition.execute(callId, params as never, undefined, undefined, undefined as never);
}

describe("general-customizer toolkit & settings-customizer profile", () => {
	it("exposes only get_general_settings/update_general_settings/update_reading, never a remote-access or approval-mode tool, and states the exclusions in the prompt", () => {
		const settings = createStubSettings();
		const kit = createGeneralCustomizerToolkit({ settings, platform: "darwin", language: () => "ko" });
		const profile = settingsCustomizerProfile({ language: "ko", surface: "general", toolkit: kit });

		expect(profile.id).toBe("settings-customizer");
		expect(profile.tools).toEqual([]);
		expect(profile.customTools?.map((t) => t.name).sort()).toEqual(["get_general_settings", "update_general_settings", "update_reading"]);

		const keys = parameterKeys(tool(kit, "update_general_settings"));
		expect(keys.sort()).toEqual(ALLOWED_UPDATE_KEYS);
		expect(keys).not.toContain("remoteAccess");
		expect(keys).not.toContain("remotePort");
		expect(keys).not.toContain("remoteTunnelHostname");
		expect(keys).not.toContain("approvalMode");
		expect(keys).not.toContain("dupeyScanIntervalMinutes");

		expect(profile.systemPrompt).toMatch(/language the person writes in/iu);
		expect(profile.systemPrompt).toContain("if it is unclear, reply in Korean");
		expect(profile.systemPrompt).not.toMatch(/[\uac00-\ud7af\u3040-\u30ff\u4e00-\u9fff]/u);
		expect(profile.systemPrompt).toContain("remoteAccess");
		expect(profile.systemPrompt).toContain("remotePort");
		expect(profile.systemPrompt).toContain("remoteTunnelHostname");
		expect(profile.systemPrompt).toContain("approvalMode");
	});

	it("writes every allowed preference to settings-state.json in one set call", async () => {
		const settings = createStubSettings();
		const kit = createGeneralCustomizerToolkit({ settings, platform: "darwin", language: () => "ko" });
		const update = tool(kit, "update_general_settings");

		const parsed = parse(
			await execute(update, "call-1", {
				appearance: "dark",
				language: "en",
				showHiddenFiles: true,
				launchAtLogin: true,
				osMenuIntegration: true,
				autoInstallUpdates: false,
				errorReporting: true,
				usageAnalytics: true,
				quickSearchEnabled: false,
				quickSearchChord: "⌘⇧K",
			}),
		);
		expect(parsed.ok).toBe(true);
		expect(parsed.warnings).toBeUndefined();

		const state = await readState();
		expect(state.appearance).toBe("dark");
		expect(state.language).toBe("en");
		expect(state.showHiddenFiles).toBe(true);
		expect(state.launchAtLogin).toBe(true);
		expect(state.osMenuIntegration).toBe(true);
		expect(state.autoInstallUpdates).toBe(false);
		expect(state.errorReporting).toBe(true);
		expect(state.usageAnalytics).toBe(true);
		expect(state.quickSearch).toEqual({ enabled: false, chord: "Mod+Shift+K" });
	});

	it("rejects an invalid language or appearance value without writing", async () => {
		const settings = createStubSettings();
		const kit = createGeneralCustomizerToolkit({ settings, platform: "darwin", language: () => "ko" });
		const update = tool(kit, "update_general_settings");

		// Seed a known state so "unchanged" is provable on disk.
		await execute(update, "call-init", { showHiddenFiles: true });
		kit.takeChanges();

		const badLanguage = parse(await execute(update, "call-1", { language: "fr" }));
		expect(badLanguage.ok).toBe(false);
		expect(badLanguage.error).toBeTypeOf("string");

		const badAppearance = parse(await execute(update, "call-2", { appearance: "blue" }));
		expect(badAppearance.ok).toBe(false);

		const state = await readState();
		expect(state.language).toBe("ko");
		expect(state.appearance).toBe("light");
		expect(state.showHiddenFiles).toBe(true);
		expect(kit.takeChanges()).toEqual([]);
	});

	it("refuses a bare-key quick-search chord and keeps the previously stored chord", async () => {
		const settings = createStubSettings();
		const kit = createGeneralCustomizerToolkit({ settings, platform: "darwin", language: () => "ko" });
		const update = tool(kit, "update_general_settings");

		// First set a non-default global chord so "previous" is distinguishable.
		await execute(update, "call-set", { quickSearchChord: "Cmd+Shift+K" });
		expect((await readState()).quickSearch.chord).toBe("Mod+Shift+K");
		kit.takeChanges();

		for (const bare of ["F5", "Space"]) {
			const res = parse(await execute(update, `call-${bare}`, { quickSearchChord: bare }));
			expect(res.ok).toBe(false);
			const warnings = res.warnings as readonly string[];
			expect(warnings.length).toBeGreaterThanOrEqual(1);
			expect((await readState()).quickSearch.chord).toBe("Mod+Shift+K");
		}
		expect(kit.takeChanges()).toEqual([]);
	});

	it("refuses osMenuIntegration on linux but still applies the other valid fields", async () => {
		const settings = createStubSettings();
		const kit = createGeneralCustomizerToolkit({ settings, platform: "linux", language: () => "ko" });
		const update = tool(kit, "update_general_settings");

		const res = parse(await execute(update, "call-1", { osMenuIntegration: true, appearance: "dark" }));
		expect(res.ok).toBe(true);
		expect((res.warnings as readonly string[]).length).toBeGreaterThanOrEqual(1);

		const state = await readState();
		expect(state.appearance).toBe("dark");
		expect(state.osMenuIntegration).toBe(false);

		const changes = kit.takeChanges();
		expect(changes[0]?.kind).toBe("general");
		expect(changes[0]?.fields).toContain("appearance");
		expect(changes[0]?.fields).not.toContain("osMenuIntegration");
	});

	it("returns {ok:false,error} and records nothing when the OS menu install rejects", async () => {
		const settings = createStubSettings({
			applyOsMenu: async (next) => {
				if (next.osMenuIntegration) throw new Error("the right-click menu could not be written");
			},
		});
		const kit = createGeneralCustomizerToolkit({ settings, platform: "darwin", language: () => "ko" });
		const update = tool(kit, "update_general_settings");

		// Seed a known state so "nothing was written" is provable on disk.
		await execute(update, "call-init", { autoInstallUpdates: false });
		kit.takeChanges();

		const res = parse(await execute(update, "call-1", { osMenuIntegration: true, appearance: "dark" }));
		expect(res.ok).toBe(false);
		expect(res.error).toContain("could not be written");

		const state = await readState();
		expect(state.appearance).toBe("light");
		expect(state.autoInstallUpdates).toBe(false);
		expect(state.osMenuIntegration).toBe(false);
		expect(kit.takeChanges()).toEqual([]);
	});

	it("records a general change with kind 'general' and the touched field names", async () => {
		const settings = createStubSettings();
		const kit = createGeneralCustomizerToolkit({ settings, platform: "darwin", language: () => "ko" });
		const update = tool(kit, "update_general_settings");

		await execute(update, "call-1", { appearance: "dark", language: "ja" });

		const changes = kit.takeChanges();
		expect(changes).toHaveLength(1);
		expect(changes[0]?.kind).toBe("general");
		expect(changes[0]?.fields).toEqual(["appearance", "language"]);
		expect(changes[0]?.summary).toBeTypeOf("string");
		expect(changes[0]?.summary.length).toBeGreaterThan(0);
	});

	it("sets the document languages from the offered list and removes the key on reset", async () => {
		const settings = createStubSettings();
		const kit = createGeneralCustomizerToolkit({ settings, platform: "darwin", language: () => "ko" });
		const update = tool(kit, "update_reading");
		const readConfig = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(env.AUTORAG_CONFIG!, "utf8")) as Record<string, unknown>;

		const parsed = parse(await execute(update, "call-1", { languages: ["ko", "xx", "ja", "ja"] }));
		expect(parsed.ok).toBe(true);
		expect(String(parsed.warnings)).toContain("xx");
		expect((await readConfig()).languages).toEqual(["ko", "ja"]);

		const none = parse(await execute(update, "call-2", { languages: ["xx"] }));
		expect(none.ok).toBe(true);
		expect((await readConfig()).languages).toEqual(["ko", "ja"]);

		const reset = parse(await execute(update, "call-3", { reset: true }));
		expect(reset.ok).toBe(true);
		expect((await readConfig()).languages).toBeUndefined();

		const snapshot = parse(await execute(tool(kit, "get_general_settings"), "call-4", {}));
		expect(snapshot.documentLanguages).toMatchObject({ languages: ["ko", "en"], configured: false });
		const changes = kit.takeChanges();
		expect(changes.map((change) => change.kind)).toEqual(["general", "general"]);
		expect(changes[0]?.fields).toEqual(["languages"]);
	});

	it("reports the current values and platform availability in get_general_settings", async () => {
		const settings = createStubSettings();
		const linuxKit = createGeneralCustomizerToolkit({ settings, platform: "linux", language: () => "ko" });
		const snapshot = parse(await execute(tool(linuxKit, "get_general_settings"), "call-1", {}));
		expect(snapshot.platform).toBe("linux");
		expect(snapshot.unavailable).toEqual(["osMenuIntegration"]);
		const current = snapshot.current as Record<string, unknown>;
		expect(current.appearance).toBe("light");
		expect(current.quickSearch).toEqual({ enabled: true, chord: "Alt+Space" });

		const macKit = createGeneralCustomizerToolkit({ settings, platform: "darwin", language: () => "ko" });
		const macSnapshot = parse(await execute(tool(macKit, "get_general_settings"), "call-1", {}));
		expect(macSnapshot.unavailable).toEqual([]);
	});

	it("runs the profile on pi's faux provider, accepts the i intent field, and applies the change", async () => {
		const registration = register();
		const settings = createStubSettings();
		const kit = createGeneralCustomizerToolkit({ settings, platform: "darwin", language: () => "ko" });
		const profile = settingsCustomizerProfile({ language: "ko", surface: "general", toolkit: kit });

		const session = await createProfileSession({
			profile,
			cwd: root,
			agentDir,
			env,
			model: { model: registration.getModel()! },
		});
		cleanups.push(() => session.dispose());

		registration.setResponses([
			fauxAssistantMessage([fauxToolCall("update_general_settings", { i: "화면 모드를 어둡게 바꾸는 중", appearance: "dark" })]),
			fauxAssistantMessage("화면 모드를 다크로 바꿨습니다."),
		]);

		await session.prompt("화면 모드를 다크로 바꿔줘");

		expect((await settings.get()).appearance).toBe("dark");
		const changes = kit.takeChanges();
		expect(changes[0]?.kind).toBe("general");
		expect(changes[0]?.fields).toEqual(["appearance"]);
	});
});
