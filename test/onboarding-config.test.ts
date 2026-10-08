import { describe, expect, it } from "vitest";
import { applyIndexingConfig } from "../src/main/onboarding-config";
import { isJsonObject } from "../src/shared/settings-contract";

const MAIL_DIR = "/Users/me/Library/Mail";

describe("applyIndexingConfig", () => {
	it("replaces searchPaths and leaves an existing embedder untouched", () => {
		const raw = { searchPaths: ["/old"], minSync: { embedder: { profile: "keep", dimension: 1 }, other: true } };
		const next = applyIndexingConfig({
			raw,
			folders: ["/a", "/b"],
			datasources: [],
			mailDir: MAIL_DIR,
			embedder: null,
			workspacePath: null,
			model: null,
		});
		expect(next.searchPaths).toEqual(["/a", "/b"]);
		expect(isJsonObject(next.minSync) && next.minSync.embedder).toEqual({ profile: "keep", dimension: 1 });
		expect(isJsonObject(next.minSync) && next.minSync.other).toBe(true);
	});

	it("replaces workspacePath only when one is given", () => {
		const base = { raw: { workspacePath: "/keep" }, folders: ["/a"], datasources: [], mailDir: MAIL_DIR, embedder: null, model: null };
		expect(applyIndexingConfig({ ...base, workspacePath: null }).workspacePath).toBe("/keep");
		expect(applyIndexingConfig({ ...base, workspacePath: "/home/.autorag/workspace" }).workspacePath).toBe("/home/.autorag/workspace");
	});

	it("creates the local embedder block when the config has none", () => {
		const next = applyIndexingConfig({
			raw: {},
			folders: ["/a"],
			datasources: [],
			mailDir: MAIL_DIR,
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
			datasources: [{ id: "github", description: "new", facts: { repos: ["me/one", "me/two"] } }],
			mailDir: MAIL_DIR,
			embedder: null,
			workspacePath: null,
			model: null,
		});
		const github = isJsonObject(next.datasources) && isJsonObject(next.datasources.github) ? next.datasources.github : {};
		expect(github.description).toBe("new");
		expect(github.pollingIntervalMs).toBe(60);
		expect(isJsonObject(github.connector) && github.connector.repos).toEqual(["me/one", "me/two"]);
	});

	it("unions allowedTags with each enabled source's default tag", () => {
		const raw = { datasourceAccess: { allowedTags: ["existing"], allowedScopes: ["x"] } };
		const next = applyIndexingConfig({
			raw,
			folders: ["/a"],
			datasources: [
				{ id: "spotlight", description: "s", facts: {} },
				{ id: "slack", description: "k", facts: {} },
			],
			mailDir: MAIL_DIR,
			embedder: null,
			workspacePath: null,
			model: null,
		});
		const access = isJsonObject(next.datasourceAccess) ? next.datasourceAccess : {};
		const slack = isJsonObject(next.datasources) && isJsonObject(next.datasources.slack) ? next.datasources.slack : {};
		const slackConnector = isJsonObject(slack.connector) ? slack.connector : {};
		expect(slack.type).toBe("slack");
		// slacrawl's default sync is the API source, which exits nonzero without
		// SLACK_BOT_TOKEN and fails the whole first index; the wiretap source
		// reads the local Slack Desktop cache and needs no token.
		expect(slackConnector.syncSource).toBe("wiretap");
	});

	it("writes one obsidian alias per vault and maps mail to a Spotlight query", () => {
		const next = applyIndexingConfig({
			raw: {},
			folders: ["/a"],
			datasources: [
				{ id: "obsidian", description: "o", facts: { vaults: ["/v1", "/v2"] } },
				{ id: "mail", description: "m", facts: {} },
			],
			mailDir: MAIL_DIR,
			embedder: null,
			workspacePath: null,
			model: null,
		});
		const datasources = isJsonObject(next.datasources) ? next.datasources : {};
		const first = isJsonObject(datasources.obsidian) ? datasources.obsidian : {};
		const second = isJsonObject(datasources["obsidian-2"]) ? datasources["obsidian-2"] : {};
		expect(isJsonObject(first.connector) && first.connector.vaultPath).toBe("/v1");
		expect(isJsonObject(second.connector) && second.connector.vaultPath).toBe("/v2");
		const mail = isJsonObject(datasources.mail) ? datasources.mail : {};
		expect(mail.type).toBe("spotlight");
		expect(isJsonObject(mail.connector) && mail.connector.onlyIn).toBe(MAIL_DIR);
	});

	it("writes the BYOK model block and leaves managed plans alone", () => {
		const byok = applyIndexingConfig({
			raw: { model: { provider: "old", id: "old" } },
			folders: ["/a"],
			datasources: [],
			mailDir: MAIL_DIR,
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
			mailDir: MAIL_DIR,
			embedder: null,
			workspacePath: null,
			model: null,
		});
		expect(managed.model).toEqual({ provider: "old", id: "old" });
	});
});
