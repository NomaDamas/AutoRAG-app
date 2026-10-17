import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject, type DataSourceIndexUnit } from "../shared/settings-contract";

/**
 * Datasources backed by an external CLI (discrawl, slacrawl, …) keep their own
 * archive; AutoRAG never sees their chunks. Every one of those CLIs can still
 * report what it holds, so the settings UI asks it instead of showing a
 * placeholder. Each probe is a read-only status command: it must never sync,
 * import, or otherwise change the archive.
 */

export interface BackendIndexReading {
	readonly count: number;
	/** Last sync/import time the backend reports, as an ISO string. */
	readonly at: string | null;
}

interface ProbeContext {
	readonly id: string;
	readonly connector: Readonly<Record<string, unknown>>;
	readonly instanceId: string;
	readonly workspacePath: string;
}

interface ProbeCommand {
	readonly args: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	/** False when running the CLI would create state instead of reading it. */
	readonly runnable?: boolean;
	/** What the archive holds when the command is not runnable. */
	readonly absent?: BackendIndexReading;
}

interface ProbeSpec {
	readonly unit: DataSourceIndexUnit;
	/** Template-specific env prefixes the CLI reads (its own config, never credentials of others). */
	readonly envPrefixes: readonly string[];
	readonly command: (context: ProbeContext) => ProbeCommand;
	readonly parse: (stdout: string, context: ProbeContext) => BackendIndexReading | undefined;
}

const PROBE_TIMEOUT_MS = 8000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const SAFE_ENV_KEYS = new Set([
	"HOME",
	"PATH",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"TMP",
	"TEMP",
	"NO_COLOR",
	"APPDATA",
	"LOCALAPPDATA",
	"USERPROFILE",
	"SystemRoot",
	"SystemDrive",
	"WINDIR",
	"PATHEXT",
	"ComSpec",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
]);

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** ISO string from a backend timestamp: ISO text, epoch seconds, or epoch milliseconds. `0` means "never". */
function isoTime(value: unknown): string | null {
	let millis: number;
	if (typeof value === "string") millis = Date.parse(value);
	else if (typeof value === "number" && value > 0) millis = value < 1e11 ? value * 1000 : value;
	else return null;
	return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function parseJson(stdout: string): Record<string, unknown> | undefined {
	const start = stdout.indexOf("{");
	if (start < 0) return undefined;
	try {
		const parsed: unknown = JSON.parse(stdout.slice(start));
		return isJsonObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Whether the kakao sidecar database holds an embedder identity and a stored vector. Any read problem means no. */
function sidecarHasVectors(path: string): boolean {
	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(path, { readOnly: true });
		const identity = db.prepare("select 1 from sidecar_meta where k = 'identity'").get();
		return identity !== undefined && db.prepare("select 1 from sidecar_vec limit 1").get() !== undefined;
	} catch {
		return false;
	} finally {
		db?.close();
	}
}

function reading(total: unknown, at: unknown): BackendIndexReading | undefined {
	const parsed = count(total);
	return parsed === undefined ? undefined : { count: parsed, at: isoTime(at) };
}

/** `--db` / `--source` style flags a connector option maps to, in the order the CLI expects. */
function optionFlags(connector: Readonly<Record<string, unknown>>, flags: Readonly<Record<string, string>>): string[] {
	const out: string[] = [];
	for (const [option, flag] of Object.entries(flags)) {
		const value = text(connector[option]);
		if (value !== undefined) out.push(flag, value);
	}
	return out;
}

const SPECS: Readonly<Record<string, ProbeSpec>> = {
	discord: {
		unit: "message",
		envPrefixes: ["DISCRAWL_"],
		command: ({ connector }) => ({ args: [...optionFlags(connector, { configPath: "--config" }), "--json", "status"] }),
		parse: (stdout) => {
			const status = parseJson(stdout);
			const counts = Array.isArray(status?.counts) ? status.counts : [];
			const messages = counts.find((entry) => isJsonObject(entry) && entry.id === "messages");
			return reading(isJsonObject(messages) ? messages.value : undefined, status?.last_sync_at);
		},
	},
	slack: {
		unit: "message",
		envPrefixes: ["SLACRAWL_"],
		command: ({ connector }) => ({ args: [...optionFlags(connector, { configPath: "--config" }), "--json", "status"] }),
		parse: (stdout) => {
			const status = parseJson(stdout);
			return reading(status?.messages, status?.last_sync_at);
		},
	},
	whatsapp: {
		unit: "message",
		envPrefixes: ["WACRAWL_"],
		// `--sync never`: the default policy imports from WhatsApp Desktop before answering.
		command: ({ connector }) => ({
			args: ["--json", "--sync", "never", ...optionFlags(connector, { databasePath: "--db", sourcePath: "--source" }), "status"],
		}),
		parse: (stdout) => {
			const status = parseJson(stdout);
			return reading(status?.messages, status?.last_import_at);
		},
	},
	telegram: {
		unit: "message",
		envPrefixes: ["TELECRAWL_"],
		command: ({ connector }) => ({
			args: ["--json", ...optionFlags(connector, { databasePath: "--db", sourcePath: "--source" }), "status"],
		}),
		parse: (stdout) => {
			const status = parseJson(stdout);
			return reading(status?.messages, status?.last_import_at);
		},
	},
	notion: {
		unit: "document",
		envPrefixes: ["NOTCRAWL_"],
		// notcrawl has no `--json` flag; `status` already prints a JSON object.
		command: ({ connector }) => ({ args: [...optionFlags(connector, { configPath: "--config" }), "status"] }),
		parse: (stdout) => {
			const status = parseJson(stdout);
			return reading(status?.pages, status?.last_sync_at);
		},
	},
	mailcrawl: {
		unit: "message",
		envPrefixes: ["MAILCRAWL_"],
		command: ({ connector }) => {
			const dataDir = text(connector.dataDir);
			return { args: ["status", "--json"], ...(dataDir === undefined ? {} : { env: { MAILCRAWL_DATA_DIR: dataDir } }) };
		},
		parse: (stdout) => {
			const status = parseJson(stdout);
			return status?.archivePresent === false ? { count: 0, at: null } : reading(status?.messageCount, null);
		},
	},
	kakao: {
		unit: "message",
		envPrefixes: ["LAZYKATOK_", "KATOK_"],
		// Global flags must precede the subcommand (clap).
		command: ({ connector }) => ({
			args: [...optionFlags(connector, { workspacePath: "--data-dir", configPath: "--config" }), "doctor", "--json"],
		}),
		parse: (stdout, context) => {
			const doctor = parseJson(stdout);
			const freshness = isJsonObject(doctor?.freshness) ? doctor.freshness : undefined;
			const lastSync = isJsonObject(freshness?.last_sync) ? freshness.last_sync : undefined;
			if (lastSync === undefined) return { count: 0, at: null };
			const sidecarPath = join(context.workspacePath, ".autorag", "datasources", context.id, context.instanceId, "sidecar.sqlite");
			if (existsSync(sidecarPath)) {
				// The sidecar file appears as soon as a sync starts, so a failed first sync leaves it
				// behind. It counts only once it holds an embedder identity and at least one vector
				// (or when the connector turned semantic search off, so it never will).
				const semanticOff = isJsonObject(context.connector.sidecar) && context.connector.sidecar.semantic === false;
				return semanticOff || sidecarHasVectors(sidecarPath) ? reading(lastSync.total_messages, lastSync.completed_at) : undefined;
			}
			// In CLI-only mode (`LazykatokSkill.index()` without a sidecar), `sync` runs
			// then `index`. When `last_index` is `null` or `recommendation.index_before_semantic_search`
			// is true (because `sync` ran and updated the archive revision, but `index`
			// failed or has not committed the matching semantic generation yet), report
			// `undefined` (`not-indexed`) rather than claiming a stale/partial archive is indexed.
			const recommendation = isJsonObject(freshness?.recommendation) ? freshness.recommendation : undefined;
			const lastIndex = isJsonObject(freshness?.last_index) ? freshness.last_index : undefined;
			if (freshness?.last_index === null || recommendation?.index_before_semantic_search === true) {
				return undefined;
			}
			return reading(lastSync.total_messages, lastIndex?.completed_at ?? lastSync.completed_at);
		},
	},
	clawgallery: {
		unit: "image",
		envPrefixes: ["CLAWGALLERY_"],
		command: ({ connector, id, workspacePath }) => ({
			args: ["status"],
			env: { CLAWGALLERY_CONFIG_DIR: text(connector.configDir) ?? join(workspacePath, ".autorag", "datasources", "clawgallery", id) },
		}),
		parse: (stdout) => {
			const match = /^images:\s*(\d+)\s*$/mu.exec(stdout);
			return match?.[1] === undefined ? undefined : { count: Number(match[1]), at: null };
		},
	},
	obsidian: {
		unit: "document",
		envPrefixes: ["QMD_"],
		command: ({ connector, instanceId, workspacePath }) => {
			// Same isolated layout the librarian's Obsidian skill points qmd at.
			const root = join(workspacePath, ".autorag", "datasources", "obsidian", instanceId);
			const cache = join(root, "cache");
			return {
				args: ["status"],
				env: {
					QMD_CONFIG_DIR: text(connector.configPath) ?? join(root, "config"),
					XDG_CACHE_HOME: cache,
					QMD_TRUST_LOCAL_CONFIG: "1",
				},
				// `qmd status` creates an empty index when none exists; do not leave one behind.
				runnable: existsSync(join(cache, "qmd", "index.sqlite")),
				absent: { count: 0, at: null },
			};
		},
		parse: (stdout) => {
			const match = /Total:\s*([\d,]+)\s+files indexed/u.exec(stdout);
			return match?.[1] === undefined ? undefined : { count: Number(match[1].replaceAll(",", "")), at: null };
		},
	},
};

/** Templates that have no countable index: the backend answers each query live. */
export const LIVE_QUERY_TEMPLATES: ReadonlySet<string> = new Set(["lark"]);

/** Templates whose backend CLI can report a count through {@link probeBackendIndex}. */
export function hasBackendProbe(type: string): boolean {
	return SPECS[type] !== undefined;
}

export function backendIndexUnit(type: string): DataSourceIndexUnit | null {
	return SPECS[type]?.unit ?? null;
}

function probeEnv(env: NodeJS.ProcessEnv, prefixes: readonly string[], extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (SAFE_ENV_KEYS.has(key) || prefixes.some((prefix) => key.startsWith(prefix))) out[key] = value;
	}
	return { ...out, ...extra };
}

/**
 * One probe per binary at a time. `sourcesList` is called from several places
 * at once, and some CLIs (wacrawl's status backfills rows) take a write lock,
 * so overlapping runs fail with SQLITE_BUSY and would read as "unreadable".
 */
const lanes = new Map<string, Promise<unknown>>();

function run(binary: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string | null> {
	const exec = (): Promise<string | null> => {
		const { promise, resolve } = Promise.withResolvers<string | null>();
		try {
			execFile(
				binary,
				[...args],
				{ env, timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES, windowsHide: true, encoding: "utf8" },
				(error, stdout) => resolve(error === null ? stdout : null),
			);
		} catch {
			// spawn throws synchronously for errors such as ENOEXEC; a probe must never break the list.
			resolve(null);
		}
		return promise;
	};
	const turn = (lanes.get(binary) ?? Promise.resolve()).then(exec);
	const settled = turn.finally(() => {
		if (lanes.get(binary) === settled) lanes.delete(binary);
	});
	lanes.set(binary, settled);
	return turn;
}

/**
 * Ask the backend CLI what it holds. `null` means the CLI could not be read
 * (missing, failed, timed out, or printed something unrecognisable) — callers
 * must not present that as "empty".
 */
export async function probeBackendIndex(
	type: string,
	context: ProbeContext,
	binary: string,
	env: NodeJS.ProcessEnv,
): Promise<BackendIndexReading | null> {
	const spec = SPECS[type];
	if (spec === undefined) return null;
	const command = spec.command(context);
	if (command.runnable === false) return command.absent ?? null;
	const stdout = await run(binary, command.args, probeEnv(env, spec.envPrefixes, command.env));
	if (stdout === null) return null;
	return spec.parse(stdout, context) ?? null;
}

export type { ProbeContext as BackendProbeContext };
