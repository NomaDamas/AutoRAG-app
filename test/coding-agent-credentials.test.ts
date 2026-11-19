import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchProvider, readImportableSource, scanCodingAgents, type CodingAgentScanInputs } from "../src/main/coding-agent-credentials";
import type { ProviderSummary } from "../src/shared/settings-contract";

let home: string;
const cleanups: Array<() => Promise<void> | void> = [];

// Distinctive fake keys; each must stay out of the model's JSON.
const CODEX_KEY = "sk-proj-CODEXfake0000000000000001";
const OPENCODE_KEY = "sk-proj-OPENCODEfake00000000002";
const PI_KEY = "sk-or-v1-PIfake0000000000000000003";
const AIDER_OPENAI_KEY = "sk-AIDERfakeopenai00000000004";
const AIDER_ANTHROPIC_KEY = "sk-ant-AIDERfakeanthropic00005";
const GEMINI_ENV_KEY = "AIzaGEMINIenvfake00000000000006";
const GROQ_ENV_KEY = "gsk_GROQenvfake000000000000000000007";

function provider(id: string, apiKeyEnv: string, authConfigured = false): ProviderSummary {
	return { id, name: id, baseUrl: null, kind: "runtime", authKinds: ["api_key"], subscription: false, authConfigured, authSource: authConfigured ? "stored" : "none", apiKeyEnv, models: [] };
}

const PROVIDERS: readonly ProviderSummary[] = [
	provider("anthropic", "ANTHROPIC_API_KEY"),
	provider("openai", "OPENAI_API_KEY"),
	provider("google", "GEMINI_API_KEY"),
	provider("openrouter", "OPENROUTER_API_KEY", true),
	provider("groq", "GROQ_API_KEY"),
];

function inputs(env: NodeJS.ProcessEnv): CodingAgentScanInputs {
	return { homeDir: home, env, which: () => null, exec: () => null };
}

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "coding-agents-"));
	cleanups.push(() => rm(home, { recursive: true, force: true }));

	await mkdir(join(home, ".codex"), { recursive: true });
	await writeFile(join(home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: CODEX_KEY, tokens: { access_token: "opaque" } }));

	await mkdir(join(home, ".local", "share", "opencode"), { recursive: true });
	await writeFile(
		join(home, ".local", "share", "opencode", "auth.json"),
		JSON.stringify({ openai: { type: "api", key: OPENCODE_KEY }, anthropic: { type: "oauth", refresh: "x", access: "y" } }),
	);

	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(join(home, ".pi", "agent", "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: PI_KEY } }));

	await writeFile(
		join(home, ".aider.conf.yml"),
		["openai-api-key: " + AIDER_OPENAI_KEY, "anthropic-api-key: " + AIDER_ANTHROPIC_KEY, "auto-commits: false"].join("\n"),
	);

	await mkdir(join(home, ".claude"), { recursive: true });
	await writeFile(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "opaque" } }));

	await mkdir(join(home, ".gemini"), { recursive: true });
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("scanCodingAgents", () => {
	it("reports each agent's credentials as locations and provider ids, never a value", () => {
		const result = scanCodingAgents(inputs({ GEMINI_API_KEY: GEMINI_ENV_KEY, GROQ_API_KEY: GROQ_ENV_KEY }), PROVIDERS);
		const text = JSON.stringify(result);
		for (const secret of [CODEX_KEY, OPENCODE_KEY, PI_KEY, AIDER_OPENAI_KEY, AIDER_ANTHROPIC_KEY, GEMINI_ENV_KEY, GROQ_ENV_KEY]) {
			expect(text).not.toContain(secret);
		}
		expect(text).not.toContain("access_token");
		expect(text).not.toContain("claudeAiOauth");
	});

	it("maps Codex api_key + oauth, opencode, pi, Aider and the environment to Dazzi providers", () => {
		const result = scanCodingAgents(inputs({ GEMINI_API_KEY: GEMINI_ENV_KEY, GROQ_API_KEY: GROQ_ENV_KEY }), PROVIDERS);
		const byId = new Map(result.agents.map((agent) => [agent.id, agent]));

		expect(byId.get("codex")?.credentials).toEqual([
			{ provider: "openai", kind: "api_key", envName: "OPENAI_API_KEY", source: "codex-file", from: join(home, ".codex", "auth.json"), importable: true, connected: false },
			{ provider: "openai", kind: "oauth", source: "codex-oauth", from: join(home, ".codex", "auth.json"), importable: false, connected: false },
		]);

		const opencode = byId.get("opencode")!.credentials;
		expect(opencode).toContainEqual({ provider: "openai", kind: "api_key", envName: "OPENAI_API_KEY", source: "opencode-file", from: join(home, ".local", "share", "opencode", "auth.json"), importable: true, connected: false });
		expect(opencode).toContainEqual({ provider: "anthropic", kind: "oauth", source: "opencode-oauth", from: join(home, ".local", "share", "opencode", "auth.json"), importable: false, connected: false });

		expect(byId.get("pi")?.credentials).toEqual([
			{ provider: "openrouter", kind: "api_key", envName: "OPENROUTER_API_KEY", source: "pi-file", from: join(home, ".pi", "agent", "auth.json"), importable: true, connected: true },
		]);

		const aider = byId.get("aider")!.credentials;
		expect(aider).toContainEqual({ provider: "openai", kind: "api_key", envName: "OPENAI_API_KEY", source: "aider-file", from: join(home, ".aider.conf.yml"), importable: true, connected: false });
		expect(aider).toContainEqual({ provider: "anthropic", kind: "api_key", envName: "ANTHROPIC_API_KEY", source: "aider-file", from: join(home, ".aider.conf.yml"), importable: true, connected: false });

		expect(byId.get("claude-code")?.credentials).toEqual([
			{ provider: "anthropic", kind: "oauth", source: "claude-oauth", from: join(home, ".claude", ".credentials.json"), importable: false, connected: false },
		]);

		const env = byId.get("env")!.credentials;
		expect(env).toContainEqual({ provider: "google", kind: "api_key", envName: "GEMINI_API_KEY", source: "env:GEMINI_API_KEY", from: "GEMINI_API_KEY", importable: true, connected: false });
		expect(env).toContainEqual({ provider: "groq", kind: "api_key", envName: "GROQ_API_KEY", source: "env:GROQ_API_KEY", from: "GROQ_API_KEY", importable: true, connected: false });
	});

	it("lists the Dazzi providers and whether they are connected", () => {
		const result = scanCodingAgents(inputs({}), PROVIDERS);
		expect(result.providers).toEqual([
			{ id: "anthropic", name: "anthropic", connected: false },
			{ id: "openai", name: "openai", connected: false },
			{ id: "google", name: "google", connected: false },
			{ id: "openrouter", name: "openrouter", connected: true },
			{ id: "groq", name: "groq", connected: false },
		]);
	});

	it("marks an agent installed from its binary alone and a version from the injected exec", () => {
		const withBin: CodingAgentScanInputs = { homeDir: home, env: {}, which: (bin) => (bin === "codex" ? "/usr/local/bin/codex" : null), exec: () => "1.2.3" };
		const result = scanCodingAgents(withBin, PROVIDERS);
		const codex = result.agents.find((agent) => agent.id === "codex")!;
		expect(codex.installed).toBe(true);
		expect(codex.version).toBe("1.2.3");
	});
});

describe("matchProvider", () => {
	it("maps provider-id aliases and falls back to an env name", () => {
		expect(matchProvider(PROVIDERS, "gemini", undefined)?.id).toBe("google");
		expect(matchProvider(PROVIDERS, "google-gemini", undefined)?.id).toBe("google");
		expect(matchProvider(PROVIDERS, "openai-codex", undefined)?.id).toBe("openai");
		expect(matchProvider(PROVIDERS, "unknown-x", "GROQ_API_KEY")?.id).toBe("groq");
		expect(matchProvider(PROVIDERS, "unknown-x", undefined)).toBeNull();
	});
});

describe("readImportableSource", () => {
	it("returns the value for an api_key source", () => {
		const found = readImportableSource("codex-file", inputs({}));
		expect(found).toEqual({ ok: true, key: { agent: "codex", providerHint: "openai", envName: "OPENAI_API_KEY", source: "codex-file", from: join(home, ".codex", "auth.json"), value: CODEX_KEY } });
	});

	it("refuses an unknown source and lists only the importable ones", () => {
		const found = readImportableSource("nope-file", inputs({}));
		expect(found.ok).toBe(false);
		if (found.ok) throw new Error("expected refusal");
		expect(found.sources).toContain("codex-file");
		expect(found.sources).not.toContain("codex-oauth");
		expect(found.error).toMatch(/nope-file/);
	});

	it("refuses an oauth source", () => {
		const found = readImportableSource("codex-oauth", inputs({}));
		expect(found.ok).toBe(false);
	});
});
