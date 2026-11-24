/**
 * Reads a person's omp (oh-my-pi, `~/.omp`) model setup so the AI assistant's Settings can offer to
 * bring the whole thing into Dazzi as it is. omp is different from the other coding agents: it does not
 * just hold a key under a known provider name, it holds *custom provider definitions* — a wire protocol
 * (`api`), a base URL, a key reference, and a model list, often thirty models long.
 *
 * Two files hold the setup:
 *  - `~/.omp/agent/models.yml` describes every provider. Its `apiKey` is normally an ENV NAME REFERENCE
 *    (`NAME`, `$NAME`, `${NAME}`), sometimes a literal secret, and occasionally a `!command`.
 *  - `~/.omp/agent/agent.db` (SQLite) holds the key omp actually resolved, in `auth_credentials`. OAuth
 *    rows belong to omp and the vendor that issued them, so they are only reported, never importable.
 *
 * The value behind an env reference is not in either file: it lives in the person's environment — the
 * Dazzi process env, then a shell profile, then `~/.omp/agent/.env`. Only {@link resolveOmpProviderKey}
 * and {@link readOmpApiKeys} return a secret; {@link readOmpProviders} never does, and the model never
 * sees one. Everything the filesystem and SQLite touch is injectable, so tests use tmp fixtures.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse as parseYaml, type ScalarTag } from "yaml";
import { isJsonObject } from "../shared/settings-contract";

/** How a provider's `apiKey` is written in models.yml. */
export type OmpKeyKind = "env" | "literal" | "command" | "none";

/** One model as omp's models.yml describes it; the subset Dazzi's provider entry needs. */
export interface OmpProviderModel {
	readonly id: string;
	readonly name: string;
	readonly reasoning?: boolean;
	readonly input?: readonly ("text" | "image")[];
	readonly contextWindow?: number;
	readonly maxTokens?: number;
}

/** One custom provider from omp's models.yml, with no secret in it. */
export interface OmpProviderDefinition {
	/** The key under `providers:` in models.yml. */
	readonly name: string;
	/** The wire protocol as written (`openai-responses`, `openai-completions`, `anthropic-messages`, …). */
	readonly api: string;
	readonly baseUrl: string;
	/** The environment variable an env-reference `apiKey` names, otherwise null. */
	readonly keyEnvName: string | null;
	readonly keyKind: OmpKeyKind;
	readonly models: readonly OmpProviderModel[];
}

/** The statement/database surface {@link OmpInputs.openDb} must provide — a subset of `node:sqlite`. */
export interface OmpDbStatement {
	all(): readonly unknown[];
}

export interface OmpDb {
	prepare(sql: string): OmpDbStatement;
	close(): void;
}

export interface OmpInputs {
	readonly homeDir: string;
	readonly env: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
	readonly readFile?: (path: string) => string | null;
	readonly exists?: (path: string) => boolean;
	readonly openDb?: (path: string) => OmpDb | null;
}

/** One `api_key` row of `agent.db`, with the key omp resolved. */
export interface OmpApiKey {
	readonly provider: string;
	readonly value: string;
	readonly disabled: boolean;
}

/** One `oauth` row of `agent.db`; reported so the UI can explain why it is not importable. */
export interface OmpOauthEntry {
	readonly provider: string;
	readonly disabled: boolean;
}

const AGENT_DIR = join(".omp", "agent");
const MODELS_FILE = join(AGENT_DIR, "models.yml");
const DB_FILE = join(AGENT_DIR, "agent.db");
const ENV_FILE = join(AGENT_DIR, ".env");

/** Shell profiles a person may keep an export in, in the order Dazzi reads them. */
const PROFILE_FILES: readonly { readonly path: string; readonly fish: boolean }[] = [
	{ path: ".zshrc", fish: false },
	{ path: ".zprofile", fish: false },
	{ path: ".zshenv", fish: false },
	{ path: ".bashrc", fish: false },
	{ path: ".bash_profile", fish: false },
	{ path: ".profile", fish: false },
	{ path: join(".config", "fish", "config.fish"), fish: true },
];

/** The shape a `!command` scalar resolves to, so a command key is distinguishable from a literal. */
interface OmpCommandValue {
	readonly __ompCommand: string;
}

const COMMAND_TAG: ScalarTag = {
	tag: "!command",
	resolve: (value: string): OmpCommandValue => ({ __ompCommand: value }),
};

interface ResolvedOmpInputs {
	readonly homeDir: string;
	readonly env: NodeJS.ProcessEnv;
	readonly platform: NodeJS.Platform;
	readonly readFile: (path: string) => string | null;
	readonly exists: (path: string) => boolean;
	readonly openDb: (path: string) => OmpDb | null;
}

function defaultOpenDb(path: string): OmpDb | null {
	try {
		return new DatabaseSync(path, { readOnly: true });
	} catch {
		return null;
	}
}

function resolveInputs(inputs: OmpInputs): ResolvedOmpInputs {
	return {
		homeDir: inputs.homeDir,
		env: inputs.env,
		platform: inputs.platform ?? process.platform,
		readFile: inputs.readFile ?? defaultReadFile,
		exists: inputs.exists ?? ((path) => existsSync(path)),
		openDb: inputs.openDb ?? defaultOpenDb,
	};
}

function defaultReadFile(path: string): string | null {
	try {
		return existsSync(path) ? readFileSync(path, "utf8") : null;
	} catch {
		return null;
	}
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function positiveNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function parseModelsYaml(text: string): Record<string, unknown> | null {
	try {
		const value: unknown = parseYaml(text, { customTags: [COMMAND_TAG] });
		return isJsonObject(value) ? value : null;
	} catch {
		return null;
	}
}

function isCommandValue(value: unknown): value is OmpCommandValue {
	return isJsonObject(value) && typeof value.__ompCommand === "string";
}

/** Classify a models.yml `apiKey` without keeping its value. */
function classifyKey(value: unknown): { readonly kind: OmpKeyKind; readonly envName: string | null } {
	if (value === undefined || value === null) return { kind: "none", envName: null };
	if (isCommandValue(value)) return { kind: "command", envName: null };
	if (typeof value !== "string") return { kind: "none", envName: null };
	const text = value.trim();
	if (text.length === 0) return { kind: "none", envName: null };
	// pi and omp run any apiKey that starts with `!` as a shell command (`$!` escapes a literal `!`).
	if (text.startsWith("!")) return { kind: "command", envName: null };
	const braced = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(text);
	if (braced !== null && braced[1] !== undefined) return { kind: "env", envName: braced[1] };
	const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)$/u.exec(text);
	if (dollar !== null && dollar[1] !== undefined) return { kind: "env", envName: dollar[1] };
	// A bare identifier is omp's usual "read this env var" spelling.
	if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(text)) return { kind: "env", envName: text };
	return { kind: "literal", envName: null };
}

function parseModelInput(value: unknown): readonly ("text" | "image")[] {
	if (!Array.isArray(value)) return [];
	const out: ("text" | "image")[] = [];
	for (const item of value) {
		if (item === "text" || item === "image") out.push(item);
	}
	return out;
}

function parseModels(list: unknown): readonly OmpProviderModel[] {
	if (!Array.isArray(list)) return [];
	const out: OmpProviderModel[] = [];
	for (const entry of list) {
		if (!isJsonObject(entry)) continue;
		const id = nonEmptyString(entry.id);
		if (id === null) continue;
		const input = parseModelInput(entry.input);
		const contextWindow = positiveNumber(entry.contextWindow);
		const maxTokens = positiveNumber(entry.maxTokens);
		out.push({
			id,
			name: nonEmptyString(entry.name) ?? id,
			...(typeof entry.reasoning === "boolean" ? { reasoning: entry.reasoning } : {}),
			...(input.length > 0 ? { input } : {}),
			...(contextWindow === null ? {} : { contextWindow }),
			...(maxTokens === null ? {} : { maxTokens }),
		});
	}
	return out;
}

/**
 * Every custom provider in `~/.omp/agent/models.yml`, definitions only — no key value is ever included.
 * An unreadable or unparseable file yields an empty list.
 */
export function readOmpProviders(inputs: OmpInputs): readonly OmpProviderDefinition[] {
	const raw = resolveInputs(inputs);
	const text = raw.readFile(join(raw.homeDir, MODELS_FILE));
	if (text === null) return [];
	const doc = parseModelsYaml(text);
	if (doc === null || !isJsonObject(doc.providers)) return [];
	const out: OmpProviderDefinition[] = [];
	for (const [name, value] of Object.entries(doc.providers)) {
		if (!isJsonObject(value)) continue;
		const baseUrl = nonEmptyString(value.baseUrl);
		if (baseUrl === null) continue;
		const key = classifyKey(value.apiKey);
		out.push({
			name,
			api: nonEmptyString(value.api) ?? "",
			baseUrl,
			keyEnvName: key.envName,
			keyKind: key.kind,
			models: parseModels(value.models),
		});
	}
	return out;
}

/** `NAME=value`, `export NAME=value`, or fish's `set -gx NAME value`; the value is unquoted. */
function parseShellAssignment(text: string, name: string, fish: boolean): string | null {
	for (const raw of text.split(/\r?\n/u)) {
		const line = raw.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		const match = fish
			? /^set\s+(?:-[A-Za-z]+\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/u.exec(line)
			: /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/u.exec(line);
		if (match === null || match[1] !== name) continue;
		const value = unquote((match[2] ?? "").trim());
		if (value.length > 0) return value;
	}
	return null;
}

function unquote(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1);
	}
	return value;
}

/**
 * The value behind a provider's key — the ONE function that returns a secret for a models.yml reference.
 * An env reference is looked up in the process environment, then shell profiles, then `~/.omp/agent/.env`;
 * `from` is the source ("env" or a path) and never the value. A literal key comes from models.yml itself.
 * A `!command` key and a keyless provider return null (a command is not run here; `agent.db` may hold it).
 */
export function resolveOmpProviderKey(inputs: OmpInputs, def: OmpProviderDefinition): { value: string; from: string } | null {
	const raw = resolveInputs(inputs);
	if (def.keyKind === "env") {
		const name = def.keyEnvName;
		if (name === null) return null;
		const direct = nonEmptyString(raw.env[name]);
		if (direct !== null) return { value: direct, from: "env" };
		const profiles = raw.platform === "win32" ? PROFILE_FILES.filter((profile) => !profile.fish) : PROFILE_FILES;
		for (const profile of profiles) {
			const path = join(raw.homeDir, profile.path);
			const text = raw.readFile(path);
			if (text === null) continue;
			const value = parseShellAssignment(text, name, profile.fish);
			if (value !== null) return { value, from: path };
		}
		const envPath = join(raw.homeDir, ENV_FILE);
		const envText = raw.readFile(envPath);
		if (envText !== null) {
			const value = parseShellAssignment(envText, name, false);
			if (value !== null) return { value, from: envPath };
		}
		return null;
	}
	if (def.keyKind === "literal") {
		const path = join(raw.homeDir, MODELS_FILE);
		const text = raw.readFile(path);
		if (text === null) return null;
		const doc = parseModelsYaml(text);
		if (doc === null || !isJsonObject(doc.providers)) return null;
		const entry = doc.providers[def.name];
		if (!isJsonObject(entry)) return null;
		const value = nonEmptyString(entry.apiKey);
		return value === null ? null : { value, from: path };
	}
	return null;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "string") return null;
	try {
		const parsed: unknown = JSON.parse(value);
		return isJsonObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** Query `agent.db` read-only; a missing, locked, or malformed database yields no rows. */
function readCredentialRows(raw: ResolvedOmpInputs, sql: string): readonly Record<string, unknown>[] {
	const db = raw.openDb(join(raw.homeDir, DB_FILE));
	if (db === null) return [];
	try {
		const rows = db.prepare(sql).all();
		return rows.filter(isJsonObject);
	} catch {
		return [];
	} finally {
		try {
			db.close();
		} catch {
			// A close failure does not change what was already read.
		}
	}
}

const API_KEYS_SQL = "SELECT provider, data, disabled_cause FROM auth_credentials WHERE credential_type = 'api_key'";
const OAUTH_SQL = "SELECT provider, disabled_cause FROM auth_credentials WHERE credential_type = 'oauth'";

/**
 * The API keys omp resolved into `agent.db`. Disabled rows are kept but flagged, so a caller can skip
 * them. A missing or unreadable database yields an empty list rather than a throw.
 */
export function readOmpApiKeys(inputs: OmpInputs): readonly OmpApiKey[] {
	const raw = resolveInputs(inputs);
	const out: OmpApiKey[] = [];
	for (const row of readCredentialRows(raw, API_KEYS_SQL)) {
		const provider = nonEmptyString(row.provider);
		if (provider === null) continue;
		const data = parseJsonObject(row.data);
		const value = data === null ? null : nonEmptyString(data.key);
		if (value === null) continue;
		out.push({ provider, value, disabled: nonEmptyString(row.disabled_cause) !== null });
	}
	return out;
}

/** The providers omp signed in to with OAuth, flagged when disabled; never importable, only reported. */
export function listOmpOauth(inputs: OmpInputs): readonly OmpOauthEntry[] {
	const raw = resolveInputs(inputs);
	const out: OmpOauthEntry[] = [];
	for (const row of readCredentialRows(raw, OAUTH_SQL)) {
		const provider = nonEmptyString(row.provider);
		if (provider === null) continue;
		out.push({ provider, disabled: nonEmptyString(row.disabled_cause) !== null });
	}
	return out;
}
