import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectKnownSecretValues } from "../src/main/coding-agent-credentials";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("collectKnownSecretValues: what the assistant may read but must never repeat", () => {
	it("gathers the secret values in other agents' config and in the environment", async () => {
		const home = await mkdtemp(join(tmpdir(), "known-secrets-"));
		cleanups.push(() => rm(home, { recursive: true, force: true }));
		await mkdir(join(home, ".codex"), { recursive: true });
		await mkdir(join(home, ".claude"), { recursive: true });
		await mkdir(join(home, ".local", "share", "opencode"), { recursive: true });
		const agentDir = join(home, "pi-agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-proj-CodexKey0123456789", tokens: { access_token: "opaque-codex-access-token-0001", refresh_token: "opaque-codex-refresh-0002", account_id: "acct-1" }, auth_mode: "chatgpt" }));
		await writeFile(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "opaque-claude-access-0003", refreshToken: "opaque-claude-refresh-0004", expiresAt: 1 } }));
		await writeFile(join(home, ".local", "share", "opencode", "auth.json"), JSON.stringify({ anthropic: { type: "api", key: "sk-ant-api03-OpenCodeKey0123456789" } }));
		await writeFile(join(agentDir, "auth.json"), JSON.stringify({ dazzi: { type: "oauth", access: "opaque-dazzi-access-0005", refresh: "opaque-dazzi-refresh-0006", expires: 1 } }));

		const values = collectKnownSecretValues({ homeDir: home, agentDir, env: { OPENROUTER_API_KEY: "or-key-env-0123456789", PATH: "/usr/bin", EDITOR: "vim" } });

		for (const secret of ["sk-proj-CodexKey0123456789", "opaque-codex-access-token-0001", "opaque-codex-refresh-0002", "opaque-claude-access-0003", "opaque-claude-refresh-0004", "sk-ant-api03-OpenCodeKey0123456789", "opaque-dazzi-access-0005", "opaque-dazzi-refresh-0006", "or-key-env-0123456789"]) {
			expect(values, secret).toContain(secret);
		}
		// Ordinary values are not secrets: redacting "vim" or an account id would mangle every answer.
		expect(values).not.toContain("vim");
		expect(values).not.toContain("/usr/bin");
		expect(values).not.toContain("acct-1");
		expect(values).not.toContain("chatgpt");
	});

	it("is empty, not an error, when nothing is installed", () => {
		expect(collectKnownSecretValues({ homeDir: "/nonexistent-home-xyz", agentDir: "/nonexistent-agent-xyz", env: {} })).toEqual([]);
	});

	it("skips a file it cannot parse", async () => {
		const home = await mkdtemp(join(tmpdir(), "known-secrets-bad-"));
		cleanups.push(() => rm(home, { recursive: true, force: true }));
		await mkdir(join(home, ".codex"), { recursive: true });
		await writeFile(join(home, ".codex", "auth.json"), "{ not json");
		expect(collectKnownSecretValues({ homeDir: home, agentDir: join(home, "x"), env: {} })).toEqual([]);
	});
});
