import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAutoRagConfigService } from "../src/main/autorag-config-service";
import type { JsonValue } from "../src/shared/settings-contract";

const REDACTED = "__AUTORAG_SECRET_REDACTED__";
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface Fixture {
	readonly root: string;
	readonly configPath: string;
	readonly env: NodeJS.ProcessEnv;
}

async function createFixture(config: Record<string, unknown> | null, prefix: string): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	directories.push(root);
	const configPath = join(root, "config.json");
	if (config != null) await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
	return { root, configPath, env: { HOME: root, AUTORAG_CONFIG: configPath } };
}

function baseConfig(root: string): Record<string, unknown> {
	return {
		searchPaths: [root],
		workspacePath: root,
		memoryPath: join(root, "memory.json"),
	};
}

describe("createAutoRagConfigService", () => {
	it("redacts secrets but keeps maxTokens and returns unknown fields", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-config-redact-"));
		directories.push(root);
		const configPath = join(root, "config.json");
		await writeFile(
			configPath,
			`${JSON.stringify({
				...baseConfig(root),
				parserOptions: { maxTokens: 4096, apiKey: "top-secret", nested: { refreshToken: "abc" } },
				customUnknown: { keep: 1 },
			}, null, 2)}\n`,
		);
		const service = createAutoRagConfigService({ env: { HOME: root, AUTORAG_CONFIG: configPath }, cwd: root });

		const snapshot = await service.get();

		expect(snapshot.error).toBeNull();
		const parserOptions = snapshot.config.parserOptions as Record<string, unknown>;
		expect(parserOptions.maxTokens).toBe(4096);
		expect(parserOptions.apiKey).toBe(REDACTED);
		expect((parserOptions.nested as Record<string, unknown>).refreshToken).toBe(REDACTED);
		expect(snapshot.config.customUnknown).toEqual({ keep: 1 });
	});

	it("merges a narrow write and preserves unrelated and unknown fields", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-config-merge-"));
		const fixture = await createFixture(
			{
				...baseConfig(root),
				model: { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" },
				customUnknown: "keep-me",
			},
			"autorag-config-merge-",
		);
		const service = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });

		const snapshot = await service.set(["parserOptions", "maxTokens"], 8192);

		expect(snapshot.error).toBeNull();
		const written = JSON.parse(await readFile(fixture.configPath, "utf8")) as Record<string, unknown>;
		expect(written.customUnknown).toBe("keep-me");
		expect((written.model as Record<string, unknown>).provider).toBe("openrouter");
		expect((written.parserOptions as Record<string, unknown>).maxTokens).toBe(8192);
	});

	it("restores the original secret when the redaction sentinel is written back", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-config-secret-"));
		const fixture = await createFixture(
			{ ...baseConfig(root), parserOptions: { apiKey: "top-secret" } },
			"autorag-config-secret-",
		);
		const service = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });

		const redacted = ((await service.get()).config.parserOptions as Record<string, unknown>).apiKey;
		expect(redacted).toBe(REDACTED);

		if (typeof redacted !== "string") throw new Error("Expected redacted string");
		await service.set(["parserOptions", "apiKey"], redacted);

		const written = JSON.parse(await readFile(fixture.configPath, "utf8")) as Record<string, unknown>;
		expect((written.parserOptions as Record<string, unknown>).apiKey).toBe("top-secret");
	});

	it("rejects forbidden roots and prototype-pollution paths without touching disk", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-config-forbidden-"));
		const fixture = await createFixture(baseConfig(root), "autorag-config-forbidden-");
		const service = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });
		const before = await readFile(fixture.configPath, "utf8");

		await expect(service.set(["workspacePath"], "/elsewhere")).rejects.toThrow(/managed by AutoRAG/);
		await expect(service.set(["memoryPath"], "/tmp/x.json")).rejects.toThrow(/managed by AutoRAG/);
		await expect(service.set(["__proto__", "polluted"], true)).rejects.toThrow(/Invalid AutoRAG config path/);
		await expect(service.set([], {})).rejects.toThrow(/must not be empty/);

		expect(await readFile(fixture.configPath, "utf8")).toBe(before);
	});

	it("rejects a known type violation and leaves the file unchanged", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-config-type-"));
		const fixture = await createFixture(baseConfig(root), "autorag-config-type-");
		const service = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });
		const before = await readFile(fixture.configPath, "utf8");

		await expect(service.set(["jikji"], 5)).rejects.toThrow(/jikji must be an object or false/);
		await expect(service.set(["datasources", "team-slack", "enabled"], "yes")).rejects.toThrow(/enabled must be a boolean/);

		expect(await readFile(fixture.configPath, "utf8")).toBe(before);
	});

	it("accepts a zero polling interval but rejects negatives and non-integers", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-config-polling-"));
		const fixture = await createFixture(baseConfig(root), "autorag-config-polling-");
		const service = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });

		await service.set(["datasources", "notes", "type"], "obsidian");
		const snapshot = await service.set(["datasources", "notes", "pollingIntervalMs"], 0);
		expect(snapshot.error).toBeNull();
		expect((snapshot.config.datasources as Record<string, Record<string, unknown>>).notes?.pollingIntervalMs).toBe(0);

		await expect(service.set(["datasources", "notes", "pollingIntervalMs"], -1)).rejects.toThrow(/non-negative integer/);
		await expect(service.set(["datasources", "notes", "pollingIntervalMs"], 1.5)).rejects.toThrow(/non-negative integer/);
	});

	it("validates minSync.embedder fields and the loopback rule", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-config-embedder-"));
		const fixture = await createFixture(baseConfig(root), "autorag-config-embedder-");
		const service = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });

		await expect(service.set(["minSync", "embedder", "profile"], "not-a-profile")).rejects.toThrow(/profile was removed/);
		await expect(service.set(["minSync", "embedder", "dimension"], 0)).rejects.toThrow(/dimension must be a positive integer/);
		await expect(
			service.set(["minSync", "embedder"], { id: "bge-m3", baseUrl: "https://api.example.com", dimension: 1024 }),
		).rejects.toThrow(/loopback/);

		const ok = await service.set(["minSync", "embedder"], { id: "bge-m3", baseUrl: "http://127.0.0.1:11434", dimension: 1024 });
		expect(ok.error).toBeNull();
		expect(ok.config.minSync).toMatchObject({ embedder: { id: "bge-m3", dimension: 1024 } });
	});

	it("refuses to disable MinSync, which the librarian requires", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-config-minsync-"));
		const fixture = await createFixture(baseConfig(root), "autorag-config-minsync-");
		const service = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });

		await expect(service.set(["minSync"], false)).rejects.toThrow(/MinSync is required/);
		await expect(service.set(["minSync", "enabled"], false)).rejects.toThrow(/MinSync is required/);
		const ok = await service.set(["minSync", "enabled"], true);
		expect(ok.error).toBeNull();
	});

	it("validates webSearch through the effective loader (librarian drops it)", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-config-websearch-"));
		const fixture = await createFixture(baseConfig(root), "autorag-config-websearch-");
		const service = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });

		await expect(service.set(["webSearch"], { provider: "not-a-provider" })).rejects.toThrow(/webSearch.provider/);

		const ok = await service.set(["webSearch"], { provider: "duckduckgo", timeoutSeconds: 30 });
		expect(ok.error).toBeNull();
		expect((ok.config.webSearch as Record<string, unknown>).provider).toBe("duckduckgo");
	});

	it("supports boolean section edits and nested multi-instance datasources", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-config-sections-"));
		const fixture = await createFixture(baseConfig(root), "autorag-config-sections-");
		const service = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });

		await service.set(["fsearch"], false);
		await service.set(["datasources", "team-slack", "type"], "slack");
		await service.set(["datasources", "team-slack", "instanceId"], "team-a");

		const written = JSON.parse(await readFile(fixture.configPath, "utf8")) as Record<string, unknown>;
		expect(written.fsearch).toBe(false);
		expect(written.datasources).toEqual({ "team-slack": { type: "slack", instanceId: "team-a" } });
	});

	it("removes a key to fall back to librarian defaults without touching siblings", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-config-remove-"));
		const fixture = await createFixture(
			{ ...baseConfig(root), parserOptions: { maxTokens: 4096, apiKey: "keep" } },
			"autorag-config-remove-",
		);
		const service = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });

		await service.remove(["parserOptions", "maxTokens"]);

		const written = JSON.parse(await readFile(fixture.configPath, "utf8")) as Record<string, unknown>;
		expect((written.parserOptions as Record<string, unknown>).maxTokens).toBeUndefined();
		expect((written.parserOptions as Record<string, unknown>).apiKey).toBe("keep");
	});

	it("preserves a disabled section when editing one of its leaves", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-config-disabled-"));
		const fixture = await createFixture(baseConfig(root), "autorag-config-disabled-");
		const service = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });

		await service.set(["fsearch"], false);
		const snapshot = await service.set(["fsearch", "timeoutMs"], 5000);

		expect(snapshot.config.fsearch).toEqual({ enabled: false, timeoutMs: 5000 });
	});

	it("rejects a new plaintext secret in the config file", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-config-plaintext-"));
		const fixture = await createFixture(baseConfig(root), "autorag-config-plaintext-");
		const service = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });
		const before = await readFile(fixture.configPath, "utf8");

		await expect(service.set(["datasources", "slack", "connector", "token"], "xoxb-secret")).rejects.toThrow(/credentials API/);
		await expect(service.set(["datasources", "slack", "connector"], { env: { password: "hunter2" } })).rejects.toThrow(/credentials API/);
		expect(await readFile(fixture.configPath, "utf8")).toBe(before);
	});

	it("restricts only corpus embedding endpoints to loopback and rejects malformed/non-http URLs", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-config-egress-"));
		const fixture = await createFixture(baseConfig(root), "autorag-config-egress-");
		const service = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });
		const before = await readFile(fixture.configPath, "utf8");

		await expect(service.set(["minSync", "embedder", "baseUrl"], "https://api.example.com/v1")).rejects.toThrow(/loopback/);
		await expect(service.set(["minSync", "embedder", "baseUrl"], "not a url")).rejects.toThrow(/valid loopback URL/);
		await expect(service.set(["minSync", "embedder", "baseUrl"], "ftp://127.0.0.1/v1")).rejects.toThrow(/http or https/);
		await expect(service.set(["datasources", "lark", "connector", "embedderBaseUrl"], "https://embed.example.com")).rejects.toThrow(/loopback/);
		expect(await readFile(fixture.configPath, "utf8")).toBe(before);

		// A connector's normal remote API URL must not be restricted.
		const github = await service.set(["datasources", "team", "connector", "baseUrl"], "https://api.github.com");
		expect(github.error).toBeNull();
		const lark = await service.set(["datasources", "lark", "connector", "endpoint"], "https://open.larksuite.com");
		expect(lark.error).toBeNull();

		const ok = await service.set(["minSync", "embedder", "baseUrl"], "http://127.0.0.1:8080/v1");
		expect(ok.error).toBeNull();

		// Dazzi cloud embedding endpoint is allowed for minSync.embedder.baseUrl.
		const dazziCloud = await service.set(["minSync", "embedder"], {
			id: "openai:qwen/qwen3-embedding-0.6b",
			baseUrl: "https://api.dazziapp.com",
			dimension: 1024,
			apiKeyEnv: "OPENAI_API_KEY",
		});
		expect(dazziCloud.error).toBeNull();
		expect(dazziCloud.config.minSync).toMatchObject({
			embedder: {
				id: "openai:qwen/qwen3-embedding-0.6b",
				baseUrl: "https://api.dazziapp.com",
				dimension: 1024,
				apiKeyEnv: "OPENAI_API_KEY",
			},
		});
	});

	it("applies a configPatch atomically and leaves disk untouched when any update is invalid", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-config-patch-"));
		const fixture = await createFixture(baseConfig(root), "autorag-config-patch-");
		const service = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });
		const before = await readFile(fixture.configPath, "utf8");

		await expect(
			service.patch([
				{ path: ["parserOptions", "maxTokens"], value: 1234 },
				{ path: ["jikji"], value: 5 },
			]),
		).rejects.toThrow(/jikji must be an object or false/);
		expect(await readFile(fixture.configPath, "utf8")).toBe(before);

		const snapshot = await service.patch([
			{ path: ["parserOptions", "maxTokens"], value: 1234 },
			{ path: ["parserOptions", "ocr", "enabled"], value: true },
		]);
		expect(snapshot.error).toBeNull();
		expect(snapshot.config.parserOptions).toEqual({ maxTokens: 1234, ocr: { enabled: true } });
	});

	it("renames a config entry in one write", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-config-rename-"));
		const fixture = await createFixture(
			{ ...baseConfig(root), datasources: { old: { type: "slack" } } },
			"autorag-config-rename-",
		);
		const service = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });

		const snapshot = await service.rename(["datasources", "old"], ["datasources", "new"]);
		expect(snapshot.config.datasources).toEqual({ new: { type: "slack" } });

		await expect(service.rename(["datasources", "missing"], ["datasources", "x"])).rejects.toThrow(/not found/);
	});

	it("rejects a bad appIndexing block", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-config-appindexing-"));
		const fixture = await createFixture(baseConfig(root), "autorag-config-appindexing-");
		const service = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });

		await expect(service.set(["appIndexing", "excludeCodeFolders"], "yes")).rejects.toThrow(/excludeCodeFolders must be a boolean/);
		await expect(service.set(["appIndexing", "semanticSearch"], "no")).rejects.toThrow(/semanticSearch must be a boolean/);
		await expect(service.set(["appIndexing", "semanticSearch"], false)).resolves.toBeDefined();
	});

	it("applies set and remove updates in one configPatch and rejects the whole batch on failure", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-config-patch-mixed-"));
		const fixture = await createFixture(
			{ ...baseConfig(root), parserOptions: { maxTokens: 4096, apiKey: "keep" } },
			"autorag-config-patch-mixed-",
		);
		const service = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });
		const before = await readFile(fixture.configPath, "utf8");

		await expect(
			service.patch([
				{ path: ["parserOptions", "maxTokens"], remove: true },
				{ path: ["jikji"], value: 5 },
			]),
		).rejects.toThrow(/jikji must be an object or false/);
		expect(await readFile(fixture.configPath, "utf8")).toBe(before);

		const snapshot = await service.patch([
			{ path: ["parserOptions", "maxTokens"], remove: true },
			{ path: ["parserOptions", "ocr", "enabled"], value: true },
		]);
		expect(snapshot.error).toBeNull();
		expect(snapshot.config.parserOptions).toEqual({ apiKey: REDACTED, ocr: { enabled: true } });
	});

	it("rejects a rename onto an occupied destination, onto itself, or into its own descendant without touching disk", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-config-rename-guard-"));
		const fixture = await createFixture(
			{ ...baseConfig(root), datasources: { old: { type: "slack" }, taken: { type: "rss" } } },
			"autorag-config-rename-guard-",
		);
		const service = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });
		const before = await readFile(fixture.configPath, "utf8");

		await expect(service.rename(["datasources", "old"], ["datasources", "taken"])).rejects.toThrow(/already exists/);
		await expect(service.rename(["datasources", "old"], ["datasources", "old"])).rejects.toThrow(/same path/);
		await expect(service.rename(["datasources"], ["datasources", "nested"])).rejects.toThrow(/own descendant/);
		await expect(service.rename(["datasources", "missing"], ["datasources", "x"])).rejects.toThrow(/not found/);
		expect(await readFile(fixture.configPath, "utf8")).toBe(before);
	});

	it("rejects prototype-pollution keys nested inside a written value without touching disk", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-config-pollution-"));
		const fixture = await createFixture(baseConfig(root), "autorag-config-pollution-");
		const service = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });
		const before = await readFile(fixture.configPath, "utf8");

		const polluted: JsonValue = JSON.parse('{"__proto__": {"polluted": true}}');
		await expect(service.set(["customUnknown"], polluted)).rejects.toThrow(/must be JSON/);
		await expect(service.patch([{ path: ["nested", "ok"], value: 1 }, { path: ["nested", "bad"], value: { constructor: {} } }])).rejects.toThrow(
			/must be JSON/,
		);
		expect(await readFile(fixture.configPath, "utf8")).toBe(before);
	});

	it("rejects parserOptions false (unsupported upstream) but accepts zero-valued jikji limits", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-config-parserfalse-"));
		const fixture = await createFixture(baseConfig(root), "autorag-config-parserfalse-");
		const service = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });
		const before = await readFile(fixture.configPath, "utf8");

		await expect(service.set(["parserOptions"], false)).rejects.toThrow(/parserOptions must be an object/);
		expect(await readFile(fixture.configPath, "utf8")).toBe(before);

		const jikji = await service.set(["jikji"], { maxFiles: 0, parseTimeout: 0, maxHashBytes: 0, docTextMaxChars: 0 });
		expect(jikji.error).toBeNull();
		await expect(service.set(["jikji"], { maxFiles: -1 })).rejects.toThrow(/non-negative integer/);
	});

	it("rejects malformed connector number/list/boolean options exposed by the datasource forms", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-config-connector-"));
		const fixture = await createFixture(baseConfig(root), "autorag-config-connector-");
		const service = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });
		const before = await readFile(fixture.configPath, "utf8");

		await expect(service.set(["datasources", "github", "connector", "maxPages"], "many")).rejects.toThrow(/maxPages must be a number/);
		await expect(service.set(["datasources", "github", "connector", "repos"], "octo/repo")).rejects.toThrow(/repos must be a non-empty string array/);
		await expect(service.set(["datasources", "rss", "connector", "feeds"], [{ url: 5 }])).rejects.toThrow(/array of \{ url, category\? \} entries/);
		await expect(service.set(["datasources", "cloud-drive", "connector", "dryRun"], "yes")).rejects.toThrow(/dryRun must be a boolean/);
		await expect(service.set(["datasources", "cloud-drive", "connector", "parserOptions", "ocr", "enabled"], "yes")).rejects.toThrow(
			/ocr\.enabled must be a boolean/,
		);
		await expect(service.set(["datasources", "cloud-drive", "connector", "parserOptions", "kordoc", "ocr"], 5)).rejects.toThrow(
			/kordoc\.ocr must be a boolean or a provider name/,
		);
		await expect(service.set(["datasources", "team", "channels", "ids"], "general")).rejects.toThrow(/channels\.ids must be a non-empty string array/);
		expect(await readFile(fixture.configPath, "utf8")).toBe(before);

		const ok = await service.set(["datasources", "cloud-drive", "connector"], {
			extensions: [".md"],
			maxDocuments: 10,
			dryRun: false,
			parserOptions: { languages: ["ko"], ocr: { enabled: true, timeoutMs: 1000 }, kordoc: { ocr: "force" } },
		});
		expect(ok.error).toBeNull();
	});

	it("validates the app-owned thinking levels and rejects unknown fields", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-config-thinking-"));
		const fixture = await createFixture(baseConfig(root), "autorag-config-thinking-");
		const service = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });
		const before = await readFile(fixture.configPath, "utf8");

		await expect(service.set(["thinking", "final"], "extreme")).rejects.toThrow(/thinking\.final must be one of/);
		await expect(service.set(["thinking", "medium"], "high")).rejects.toThrow(/not a recognized field/);
		await expect(service.set(["thinking"], [])).rejects.toThrow(/thinking must be an object/);
		expect(await readFile(fixture.configPath, "utf8")).toBe(before);

		const written = await service.set(["thinking"], { fast: "off", final: "xhigh" });
		expect(written.error).toBeNull();
		expect(written.config.thinking).toEqual({ fast: "off", final: "xhigh" });
	});
});
