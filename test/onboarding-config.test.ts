import { buildDatasourceSkills, type DatasourcesConfig } from "@autorag/librarian";
import { describe, expect, it } from "vitest";
import { applyIndexingConfig } from "../src/main/onboarding-config";
import { isJsonObject } from "../src/shared/settings-contract";

const HOME = "/Users/me";

describe("applyIndexingConfig", () => {
	it("replaces searchPaths and leaves an existing embedder untouched", () => {
		const raw = { searchPaths: ["/old"], minSync: { embedder: { profile: "keep", dimension: 1 }, other: true } };
		const next = applyIndexingConfig({
			raw,
			folders: ["/a", "/b"],
			datasources: [],
			home: HOME,
			embedder: null,
			workspacePath: null,
			model: null,
		});
		expect(next.searchPaths).toEqual(["/a", "/b"]);
		expect(isJsonObject(next.minSync) && next.minSync.embedder).toEqual({ profile: "keep", dimension: 1 });
		expect(isJsonObject(next.minSync) && next.minSync.other).toBe(true);
	});

	it("replaces workspacePath only when one is given", () => {
		const base = { raw: { workspacePath: "/keep" }, folders: ["/a"], datasources: [], home: HOME, embedder: null, model: null };
		expect(applyIndexingConfig({ ...base, workspacePath: null }).workspacePath).toBe("/keep");
		expect(applyIndexingConfig({ ...base, workspacePath: "/home/.autorag/workspace" }).workspacePath).toBe("/home/.autorag/workspace");
	});

	it("creates the local embedder block when the config has none", () => {
		const next = applyIndexingConfig({
			raw: {},
			folders: ["/a"],
			datasources: [],
			home: HOME,
			embedder: { profile: "qwen3-embedding-0.6b", dimension: 1024 },
			workspacePath: null,
			model: null,
		});
		expect(isJsonObject(next.minSync) && next.minSync.embedder).toEqual({ profile: "qwen3-embedding-0.6b", dimension: 1024 });
	});

	it("merges datasource aliases, keeping other existing fields", () => {
		const raw = { datasources: { github: { type: "github", description: "old", pollingIntervalMs: 60 } } };
		const next = applyIndexingConfig({
			raw,
			folders: ["/a"],
			datasources: [{ id: "github", facts: { repos: ["me/one", "me/two"] } }],
			home: HOME,
			embedder: null,
			workspacePath: null,
			model: null,
		});
		const github = isJsonObject(next.datasources) && isJsonObject(next.datasources.github) ? next.datasources.github : {};
		// Onboarding writes no description, and an existing one is kept.
		expect(github.description).toBe("old");
		expect(github.pollingIntervalMs).toBe(60);
		expect(isJsonObject(github.connector) && github.connector.repos).toEqual(["me/one", "me/two"]);
	});

	it("writes datasource entries the librarian builds into skills, keeping existing entries", () => {
		const next = applyIndexingConfig({
			raw: { datasources: { archive: { type: "rss", tags: ["existing"] } } },
			folders: ["/a"],
			datasources: [
				{ id: "kakao", facts: {} },
				{ id: "slack", facts: {} },
				{ id: "discord", facts: {} },
				{ id: "telegram", facts: {} },
				{ id: "whatsapp", facts: {} },
				{ id: "mailcrawl", facts: { accounts: ["gmail", "work"] } },
				{ id: "github", facts: { repos: ["me/repo"] } },
				{ id: "obsidian", facts: { vaults: ["/v1", "/v2"] } },
			],
			home: HOME,
			embedder: null,
			workspacePath: null,
			model: null,
		});
		expect(next.datasourceAccess).toBeUndefined();
		const { skills, unknown } = buildDatasourceSkills({ ...(next.datasources as DatasourcesConfig), excluded: { type: "whatsapp", instanceId: "x" } });
		expect(unknown).toEqual([]);
		const names = ["archive", "kakao", "slack", "discord", "telegram", "whatsapp", "mailcrawl-gmail", "mailcrawl-work", "github", "obsidian", "obsidian-2"];
		for (const name of names) {
			expect(skills.some((skill) => skill.describe().name === name), name).toBe(true);
		}
	});

	it("sets KATOK_EMBEDDER=local-test on the onboarding kakao connector so the first index builds semantic windows without fastembed", () => {
		const next = applyIndexingConfig({
			raw: { datasources: { kakao: { description: "existing", pollingIntervalMs: 3600000 } } },
			folders: ["/a"],
			datasources: [{ id: "kakao", facts: { chats: 12 } }],
			home: HOME,
			embedder: null,
			workspacePath: null,
			model: null,
		});
		const datasources = isJsonObject(next.datasources) ? next.datasources : {};
		const kakao = isJsonObject(datasources.kakao) ? datasources.kakao : {};
		expect(kakao).toEqual({
			description: "existing",
			pollingIntervalMs: 3600000,
			instanceId: "default",
			connector: {
				env: {
					KATOK_EMBEDDER: "local-test",
				},
			},
		});
	});

	it("writes one obsidian alias per vault", () => {
		const next = applyIndexingConfig({
			raw: {},
			folders: ["/a"],
			datasources: [{ id: "obsidian", facts: { vaults: ["/v1", "/v2"] } }],
			home: HOME,
			embedder: null,
			workspacePath: null,
			model: null,
		});
		const datasources = isJsonObject(next.datasources) ? next.datasources : {};
		const first = isJsonObject(datasources.obsidian) ? datasources.obsidian : {};
		const second = isJsonObject(datasources["obsidian-2"]) ? datasources["obsidian-2"] : {};
		expect(isJsonObject(first.connector) && first.connector.vaultPath).toBe("/v1");
		expect(isJsonObject(second.connector) && second.connector.vaultPath).toBe("/v2");
	});

	it("gives every verified mail account its own mailcrawl archive under the home directory", () => {
		const next = applyIndexingConfig({
			raw: { datasources: { "mailcrawl-gmail": { connector: { timeoutMs: 60 } } } },
			folders: ["/a"],
			datasources: [{ id: "mailcrawl", facts: { accounts: ["gmail", "work.kr"] } }],
			home: HOME,
			embedder: null,
			workspacePath: null,
			model: null,
		});
		const datasources = isJsonObject(next.datasources) ? next.datasources : {};
		const gmail = isJsonObject(datasources["mailcrawl-gmail"]) ? datasources["mailcrawl-gmail"] : {};
		const work = isJsonObject(datasources["mailcrawl-work.kr"]) ? datasources["mailcrawl-work.kr"] : {};
		expect(gmail.type).toBe("mailcrawl");
		expect(gmail.instanceId).toBe("gmail");
		expect(gmail.connector).toEqual({ account: "gmail", mailbox: "INBOX", dataDir: "/Users/me/.mailcrawl/gmail" });
		expect(isJsonObject(work.connector) && work.connector.dataDir).toBe("/Users/me/.mailcrawl/work.kr");
	});

	it("writes the BYOK model block and leaves managed plans alone", () => {
		const byok = applyIndexingConfig({
			raw: { model: { provider: "old", id: "old" } },
			folders: ["/a"],
			datasources: [],
			home: HOME,
			embedder: null,
			workspacePath: null,
			model: { provider: "openai-compatible", modelId: "my-model", baseUrl: "http://127.0.0.1:8080", envName: "OPENAI_COMPATIBLE_API_KEY" },
		});
		expect(byok.model).toEqual({
			provider: "openai-compatible",
			id: "my-model",
			baseUrl: "http://127.0.0.1:8080",
			api: "openai-completions",
			apiKeyEnv: "OPENAI_COMPATIBLE_API_KEY",
		});
		const managed = applyIndexingConfig({
			raw: { model: { provider: "old", id: "old" } },
			folders: ["/a"],
			datasources: [],
			home: HOME,
			embedder: null,
			workspacePath: null,
			model: null,
		});
		expect(managed.model).toEqual({ provider: "old", id: "old" });
	});
});
