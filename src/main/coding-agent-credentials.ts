/**
 * Finds the API keys other coding agents on this computer already hold, so the AI assistant's
 * `scan_coding_agents` / `import_coding_agent_key` tools can offer to move one into Dazzi's own
 * encrypted credential store.
 *
 * The module reads the other agents' config files *itself* and never returns a value to the model:
 * {@link scanCodingAgents} reports only where a key lives, and {@link readImportableSource} hands the
 * value to the app (which shows the person a confirmation first) — the model sees a masked tail at most.
 * OAuth tokens belong to the product that issued them (a Codex ChatGPT login, a Claude subscription),
 * so they are reported as `oauth` and never importable.
 *
 * Everything the filesystem touches is injectable, so tests use tmp fixtures and never touch the real machine.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultEnvName } from "../shared/ai-role-state";
import { isSecretKey } from "./autorag-config-service";
import { isJsonObject, type ProviderSummary } from "../shared/settings-contract";

export type CodingAgentCredentialKind = "api_key" | "oauth";

/** Where the app can read a value from; part of a report but never a value itself. */
export interface CredentialSource {
	/** A stable id the person/model passes to `import_coding_agent_key` (`codex-file`, `env:OPENAI_API_KEY`, …). */
	readonly source: string;
	/** A file path or an environment-variable name, shown to the person in the confirmation. */
	readonly from: string;
}

/** One credential a coding agent holds, as reported to the model: never the value. */
export interface DetectedCredential extends CredentialSource {
	readonly provider: string;
	readonly kind: CodingAgentCredentialKind;
	readonly envName?: string;
	/** True when this is an API key the app may import after a confirmation. */
	readonly importable: boolean;
	/** Whether Dazzi already has this provider connected. */
	readonly connected: boolean;
}

export interface CodingAgentReport {
	readonly id: string;
	readonly name: string;
	readonly installed: boolean;
	readonly version?: string;
	readonly credentials: readonly DetectedCredential[];
}

export interface CodingAgentScanResult {
	readonly agents: readonly CodingAgentReport[];
	/** The providers Dazzi knows, so the model can see which target it may import into. */
	readonly providers: readonly { readonly id: string; readonly name: string; readonly connected: boolean }[];
}

export interface CodingAgentScanInputs {
	readonly homeDir: string;
	readonly env: NodeJS.ProcessEnv;
	/**
	 * Environment variable names whose value Dazzi itself put there from its credential store. They are in `env` only because
	 * Dazzi loads them at startup, so they are not another program's keys and are neither listed nor importable.
	 */
	readonly ownEnvNames?: ReadonlySet<string>;
	readonly platform?: NodeJS.Platform;
	/** Resolve a binary on PATH; returns its path or null. */
	readonly which?: (bin: string) => string | null;
	/** Run a cheap probe (`--version`); returns trimmed stdout or null on any failure/timeout. */
	readonly exec?: (bin: string, args: readonly string[]) => string | null;
	readonly readFile?: (path: string) => string | null;
	readonly exists?: (path: string) => boolean;
}

/** A value the app may import; the only shape that carries a secret, and it never leaves the main process. */
export interface ImportableKey extends CredentialSource {
	readonly agent: string;
	readonly providerHint: string;
	readonly envName: string | undefined;
	readonly value: string;
}

interface RawCredential extends CredentialSource {
	readonly agent: string;
	readonly providerHint: string;
	readonly kind: CodingAgentCredentialKind;
	readonly envName?: string;
	readonly value?: string;
}

interface ResolvedInputs {
	readonly homeDir: string;
	readonly env: NodeJS.ProcessEnv;
	readonly ownEnvNames: ReadonlySet<string>;
	readonly which: (bin: string) => string | null;
	readonly exec: (bin: string, args: readonly string[]) => string | null;
	readonly readFile: (path: string) => string | null;
	readonly exists: (path: string) => boolean;
}

/** Provider-id spellings that agents use but Dazzi's Pi catalog spells differently. */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
	gemini: "google",
	"gemini-cli": "google",
	"google-gemini": "google",
	"openai-codex": "openai",
	"chatgpt": "openai",
	"claude": "anthropic",
};

const ENV_KEYS: ReadonlyArray<{ readonly name: string; readonly hint: string }> = [
	{ name: "ANTHROPIC_API_KEY", hint: "anthropic" },
	{ name: "OPENAI_API_KEY", hint: "openai" },
	{ name: "GEMINI_API_KEY", hint: "google" },
	{ name: "GOOGLE_API_KEY", hint: "google" },
	{ name: "OPENROUTER_API_KEY", hint: "openrouter" },
	{ name: "XAI_API_KEY", hint: "xai" },
	{ name: "MISTRAL_API_KEY", hint: "mistral" },
	{ name: "GROQ_API_KEY", hint: "groq" },
];

function defaultWhich(bin: string): string | null {
	const path = process.env.PATH ?? "";
	const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
	for (const dir of path.split(process.platform === "win32" ? ";" : ":")) {
		if (dir.length === 0) continue;
		for (const ext of exts) {
			const candidate = join(dir, bin + ext);
			try {
				accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {
				// Not here; keep looking.
			}
		}
	}
	return null;
}

function defaultExec(bin: string, args: readonly string[]): string | null {
	try {
		const result = spawnSync(bin, [...args], { timeout: 3000, encoding: "utf8" });
		if (result.error !== undefined || result.status !== 0) return null;
		const text = (result.stdout ?? "").trim();
		return text.length === 0 ? null : text.split("\n")[0]!.trim();
	} catch {
		return null;
	}
}

function resolveInputs(inputs: CodingAgentScanInputs): ResolvedInputs {
	return {
		homeDir: inputs.homeDir,
		env: inputs.env,
		ownEnvNames: inputs.ownEnvNames ?? new Set<string>(),
		which: inputs.which ?? defaultWhich,
		exec: inputs.exec ?? defaultExec,
		readFile: inputs.readFile ?? ((path) => (existsSync(path) ? readFileSync(path, "utf8") : null)),
		exists: inputs.exists ?? ((path) => existsSync(path)),
	};
}

function parseJson(text: string | null): Record<string, unknown> | null {
	if (text === null) return null;
	try {
		const value: unknown = JSON.parse(text);
		return isJsonObject(value) ? value : null;
	} catch {
		return null;
	}
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Every credential the coding agents on this machine appear to hold, values included. */
function collectCredentials(raw: ResolvedInputs): readonly RawCredential[] {
	const out: RawCredential[] = [];
	const version = (bin: string | null): string | undefined => (bin === null ? undefined : raw.exec(bin, ["--version"]) ?? undefined);

	// Claude Code — the login is a subscription OAuth token, reported but never importable.
	{
		const bin = raw.which("claude");
		const dir = join(raw.homeDir, ".claude");
		const credFile = join(dir, ".credentials.json");
		if (raw.exists(credFile) || raw.exists(dir)) {
			out.push({ agent: "claude-code", providerHint: "anthropic", kind: "oauth", source: "claude-oauth", from: raw.exists(credFile) ? credFile : dir });
		}
		void version(bin);
	}

	// Codex — an API key field and, when signed in with ChatGPT, an oauth `tokens` object.
	{
		const file = join(raw.homeDir, ".codex", "auth.json");
		const json = raw.exists(file) ? parseJson(raw.readFile(file)) : null;
		if (json !== null) {
			const key = nonEmptyString(json.OPENAI_API_KEY);
			if (key !== null) out.push({ agent: "codex", providerHint: "openai", kind: "api_key", envName: "OPENAI_API_KEY", source: "codex-file", from: file, value: key });
			if (isJsonObject(json.tokens)) out.push({ agent: "codex", providerHint: "openai", kind: "oauth", source: "codex-oauth", from: file });
		}
	}

	// Gemini CLI — its key lives in the environment.
	{
		for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY"] as const) {
			const value = nonEmptyString(raw.env[name]);
			if (value !== null) out.push({ agent: "gemini-cli", providerHint: "google", kind: "api_key", envName: name, source: `env:${name}`, from: name, value });
		}
	}

	// opencode — auth.json keyed by provider, each `{type:'api',key}` or `{type:'oauth'}`.
	{
		const file = join(raw.homeDir, ".local", "share", "opencode", "auth.json");
		const json = raw.exists(file) ? parseJson(raw.readFile(file)) : null;
		if (json !== null) {
			for (const [name, entry] of Object.entries(json)) {
				if (!isJsonObject(entry)) continue;
				if (entry.type === "api") {
					const key = nonEmptyString(entry.key);
					if (key !== null) out.push({ agent: "opencode", providerHint: name, kind: "api_key", envName: defaultEnvName(name), source: "opencode-file", from: file, value: key });
				} else if (entry.type === "oauth") {
					out.push({ agent: "opencode", providerHint: name, kind: "oauth", source: "opencode-oauth", from: file });
				}
			}
		}
	}

	// pi — Dazzi's own runtime profile, same `auth.json` shape as opencode.
	{
		const file = join(raw.homeDir, ".pi", "agent", "auth.json");
		const json = raw.exists(file) ? parseJson(raw.readFile(file)) : null;
		if (json !== null) {
			for (const [name, entry] of Object.entries(json)) {
				if (!isJsonObject(entry)) continue;
				if (entry.type === "api_key") {
					const key = nonEmptyString(entry.key);
					if (key !== null) out.push({ agent: "pi", providerHint: name, kind: "api_key", envName: defaultEnvName(name), source: "pi-file", from: file, value: key });
				} else if (entry.type === "oauth") {
					out.push({ agent: "pi", providerHint: name, kind: "oauth", source: "pi-oauth", from: file });
				}
			}
		}
	}

	// Aider — `openai-api-key: sk-…` style lines in a YAML config.
	{
		const file = join(raw.homeDir, ".aider.conf.yml");
		const text = raw.exists(file) ? raw.readFile(file) : null;
		if (text !== null) {
			for (const line of text.split(/\r?\n/u)) {
				const match = /^\s*([A-Za-z0-9_-]*?)[-_]?api[-_]?key\s*:\s*(.+?)\s*$/iu.exec(line);
				if (match === null) continue;
				const prefix = (match[1] ?? "").replace(/[-_]+$/u, "");
				const value = (match[2] ?? "").replace(/^["']|["']$/gu, "");
				if (value.length === 0) continue;
				out.push({ agent: "aider", providerHint: prefix.length > 0 ? prefix : "openai", kind: "api_key", ...(prefix.length > 0 ? { envName: defaultEnvName(prefix) } : {}), source: "aider-file", from: file, value });
			}
		}
	}

	// The process environment itself.
	{
		for (const { name, hint } of ENV_KEYS) {
			if (raw.ownEnvNames.has(name)) continue;
			const value = nonEmptyString(raw.env[name]);
			if (value !== null) out.push({ agent: "env", providerHint: hint, kind: "api_key", envName: name, source: `env:${name}`, from: name, value });
		}
	}

	return out;
}

const AGENT_NAMES: Readonly<Record<string, string>> = {
	"claude-code": "Claude Code",
	codex: "Codex",
	"gemini-cli": "Gemini CLI",
	opencode: "opencode",
	pi: "pi",
	aider: "Aider",
	env: "Process environment",
};

function agentInstalled(raw: ResolvedInputs, id: string): { installed: boolean; version?: string } {
	const installedIn = (bin: string | null, ...paths: string[]): { installed: boolean; version?: string } => {
		const installed = bin !== null || paths.some((path) => raw.exists(path));
		if (!installed) return { installed: false };
		const version = bin === null ? undefined : raw.exec(bin, ["--version"]) ?? undefined;
		return version === undefined ? { installed: true } : { installed: true, version };
	};
	switch (id) {
		case "claude-code":
			return installedIn(raw.which("claude"), join(raw.homeDir, ".claude"));
		case "codex":
			return installedIn(raw.which("codex"), join(raw.homeDir, ".codex"));
		case "gemini-cli":
			return installedIn(raw.which("gemini"), join(raw.homeDir, ".gemini"));
		case "opencode":
			return installedIn(raw.which("opencode"), join(raw.homeDir, ".local", "share", "opencode"));
		case "pi":
			return installedIn(null, join(raw.homeDir, ".pi", "agent"));
		case "aider":
			return installedIn(raw.which("aider"), join(raw.homeDir, ".aider.conf.yml"));
		default:
			return { installed: true };
	}
}

/** The Dazzi provider a hint (and its env name) maps to, or null when Dazzi has no such provider. */
export function matchProvider(
	providers: readonly ProviderSummary[],
	hint: string,
	envName: string | undefined,
): ProviderSummary | null {
	const lower = hint.trim().toLowerCase();
	const id = PROVIDER_ALIASES[lower] ?? lower;
	const direct = providers.find((provider) => provider.id === id) ?? providers.find((provider) => provider.id === lower);
	if (direct !== undefined) return direct;
	if (envName !== undefined) {
		const byEnv = providers.find((provider) => provider.apiKeyEnv?.toLowerCase() === envName.toLowerCase());
		if (byEnv !== undefined) return byEnv;
	}
	return null;
}

/** The report the model gets: which agents exist, what keys they hold, and where — no values. */
export function scanCodingAgents(inputs: CodingAgentScanInputs, providers: readonly ProviderSummary[]): CodingAgentScanResult {
	const raw = resolveInputs(inputs);
	const candidates = collectCredentials(raw);

	const agents: CodingAgentReport[] = Object.keys(AGENT_NAMES).map((id) => {
		const { installed, version } = agentInstalled(raw, id);
		const credentials: DetectedCredential[] = installed
			? candidates
					.filter((credential) => credential.agent === id)
					.map((credential) => {
						const matched = matchProvider(providers, credential.providerHint, credential.envName);
						return {
							provider: matched?.id ?? credential.providerHint,
							kind: credential.kind,
							...(credential.envName === undefined ? {} : { envName: credential.envName }),
							source: credential.source,
							from: credential.from,
							importable: credential.kind === "api_key" && credential.value !== undefined,
							connected: matched?.authConfigured ?? false,
						};
					})
			: [];
		return version === undefined ? { id, name: AGENT_NAMES[id]!, installed, credentials } : { id, name: AGENT_NAMES[id]!, installed, version, credentials };
	});

	return {
		agents,
		providers: providers.map((provider) => ({ id: provider.id, name: provider.name, connected: provider.authConfigured })),
	};
}

/** The value behind a source id returned by {@link scanCodingAgents}, for the app to store after a confirmation. */
export function readImportableSource(
	source: string,
	inputs: CodingAgentScanInputs,
): { readonly ok: true; readonly key: ImportableKey } | { readonly ok: false; readonly error: string; readonly sources: readonly string[] } {
	const raw = resolveInputs(inputs);
	const apiKeySources = collectCredentials(raw).filter((credential) => credential.kind === "api_key" && credential.value !== undefined);
	const match = apiKeySources.find((credential) => credential.source === source);
	if (match === undefined || match.value === undefined) {
		return {
			ok: false,
			error: `'${source}' is not a source of an importable API key. Importable sources are: ${apiKeySources.map((credential) => credential.source).join(", ") || "(none found)"}.`,
			sources: apiKeySources.map((credential) => credential.source),
		};
	}
	return {
		ok: true,
		key: { agent: match.agent, providerHint: match.providerHint, envName: match.envName, source: match.source, from: match.from, value: match.value },
	};
}


/** Keys inside another program's credential file whose value is a secret (a token, a key), as opposed to an id or a mode. */
const SECRET_FIELD = /(?:^|[_-])(?:api[_-]?key|key|token|secret|password|passwd|access|refresh|accesstoken|refreshtoken|credential)s?$/iu;

function secretValuesOf(node: unknown, found: Set<string>, depth = 0): void {
	if (depth > 6) return;
	if (Array.isArray(node)) {
		for (const item of node) secretValuesOf(item, found, depth + 1);
		return;
	}
	if (!isJsonObject(node)) return;
	for (const [key, value] of Object.entries(node)) {
		if (typeof value === "string") {
			if (value.length >= 8 && SECRET_FIELD.test(key)) found.add(value);
		} else {
			secretValuesOf(value, found, depth + 1);
		}
	}
}

/**
 * The secret values the assistant can see but must never repeat: the tokens and keys in other coding agents' credential files, in
 * pi's `auth.json`, and in secret-looking environment variables. Reading these files is free (that is how another agent's config is
 * found), so the values go into the known set the redaction nets use: whatever a command prints, the reply cannot echo them.
 */
export function collectKnownSecretValues(input: {
	readonly homeDir: string;
	readonly agentDir: string;
	readonly env: NodeJS.ProcessEnv;
}): readonly string[] {
	const found = new Set<string>();
	const files = [
		join(input.homeDir, ".codex", "auth.json"),
		join(input.homeDir, ".claude", ".credentials.json"),
		join(input.homeDir, ".claude.json"),
		join(input.homeDir, ".gemini", "oauth_creds.json"),
		join(input.homeDir, ".local", "share", "opencode", "auth.json"),
		join(input.homeDir, ".pi", "agent", "auth.json"),
		join(input.agentDir, "auth.json"),
	];
	for (const file of files) {
		try {
			if (!existsSync(file)) continue;
			secretValuesOf(JSON.parse(readFileSync(file, "utf8")), found);
		} catch {
			// An unreadable or unparseable file holds nothing the assistant could have been shown.
		}
	}
	for (const [name, value] of Object.entries(input.env)) {
		if (typeof value === "string" && value.length >= 8 && isSecretKey(name)) found.add(value);
	}
	return [...found];
}
