import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { createProfileSession } from "@autorag/librarian/profiles";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
	createDatasourceConnectionsToolkit,
	datasourceConnectionsProfile,
	DATASOURCE_TEMPLATE_CATALOG,
} from "../src/main/agents/profiles/datasource-connections-customizer";
import { DATASOURCE_SETUP_SKILLS } from "../src/main/agents/profiles/datasource-setup-skills";
import type { RunPrompter } from "../src/main/agents/customizer-prompter";
import { createAutoRagConfigService } from "../src/main/autorag-config-service";
import { createProviderCredentialService } from "../src/main/provider-credentials";
import { createSettingsService } from "../src/main/settings-service";
import type { DataSourceInstallState, DataSourceRow, DataSourcesSnapshot, SettingsBridge } from "../src/shared/settings-contract";

const cleanups: Array<() => Promise<void> | void> = [];
let root: string;
let agentDir: string;
let settingsDir: string;
let configPath: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ds-connections-root-"));
	agentDir = await mkdtemp(join(tmpdir(), "ds-connections-agent-"));
	settingsDir = join(root, "settings");
	configPath = join(root, "config.json");
	env = { HOME: root, AUTORAG_CONFIG: configPath };
	await writeFile(
		configPath,
		`${JSON.stringify(
			{
				searchPaths: [root],
				workspacePath: root,
				memoryPath: join(root, "memory.json"),
				datasources: {
					slack: { type: "slack", connector: { syncSource: "wiretap" } },
				},
			},
			null,
			2,
		)}\n`,
	);
	cleanups.push(
		() => rm(root, { recursive: true, force: true }),
		() => rm(agentDir, { recursive: true, force: true }),
	);
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const readConfig = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(configPath, "utf8"));

function makeRow(id: string, type: string, install: DataSourceInstallState, extra: Partial<DataSourceRow> = {}): DataSourceRow {
	return {
		id,
		type,
		description: "",
		enabled: true,
		status: "ready",
		install: { state: install, binary: null, path: null, detail: `${id} detail`, app: { required: false, installed: null, name: "" } },
		agent: { state: install === "unsupported" ? "unsupported" : "connected", skillName: null, tags: [], detail: "" },
		index: { state: "indexed", chunkCount: 5, unit: "message", indexedAt: null, detail: "" },
		...extra,
	};
}

interface FakePrompter extends RunPrompter {
	readonly confirmCalls: Array<{ readonly title: string; readonly lines: readonly string[] }>;
	readonly secretCalls: Array<{ readonly title: string; readonly detail: string; readonly hint?: string }>;
}

function fakePrompter(options: { readonly confirms?: readonly (boolean | undefined)[]; readonly secrets?: readonly (string | undefined)[] } = {}): FakePrompter {
	const confirms = [...(options.confirms ?? [])];
	const secrets = [...(options.secrets ?? [])];
	const confirmCalls: FakePrompter["confirmCalls"] = [];
	const secretCalls: FakePrompter["secretCalls"] = [];
	return {
		confirmCalls,
		secretCalls,
		async askConfirm(input) {
			confirmCalls.push(input);
			const next = confirms.shift();
			return next === undefined ? { kind: "cancelled" } : { kind: "confirm", confirmed: next };
		},
		async askSecret(input) {
			secretCalls.push(input as { readonly title: string; readonly detail: string; readonly hint?: string });
			const next = secrets.shift();
			return next === undefined ? { kind: "cancelled" } : { kind: "secret", value: next };
		},
	};
}

interface Harness {
	readonly settings: SettingsBridge;
	readonly rows: DataSourceRow[];
	readonly setEnabled: Mock;
	readonly setDescription: Mock;
	readonly reconcile: Mock;
	readonly sync: Mock;
	readonly credEnv: NodeJS.ProcessEnv;
}

function createHarness(options: { readonly rows?: DataSourceRow[]; readonly platform?: NodeJS.Platform } = {}): Harness {
	const rows = options.rows ?? [makeRow("slack", "slack", "installed")];
	const credEnv: NodeJS.ProcessEnv = {};
	const config = createAutoRagConfigService({ env, cwd: root });
	const credentials = createProviderCredentialService({
		filePath: join(root, "credentials.enc.json"),
		safeStorage: { isEncryptionAvailable: () => true, encryptString: (text) => Buffer.from(`enc:${text}`), decryptString: (buf) => buf.toString().slice(4) },
		env: credEnv,
	});
	const setEnabled = vi.fn(async (id: string, enabled: boolean) => {
		await config.patch([{ path: ["datasources", id, "enabled"], value: enabled }]);
		const row = rows.find((r) => r.id === id);
		if (row) (row as { enabled: boolean }).enabled = enabled;
	});
	const setDescription = vi.fn(async (id: string, description: string) => {
		const trimmed = description.trim();
		await config.patch([trimmed.length === 0 ? { path: ["datasources", id, "description"], remove: true } : { path: ["datasources", id, "description"], value: trimmed }]);
		const row = rows.find((r) => r.id === id);
		if (row) (row as { description: string }).description = trimmed;
	});
	const sync = vi.fn(async (id: string) => ({
		id,
		ok: true,
		state: "indexed" as const,
		chunkCount: 12,
		indexedAt: "2026-11-26T00:00:00.000Z",
		durationMs: 250,
		diagnostics: [],
		error: null,
	}));
	const reconcile = vi.fn(async () => ({ supported: true, mechanism: "launchd", installed: true, wanted: true, intervalMs: 3600000, lastTickAt: null, local: null, sources: {}, paused: null, conflicts: [], error: null }));
	const snapshot = async (): Promise<DataSourcesSnapshot> => {
		// Mirror live rows plus any newly added datasources in config.json.
		const cfg = await config.get();
		const ds = (cfg.config.datasources ?? {}) as Record<string, Record<string, unknown>>;
		const liveRows: DataSourceRow[] = Object.entries(ds).map(([id, raw]) => {
			const existing = rows.find((r) => r.id === id);
			if (existing !== undefined) return existing;
			const type = typeof raw?.type === "string" ? raw.type : id;
			return makeRow(id, type, "builtin", { enabled: raw?.enabled !== false, description: typeof raw?.description === "string" ? raw.description : "" });
		});
		return {
			configPath,
			configExists: true,
			error: null,
			refresh: { state: "idle", phase: null, finishedAt: null },
			local: { documentCount: 0, updatedAt: null },
			sources: liveRows,
		};
	};
	const settings = createSettingsService({
		directory: settingsDir,
		dataSources: { list: snapshot, setEnabled, setDescription, sync } as never,
		models: { resolve: vi.fn(), catalog: vi.fn() } as never,
		config,
		refreshConfig: vi.fn() as never,
		credentials,
		refreshScheduler: { status: vi.fn(), reconcile, remove: vi.fn() } as never,
	});
	return { settings, rows, setEnabled, setDescription, reconcile, sync, credEnv };
}

async function callTool(kit: ReturnType<typeof createDatasourceConnectionsToolkit>, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const tool = kit.tools.find((t) => t.name === name);
	if (tool === undefined) throw new Error(`tool ${name} not found`);
	const res = await tool.execute("call-1", args as never, undefined, undefined, undefined as never);
	const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
	return JSON.parse(text) as Record<string, unknown>;
}

describe("datasource-connections-customizer profile & toolkit", () => {
	it("exposes dedicated datasource connection management tools and English system prompt", () => {
		const harness = createHarness();
		const kit = createDatasourceConnectionsToolkit({ settings: harness.settings, platform: "darwin" });
		const profile = datasourceConnectionsProfile({ language: "ko", surface: "apps", toolkit: kit });

		expect(profile.id).toBe("datasource-connections-customizer");
		expect(profile.tools).toEqual([]);
		expect(profile.customTools?.map((t) => t.name).sort()).toEqual([
			"add_datasource",
			"get_datasources",
			"load_datasource_setup_skill",
			"remove_datasource",
			"set_datasource_credential",
			"sync_datasource",
			"update_datasource",
			"update_datasource_connector",
		]);
		expect(profile.systemPrompt).toMatch(/language the person writes in/iu);
		expect(profile.systemPrompt).toContain("if it is unclear, reply in Korean");
		expect(profile.systemPrompt).toContain("<available_skills>");
		expect(profile.systemPrompt).toContain("datasource-setup-nogon");
		expect(profile.systemPrompt).not.toMatch(/[가-힯぀-ヿ一-鿿]/u);
		expect(DATASOURCE_TEMPLATE_CATALOG.some((t) => t.id === "slack")).toBe(true);
		expect(DATASOURCE_TEMPLATE_CATALOG.some((t) => t.id === "obsidian")).toBe(true);
		expect(DATASOURCE_TEMPLATE_CATALOG.some((t) => t.id === "github")).toBe(true);
		// Every addable datasource template has a 1-to-1 dynamically loadable setup skill with pure-English content.
		expect(DATASOURCE_SETUP_SKILLS.map((s) => s.templateId).sort()).toEqual(
			DATASOURCE_TEMPLATE_CATALOG.map((t) => t.id).sort(),
		);
		for (const skill of DATASOURCE_SETUP_SKILLS) {
			expect(skill.content).not.toMatch(/[가-힯぀-ヿ一-鿿]/u);
		}
	});

	it("load_datasource_setup_skill dynamically loads setup guides by skill name, template id, CLI binary, or alias", async () => {
		const harness = createHarness();
		const kit = createDatasourceConnectionsToolkit({ settings: harness.settings, platform: "darwin" });
		const loader = kit.tools.find((t) => t.name === "load_datasource_setup_skill")!;

		const runLoad = async (name: string): Promise<string> => {
			const res = await loader.execute("call-1", { name } as never, undefined, undefined, undefined as never);
			return res.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
		};

		const byFullName = await runLoad("datasource-setup-nogon");
		expect(byFullName).toContain('<skill name="datasource-setup-nogon" location="dazzi-setup-skill://datasource-setup-nogon">');
		expect(byFullName).toContain("brew install nogon");
		expect(byFullName).toContain("Never");

		const byTemplateId = await runLoad("obsidian");
		expect(byTemplateId).toContain('name="datasource-setup-obsidian"');
		expect(byTemplateId).toContain("vaultPath");

		const byCliBinary = await runLoad("slacrawl");
		expect(byCliBinary).toContain('name="datasource-setup-slack"');
		expect(byCliBinary).toContain("workspace");

		const byAlias = await runLoad("mail");
		expect(byAlias).toContain('name="datasource-setup-mailcrawl"');

		const unknown = await runLoad("nonexistent-thing");
		expect(unknown).toContain("Unknown datasource setup skill");
		expect(unknown).toContain("datasource-setup-nogon");
	});

	it("get_datasources lists configured connections (with redacted connector fields) and available templates for the platform", async () => {
		const harness = createHarness();
		const winKit = createDatasourceConnectionsToolkit({ settings: harness.settings, platform: "win32" });
		const res = await callTool(winKit, "get_datasources", {});

		expect(res.ok).toBe(true);
		const configured = res.configured as Array<Record<string, unknown>>;
		expect(configured).toHaveLength(1);
		expect(configured[0]).toMatchObject({ id: "slack", type: "slack", installState: "installed", connector: { syncSource: "wiretap" } });

		const templates = res.templates as Array<Record<string, unknown>>;
		const kakao = templates.find((t) => t.id === "kakao");
		const obsidian = templates.find((t) => t.id === "obsidian");
		expect(kakao?.supportedOnPlatform).toBe(false);
		expect(obsidian?.supportedOnPlatform).toBe(true);
	});

	it("add_datasource connects a new datasource with template defaults and optional connector options", async () => {
		const harness = createHarness();
		const vault = join(root, "my-vault");
		await mkdir(vault, { recursive: true });
		const kit = createDatasourceConnectionsToolkit({ settings: harness.settings, platform: "darwin", language: () => "en" });

		const added = await callTool(kit, "add_datasource", {
			type: "obsidian",
			alias: "work-notes",
			description: "Work Obsidian vault",
			pollingIntervalMs: 3_600_000,
			connector: { vaultPath: vault },
		});
		expect(added.ok).toBe(true);

		const cfg = await readConfig();
		const ds = cfg.datasources as Record<string, Record<string, unknown>>;
		expect(ds["work-notes"]).toMatchObject({
			type: "obsidian",
			description: "Work Obsidian vault",
			pollingIntervalMs: 3_600_000,
			connector: { vaultPath: vault },
		});
		expect(harness.reconcile).toHaveBeenCalledTimes(1);
		const changes = kit.takeChanges();
		expect(changes).toHaveLength(1);
		expect(changes[0]?.kind).toBe("connections");
		expect(changes[0]?.fields).toContain("datasources.work-notes");
	});

	it("add_datasource applies built-in defaults (e.g. slack wiretap) and rejects unsupported platform templates or duplicate aliases", async () => {
		const harness = createHarness();
		const winKit = createDatasourceConnectionsToolkit({ settings: harness.settings, platform: "win32" });

		const dup = await callTool(winKit, "add_datasource", { type: "slack", alias: "slack" });
		expect(dup.ok).toBe(false);
		expect(String(dup.error)).toMatch(/already exists/i);

		const macOnly = await callTool(winKit, "add_datasource", { type: "kakao" });
		expect(macOnly.ok).toBe(false);
		expect(String(macOnly.error)).toMatch(/macOS|not supported/i);

		const secondSlack = await callTool(winKit, "add_datasource", { type: "slack", alias: "slack-team" });
		expect(secondSlack.ok).toBe(true);
		const cfg = await readConfig();
		expect((cfg.datasources as Record<string, Record<string, unknown>>)["slack-team"]).toMatchObject({
			type: "slack",
			connector: { syncSource: "wiretap" },
		});
	});

	it("update_datasource_connector edits and removes connector fields while blocking plaintext secrets", async () => {
		const harness = createHarness();
		const kit = createDatasourceConnectionsToolkit({ settings: harness.settings, platform: "darwin" });

		await callTool(kit, "add_datasource", { type: "github", alias: "gh" });
		kit.takeChanges();

		const secretRejected = await callTool(kit, "update_datasource_connector", {
			id: "gh",
			set: { token: "ghp_0123456789abcdef0123456789abcdef0123" },
		});
		expect(secretRejected.ok).toBe(false);

		const updated = await callTool(kit, "update_datasource_connector", {
			id: "gh",
			set: { repos: ["Marker-Inc-Korea/AutoRAG"], tokenEnv: "GITHUB_TOKEN", maxDocuments: 200 },
		});
		expect(updated.ok).toBe(true);
		let cfg = await readConfig();
		expect((((cfg.datasources as Record<string, Record<string, unknown>>).gh)?.connector as Record<string, unknown>)).toMatchObject({
			repos: ["Marker-Inc-Korea/AutoRAG"],
			tokenEnv: "GITHUB_TOKEN",
			maxDocuments: 200,
		});

		const removed = await callTool(kit, "update_datasource_connector", {
			id: "gh",
			remove: ["maxDocuments"],
		});
		expect(removed.ok).toBe(true);
		cfg = await readConfig();
		expect((((cfg.datasources as Record<string, Record<string, unknown>>).gh)?.connector as Record<string, unknown>).maxDocuments).toBeUndefined();
	});

	it("set_datasource_credential collects a token via the masked prompt and wires tokenEnv without exposing the value", async () => {
		const harness = createHarness();
		const prompter = fakePrompter({ secrets: ["ghp_SuperSecretTokenValue1234567890abcd"] });
		const known = new Set<string>();
		const kit = createDatasourceConnectionsToolkit({
			settings: harness.settings,
			platform: "darwin",
			secrets: { prompter: () => prompter, known },
		});

		await callTool(kit, "add_datasource", { type: "github", alias: "gh" });
		kit.takeChanges();

		const res = await callTool(kit, "set_datasource_credential", { id: "gh", envName: "GITHUB_TOKEN" });
		expect(res.ok).toBe(true);
		expect(JSON.stringify(res)).not.toContain("SuperSecretTokenValue");
		expect(known.has("ghp_SuperSecretTokenValue1234567890abcd")).toBe(true);
		expect(harness.credEnv.GITHUB_TOKEN).toBe("ghp_SuperSecretTokenValue1234567890abcd");
		const cfg = await readConfig();
		expect((((cfg.datasources as Record<string, Record<string, unknown>>).gh)?.connector as Record<string, unknown>).tokenEnv).toBe("GITHUB_TOKEN");
	});

	it("remove_datasource requires confirmedByUser and a confirmation card when a prompter is attached", async () => {
		const harness = createHarness();
		const prompter = fakePrompter({ confirms: [false, true] });
		const kit = createDatasourceConnectionsToolkit({
			settings: harness.settings,
			platform: "darwin",
			secrets: { prompter: () => prompter, known: new Set() },
		});

		const noFlag = await callTool(kit, "remove_datasource", { id: "slack" });
		expect(noFlag.ok).toBe(false);
		expect(prompter.confirmCalls).toHaveLength(0);

		const declined = await callTool(kit, "remove_datasource", { id: "slack", confirmedByUser: true });
		expect(declined.ok).toBe(false);
		expect(prompter.confirmCalls).toHaveLength(1);
		expect(((await readConfig()).datasources as Record<string, unknown>).slack).toBeDefined();

		const confirmed = await callTool(kit, "remove_datasource", { id: "slack", confirmedByUser: true });
		expect(confirmed.ok).toBe(true);
		expect(((await readConfig()).datasources as Record<string, unknown>).slack).toBeUndefined();
	});

	it("sync_datasource requires confirmedByUser + confirmation card and calls sourcesSync", async () => {
		const harness = createHarness();
		const prompter = fakePrompter({ confirms: [false, true] });
		const kit = createDatasourceConnectionsToolkit({
			settings: harness.settings,
			platform: "darwin",
			secrets: { prompter: () => prompter, known: new Set() },
		});

		const missingFlag = await callTool(kit, "sync_datasource", { id: "slack" });
		expect(missingFlag.ok).toBe(false);
		expect(harness.sync).not.toHaveBeenCalled();

		const declined = await callTool(kit, "sync_datasource", { id: "slack", confirmedByUser: true });
		expect(declined.ok).toBe(false);
		expect(harness.sync).not.toHaveBeenCalled();

		const synced = await callTool(kit, "sync_datasource", { id: "slack", confirmedByUser: true });
		expect(synced.ok).toBe(true);
		expect(harness.sync).toHaveBeenCalledWith("slack");
		expect(synced.state).toBe("indexed");
		expect(synced.chunkCount).toBe(12);
	});

	it("exposes the full read/write bash when shell dep is provided so it can inspect and set up local vaults/CLIs", async () => {
		const harness = createHarness();
		const vault = join(root, "DetectedVault");
		await mkdir(join(vault, ".obsidian"), { recursive: true });
		const kit = createDatasourceConnectionsToolkit({
			settings: harness.settings,
			platform: "darwin",
			shell: {
				cwd: root,
				env: { HOME: root, PATH: process.env.PATH ?? "" },
			},
		});

		expect(kit.tools.map((t) => t.name)).toContain("bash");
		const profile = datasourceConnectionsProfile({ language: "en", surface: "apps", toolkit: kit });
		expect(profile.systemPrompt).toContain("bash");
		expect(profile.systemPrompt).toContain("NOT MCP");
		expect(profile.systemPrompt).toContain("brew install nogon");
		expect(profile.systemPrompt).toContain("end-to-end");
		expect(profile.systemPrompt).not.toMatch(/[가-힯぀-ヿ一-鿿]/u);

		const bash = kit.tools.find((t) => t.name === "bash")!;
		const res = await bash.execute("call-1", { command: `ls -a ${vault}` } as never, undefined, undefined, undefined as never);
		const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
		expect(text).toContain(".obsidian");

		// Full read/write: a write outside the config file is no longer refused (v2.15 permission simplification).
		await bash.execute("call-2", { command: `echo ok > ${join(root, "setup-note.txt")}` } as never, undefined, undefined, undefined as never);
		expect(await readFile(join(root, "setup-note.txt"), "utf8")).toBe("ok\n");
	});

	it("runs end-to-end through createProfileSession with pi's faux provider", async () => {
		const registration: FauxProviderRegistration = registerFauxProvider({
			api: `faux-ds-conn-${Math.random().toString(36).slice(2)}`,
			provider: "faux-ds-conn",
			models: [{ id: "ds-conn", reasoning: true }],
		});
		cleanups.push(() => registration.unregister());

		const harness = createHarness();
		const kit = createDatasourceConnectionsToolkit({ settings: harness.settings, platform: "darwin", language: () => "ko" });
		const profile = datasourceConnectionsProfile({ language: "ko", surface: "apps", toolkit: kit });
		const session = await createProfileSession({
			profile,
			cwd: root,
			agentDir,
			env,
			model: { model: registration.getModel()! },
		});
		cleanups.push(() => session.dispose());

		registration.setResponses([
			fauxAssistantMessage([fauxToolCall("add_datasource", { i: "Obsidian 연결 추가 중", type: "obsidian", alias: "notes", connector: { vaultPath: root } })]),
			fauxAssistantMessage("Obsidian 연결을 추가했습니다."),
		]);

		await session.prompt("Obsidian 연결해줘");
		const cfg = await readConfig();
		expect((cfg.datasources as Record<string, Record<string, unknown>>).notes).toMatchObject({ type: "obsidian", connector: { vaultPath: root } });
	});
});
