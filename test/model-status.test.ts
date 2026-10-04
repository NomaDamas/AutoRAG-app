import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfigReadOnly } from "@autorag/librarian";
import { resolveAgentModelDetailed } from "@autorag/librarian/core";
import { afterEach, describe, expect, it } from "vitest";
import { createModelStatusService } from "../src/main/model-status";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface Fixture {
	readonly root: string;
	readonly configPath: string;
	readonly env: NodeJS.ProcessEnv;
}

async function createFixture(prefix: string): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	directories.push(root);
	const configPath = join(root, "config.json");
	return { root, configPath, env: { HOME: root, AUTORAG_CONFIG: configPath, OPENROUTER_API_KEY: "test-key" } };
}

const OPENROUTER_MODEL = {
	provider: "openrouter",
	id: "deepseek/deepseek-v4.1-flash",
	baseUrl: "https://openrouter.ai/api/v1",
	api: "openai-completions",
	apiKeyEnv: "OPENROUTER_API_KEY",
};

describe("createModelStatusService", () => {
	it("reports the provider and model the shared config resolves for the agent", async () => {
		const fixture = await createFixture("autorag-model-status-");
		await writeFile(
			fixture.configPath,
			`${JSON.stringify({
				searchPaths: [fixture.root],
				workspacePath: fixture.root,
				model: OPENROUTER_MODEL,
			}, null, 2)}\n`,
		);

		// The shared resolver labels a catalog model with the catalog's human name
		// (e.g. "DeepSeek: DeepSeek V4.1 Flash") and falls back to the model id when
		// the catalog entry is unavailable, so assert against what it actually
		// labeled instead of pinning one build's catalog text.
		const { role } = resolveAgentModelDetailed(
			resolveConfigReadOnly({ flags: {}, env: fixture.env, cwd: fixture.root }),
			{ env: fixture.env },
		);

		const snapshot = await createModelStatusService({ env: fixture.env, cwd: fixture.root }).resolve();

		expect(snapshot.error).toBeNull();
		expect(snapshot.configPath).toBe(fixture.configPath);
		expect(snapshot.configExists).toBe(true);
		expect(snapshot.model).toEqual({
			provider: "openrouter",
			modelId: "deepseek/deepseek-v4.1-flash",
			displayName: role.displayName,
			api: "openai-completions",
			baseUrl: "https://openrouter.ai/api/v1",
			resolutionSource: "config",
			auth: { present: true, source: "env", envName: "OPENROUTER_API_KEY" },
		});
	});

	it("surfaces a config without a resolvable model as an error with no model", async () => {
		const fixture = await createFixture("autorag-model-status-error-");
		await writeFile(
			fixture.configPath,
			`${JSON.stringify({
				searchPaths: [fixture.root],
				workspacePath: fixture.root,
				model: { provider: "openai", id: "ghost-model-xyz" },
			}, null, 2)}\n`,
		);

		const snapshot = await createModelStatusService({ env: fixture.env, cwd: fixture.root }).resolve();

		expect(snapshot.configExists).toBe(true);
		expect(snapshot.model).toBeNull();
		expect(snapshot.error).toContain("Unknown configured model");
	});

	it("reports a missing config file without throwing", async () => {
		const fixture = await createFixture("autorag-model-status-missing-");
		// No model in config falls back to the local runtime under $HOME; point
		// HOME at the fixture so no real ~/.codex/config.toml leaks in.
		const previousHome = process.env.HOME;
		process.env.HOME = fixture.root;
		try {
			const snapshot = await createModelStatusService({ env: fixture.env, cwd: fixture.root }).resolve();

			expect(snapshot.configPath).toBe(fixture.configPath);
			expect(snapshot.configExists).toBe(false);
			expect(snapshot.model).toBeNull();
			expect(snapshot.error).not.toBeNull();
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
	});
});
