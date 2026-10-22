import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { delimiter, extname, join } from "node:path";
import {
	BUILTIN_DATASOURCE_SKILL_NAMES,
	buildDatasourceSkills,
	type DatasourceDiagnostic,
	type DatasourceIndexResult,
	type DatasourceSkill,
	type DatasourceSkillConfig,
	datasourceChunkStorePath,
	HisterClient,
	loadMirrorIndex,
	resolveConfigReadOnly,
	writeConfigObject,
} from "@autorag/librarian";
import { readRawConfigObject, resolveConfigPath, type CliConfig } from "@autorag/librarian/core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { calendarSupported, isCalendarDatasourceType } from "../shared/calendar-platform";
import { calendarMcpServerName, syncCalendarMcpConfig } from "./calendar-mcp";
import { backendIndexUnit, LIVE_QUERY_TEMPLATES, probeBackendIndex } from "./datasource-index-probe";
import { readAppIndexing } from "./app-indexing";
import { withConnectorOcrDisabled } from "./indexing-policy";
import { runWithoutSemanticIndexing, withSemanticPolicyApplied } from "./semantic-policy";
import { datasourceFailureReport, reportError } from "./error-report-core";
import { ensureEmbeddingForConfig, localEmbeddingServer } from "./embedding-daemon";
import { datasourceEmbeddingFor, resolveEmbeddingEndpoint } from "./embedding-endpoint";
import type {
	ConfigRefreshDiagnostic,
	DataSourceAppRequirement,
	DataSourceRow,
	DataSourcesSnapshot,
	DataSourceSyncResult,
} from "../shared/settings-contract";
import { isJsonObject } from "../shared/settings-contract";

/**
 * Settings > Data Sources reads the shared AutoRAG config — the same file the
 * CLI, TUI, serve, and every app agent resolve — on each call, and judges agent
 * reachability with the librarian's own skill factory. The
 * app never keeps a copy, so an edit from any AutoRAG surface shows up here and
 * a toggle here reaches every agent.
 */
export interface DataSourceStatusService {
	list(): Promise<DataSourcesSnapshot>;
	setEnabled(id: string, enabled: boolean): Promise<void>;
	/** Blank text removes the override so the built-in description applies again. */
	setDescription(id: string, description: string): Promise<void>;
	/**
	 * Index/refresh one configured source through its own librarian skill (the
	 * same CLI pipeline an AutoRAG refresh runs) and report the real outcome.
	 * Concurrent calls for one id share a single in-flight run.
	 */
	sync(id: string): Promise<DataSourceSyncResult>;
}

export interface DataSourceStatusDeps {
	readonly env: NodeJS.ProcessEnv;
	readonly cwd: string;
	/** The host OS; Calendar is only offered on macOS. Defaults to this process. */
	readonly platform?: NodeJS.Platform;
}

/** Backend CLI each built-in template shells out to (mirrors the librarian's `autorag setup` probe). */
const BACKEND_BINARIES: Readonly<Record<string, string>> = {
	kakao: "lazykatok",
	lark: "lark-cli",
	whatsapp: "wacrawl",
	telegram: "telecrawl",
	slack: "slacrawl",
	discord: "discrawl",
	notion: "notcrawl",
	mailcrawl: "mailcrawl",
	"cloud-drive": "rclone",
	obsidian: "qmd",
	clawgallery: "clawgallery",
	spotlight: "mdfind",
	hister: "hister",
};

/** Templates whose chunks AutoRAG itself persists under `.autorag/datasources/<id>/<instance>/chunks.json`. */
const CHUNK_STORE_TEMPLATES = new Set(["cloud-drive", "mail-export", "spotlight", "rss", "github", "github-gist"]);

/**
 * Desktop source app each template reads from, detected separately from the
 * CLI. A datasource can have its CLI installed but no app to import yet (or the
 * reverse); the renderer owns the official download URLs.
 */
const DESKTOP_APPS: Readonly<Record<string, string>> = {
	slack: "Slack",
	discord: "Discord",
	kakao: "KakaoTalk",
	whatsapp: "WhatsApp",
	telegram: "Telegram",
	notion: "Notion",
	obsidian: "Obsidian",
};

/** macOS-only bundle probe; other platforms report `installed: null` rather than a wrong "missing". */
async function desktopAppRequirement(type: string, env: NodeJS.ProcessEnv): Promise<DataSourceAppRequirement> {
	const name = DESKTOP_APPS[type];
	if (name === undefined) return { required: false, installed: null, name: "" };
	if (process.platform !== "darwin") return { required: true, installed: null, name };
	const home = env.HOME ?? "";
	const candidates = [`/Applications/${name}.app`, home.length === 0 ? "" : join(home, "Applications", `${name}.app`)];
	const present = await Promise.all(candidates.map((candidate) => (candidate.length > 0 ? stat(candidate).then(() => true, () => false) : false)));
	return { required: true, installed: present.some(Boolean), name };
}

const DEFAULT_TOKEN_ENV = "GITHUB_TOKEN";

/**
 * Executable suffixes for CLI lookup. POSIX tries the name itself; Windows
 * appends PATHEXT unless the name already has a runnable extension. Never try
 * an extensionless npm/bun POSIX shim as a Windows executable.
 */
function executableExtensions(name: string, env: NodeJS.ProcessEnv): readonly string[] {
	const pathext = env.PATHEXT;
	if (pathext === undefined || pathext.length === 0) return [""];
	const extensions = pathext.split(";").map((extension) => extension.trim()).filter((extension) => extension.length > 0);
	const explicitExtension = extname(name).toLowerCase();
	return extensions.some((extension) => extension.toLowerCase() === explicitExtension) ? ["", ...extensions] : extensions;
}

/** `access(X_OK)` on Windows only proves existence, so a directory would pass too. */
async function isExecutableFile(candidate: string): Promise<boolean> {
	try {
		await access(candidate, constants.X_OK);
		return (await stat(candidate)).isFile();
	} catch {
		return false;
	}
}

async function findExecutable(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
	if (name.includes("/") || name.includes("\\")) {
		return (await isExecutableFile(name)) ? name : null;
	}
	const extensions = executableExtensions(name, env);
	const directories = (env.PATH ?? "").split(delimiter).filter(Boolean);
	for (const directory of directories) {
		for (const extension of extensions) {
			const candidate = join(directory, `${name}${extension}`);
			if (await isExecutableFile(candidate)) return candidate;
		}
	}
	return null;
}

const CALENDAR_UNSUPPORTED = "Apple Calendar & Reminders need macOS (EventKit)";

async function installState(type: string, entry: DatasourceSkillConfig, env: NodeJS.ProcessEnv, platform: string): Promise<DataSourceRow["install"]> {
	const app = await desktopAppRequirement(type, env);
	if (isCalendarDatasourceType(type)) {
		if (!calendarSupported(platform)) return { state: "unsupported", binary: null, path: null, detail: CALENDAR_UNSUPPORTED, app };
		const connector = isJsonObject(entry.connector) ? entry.connector : {};
		const configured = typeof connector.command === "string" && connector.command.trim().length > 0 ? connector.command.trim() : "npx";
		const path = await findExecutable(configured, env);
		return path === null
			? { state: "missing", binary: configured, path: null, detail: `${configured} was not found on PATH`, app }
			: { state: "installed", binary: configured, path, detail: `${configured} at ${path}`, app };
	}
	if (!BUILTIN_DATASOURCE_SKILL_NAMES.includes(type)) {
		return { state: "unsupported", binary: null, path: null, detail: `No built-in Dazzi datasource named "${type}"`, app };
	}
	const connector = isJsonObject(entry.connector) ? entry.connector : {};
	if (type === "github" || type === "github-gist") {
		const tokenEnv = typeof connector.tokenEnv === "string" ? connector.tokenEnv : DEFAULT_TOKEN_ENV;
		const hasToken = typeof connector.token === "string" || Boolean(env[tokenEnv]);
		const gh = type === "github-gist" ? await findExecutable("gh", env) : null;
		return hasToken || gh !== null
			? { state: "builtin", binary: null, path: gh, detail: hasToken ? `Token from ${tokenEnv}` : "Token from gh auth", app }
			: { state: "credential-missing", binary: null, path: null, detail: `Set ${tokenEnv} to let Dazzi reach GitHub`, app };
	}
	if (type === "hister") {
		const tokenEnv = typeof connector.tokenEnv === "string" && connector.tokenEnv.trim().length > 0 ? connector.tokenEnv.trim() : undefined;
		if (tokenEnv !== undefined && !env[tokenEnv]) {
			return { state: "credential-missing", binary: "hister", path: null, detail: `Set ${tokenEnv} to let Dazzi reach Hister`, app };
		}
		const configured = typeof connector.binaryPath === "string" ? connector.binaryPath : "hister";
		const path = await findExecutable(configured, env);
		if (path !== null) {
			return { state: "installed", binary: "hister", path, detail: `hister at ${path}`, app };
		}
		if (typeof connector.baseUrl === "string" && connector.baseUrl.trim().length > 0) {
			try {
				const client = new HisterClient({
					baseUrl: connector.baseUrl,
					...(tokenEnv === undefined ? {} : { tokenEnv }),
					timeoutMs: 2_000,
					env,
				});
				const cfg = await client.config();
				if (cfg.ok) {
					return { state: "installed", binary: "hister", path: connector.baseUrl, detail: `hister server at ${connector.baseUrl}`, app };
				}
			} catch {
				// Fall through to missing binary report.
			}
		}
		return { state: "missing", binary: "hister", path: null, detail: `${configured} was not found on PATH`, app };
	}
	const binary = BACKEND_BINARIES[type];
	if (binary === undefined) return { state: "builtin", binary: null, path: null, detail: "Built into Dazzi", app };
	const configured = typeof connector.binaryPath === "string" ? connector.binaryPath : binary;
	const path = await findExecutable(configured, env);
	return path === null
		? { state: "missing", binary, path: null, detail: `${configured} was not found on PATH`, app }
		: { state: "installed", binary, path, detail: `${binary} at ${path}`, app };
}

/** Build the librarian skill for one entry; disabled entries are built as if enabled to learn their descriptor. */
function buildSkill(
	id: string,
	entry: DatasourceSkillConfig,
	workspacePath: string,
	embedding?: ReturnType<typeof datasourceEmbeddingFor>,
): DatasourceSkill | undefined {
	return buildDatasourceSkills({ [id]: withConnectorOcrDisabled({ ...entry, enabled: true }) }, workspacePath, embedding).skills[0];
}

function agentState(id: string, type: string, skill: DatasourceSkill | undefined, enabled: boolean, platform: string): DataSourceRow["agent"] {
	if (isCalendarDatasourceType(type)) {
		if (!calendarSupported(platform)) return { state: "unsupported", skillName: null, tags: [], detail: CALENDAR_UNSUPPORTED };
		const skillName = `mcp-${calendarMcpServerName(id)}`;
		const tags = ["calendar", "reminders", "mcp"];
		if (!enabled) return { state: "disabled", skillName, tags, detail: "Turned off in the Dazzi config" };
		return { state: "connected", skillName, tags, detail: `Agents load ${skillName}` };
	}
	if (skill === undefined) {
		return { state: "unsupported", skillName: null, tags: [], detail: "The Dazzi agent skips unknown datasources" };
	}
	const descriptor = skill.describe();
	const skillName = skill.skillManifest().name;
	if (!enabled) return { state: "disabled", skillName, tags: descriptor.tags, detail: "Turned off in the Dazzi config" };
	return { state: "connected", skillName, tags: descriptor.tags, detail: `Agents load ${skillName}` };
}

/** Count what a backend-owned archive holds by asking its own CLI (read-only status command). */
async function backendIndexState(
	id: string,
	type: string,
	entry: DatasourceSkillConfig,
	install: DataSourceRow["install"],
	workspacePath: string,
	env: NodeJS.ProcessEnv,
): Promise<DataSourceRow["index"]> {
	const unit = backendIndexUnit(type);
	if (install.state !== "installed" || install.path === null) {
		return { state: "not-indexed", chunkCount: null, unit, indexedAt: null, detail: install.detail };
	}
	const binary = BACKEND_BINARIES[type] ?? type;
	const reading = await probeBackendIndex(
		type,
		{
			id,
			connector: isJsonObject(entry.connector) ? entry.connector : {},
			instanceId: entry.instanceId ?? "default",
			workspacePath,
		},
		install.path,
		env,
	);
	if (reading === null) {
		return { state: "not-indexed", chunkCount: null, unit, indexedAt: null, detail: `Could not read ${binary} status` };
	}
	return reading.count === 0
		? { state: "empty", chunkCount: 0, unit, indexedAt: reading.at, detail: `${binary} holds nothing yet` }
		: { state: "indexed", chunkCount: reading.count, unit, indexedAt: reading.at, detail: `${reading.count} items in ${binary}` };
}

async function indexState(
	id: string,
	type: string,
	entry: DatasourceSkillConfig,
	skill: DatasourceSkill | undefined,
	install: DataSourceRow["install"],
	workspacePath: string,
	env: NodeJS.ProcessEnv,
): Promise<DataSourceRow["index"]> {
	if (isCalendarDatasourceType(type)) {
		if (install.state === "unsupported") return { state: "not-indexed", chunkCount: null, unit: null, indexedAt: null, detail: install.detail };
		return { state: "live", chunkCount: null, unit: null, indexedAt: null, detail: "Queried live through EventKit MCP" };
	}
	if (skill === undefined) return { state: "not-indexed", chunkCount: null, unit: null, indexedAt: null, detail: "Not indexed" };
	if (LIVE_QUERY_TEMPLATES.has(type)) {
		return { state: "live", chunkCount: null, unit: null, indexedAt: null, detail: "Searched live through its own CLI" };
	}
	if (type === "hister") {
		if (install.state === "missing" || install.state === "credential-missing") {
			return { state: "not-indexed", chunkCount: null, unit: "document", indexedAt: null, detail: install.detail };
		}
		const connector = isJsonObject(entry.connector) ? entry.connector : {};
		try {
			const client = new HisterClient({
				...(typeof connector.baseUrl === "string" ? { baseUrl: connector.baseUrl } : {}),
				...(typeof connector.tokenEnv === "string" ? { tokenEnv: connector.tokenEnv } : {}),
				timeoutMs: 3_000,
				env,
			});
			const cfg = await client.config();
			if (!cfg.ok || cfg.value.authenticated === false) {
				return {
					state: "not-indexed",
					chunkCount: null,
					unit: "document",
					indexedAt: null,
					detail: cfg.ok ? "Hister requires authentication" : cfg.message,
				};
			}
			const count = await client.count("type:web");
			if (!count.ok) {
				return { state: "not-indexed", chunkCount: null, unit: "document", indexedAt: null, detail: count.message };
			}
			return count.value === 0
				? { state: "empty", chunkCount: 0, unit: "document", indexedAt: null, detail: "hister holds nothing yet" }
				: { state: "indexed", chunkCount: count.value, unit: "document", indexedAt: null, detail: `${count.value} items in hister` };
		} catch (error) {
			return {
				state: "not-indexed",
				chunkCount: null,
				unit: "document",
				indexedAt: null,
				detail: error instanceof Error ? error.message : String(error),
			};
		}
	}
	if (!CHUNK_STORE_TEMPLATES.has(type)) return backendIndexState(id, type, entry, install, workspacePath, env);
	const descriptor = skill.describe();
	const storePath = datasourceChunkStorePath(workspacePath, descriptor.name, descriptor.instanceId ?? "default");
	try {
		const parsed: unknown = JSON.parse(await readFile(storePath, "utf8"));
		const chunks = isJsonObject(parsed) && Array.isArray(parsed.chunks) ? parsed.chunks.length : 0;
		const indexedAt = isJsonObject(parsed) && typeof parsed.updatedAt === "number" ? new Date(parsed.updatedAt).toISOString() : null;
		return chunks === 0
			? { state: "empty", chunkCount: 0, unit: "document", indexedAt, detail: "The last refresh found nothing to index" }
			: { state: "indexed", chunkCount: chunks, unit: "document", indexedAt, detail: `${chunks} chunks` };
	} catch {
		return { state: "not-indexed", chunkCount: null, unit: "document", indexedAt: null, detail: "Run `autorag refresh` to index it" };
	}
}

/** Documents the last local-folder refresh parsed into the shared workspace mirror. */
function localIndexState(workspacePath: string): DataSourcesSnapshot["local"] {
	try {
		const entries = Object.values(loadMirrorIndex(workspacePath).entries);
		const updatedAt = entries.map((entry) => entry.updatedAt).sort().at(-1) ?? null;
		return { documentCount: entries.length, updatedAt };
	} catch {
		return { documentCount: null, updatedAt: null };
	}
}

function processAlive(pid: unknown): boolean {
	if (typeof pid !== "number") return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function refreshState(workspacePath: string): Promise<DataSourcesSnapshot["refresh"]> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(workspacePath, ".autorag", "refresh-progress.json"), "utf8"));
		if (!isJsonObject(parsed)) return { state: "idle", phase: null, finishedAt: null };
		const phase = typeof parsed.phase === "string" ? parsed.phase : null;
		const finishedAt = typeof parsed.finishedAt === "string" ? parsed.finishedAt : null;
		if (parsed.state === "running") {
			return processAlive(parsed.pid) ? { state: "running", phase, finishedAt } : { state: "failed", phase, finishedAt };
		}
		return parsed.state === "success" || parsed.state === "failed"
			? { state: parsed.state, phase, finishedAt }
			: { state: "idle", phase, finishedAt };
	} catch {
		return { state: "idle", phase: null, finishedAt: null };
	}
}

function overallStatus(
	row: Pick<DataSourceRow, "enabled" | "install" | "agent">,
	refresh: DataSourcesSnapshot["refresh"],
): DataSourceRow["status"] {
	if (!row.enabled) return "paused";
	if (row.agent.state !== "connected" || row.install.state === "missing" || row.install.state === "credential-missing") {
		return "attention";
	}
	return refresh.state === "running" && refresh.phase === "datasources" ? "syncing" : "ready";
}

function toDiagnostic(diagnostic: DatasourceDiagnostic): ConfigRefreshDiagnostic {
	return { code: String(diagnostic.code), severity: diagnostic.severity, message: diagnostic.message };
}

export function createDataSourceStatusService(deps: DataSourceStatusDeps): DataSourceStatusService {
	const platform = deps.platform ?? process.platform;
	const configPath = (): string => resolveConfigPath({ flags: {}, env: deps.env, cwd: deps.cwd }).configPath;
	const updateEntry = (id: string, update: (entry: unknown) => unknown): void => {
		const path = configPath();
		const raw = readRawConfigObject(path);
		const previous = structuredClone(raw);
		const datasources = raw.datasources;
		if (!isJsonObject(datasources) || !Object.hasOwn(datasources, id)) throw new Error(`Unknown datasource: ${id}`);
		datasources[id] = update(datasources[id]);
		writeConfigObject(path, raw);
		syncCalendarMcpConfig(raw, previous, deps.env.PI_CODING_AGENT_DIR ?? getAgentDir(), platform);
	};

	const listSnapshot = async (): Promise<DataSourcesSnapshot> => {
		const path = configPath();
		const empty: DataSourcesSnapshot = {
			configPath: path,
			configExists: await stat(path).then(() => true, () => false),
			error: null,
			refresh: { state: "idle", phase: null, finishedAt: null },
			local: { documentCount: null, updatedAt: null },
			sources: [],
		};
		if (!empty.configExists) return empty;
		let config: CliConfig;
		try {
			config = resolveConfigReadOnly({ flags: {}, env: deps.env, cwd: deps.cwd });
		} catch (error) {
			return { ...empty, error: error instanceof Error ? error.message : String(error) };
		}
		const refresh = await refreshState(config.workspacePath);
		const sources = await Promise.all(
			Object.entries(config.datasources ?? {}).map(async ([id, raw]): Promise<DataSourceRow> => {
				const entry: DatasourceSkillConfig = isJsonObject(raw) ? raw : {};
				const enabled = raw !== false && entry.enabled !== false;
				const type = entry.type ?? id;
				const skill = BUILTIN_DATASOURCE_SKILL_NAMES.includes(type) ? buildSkill(id, entry, config.workspacePath) : undefined;
				const install = await installState(type, entry, deps.env, platform);
				const index = await indexState(id, type, entry, skill, install, config.workspacePath, deps.env);
				const agent = agentState(id, type, skill, enabled, platform);
				return {
					id,
					type,
					description: entry.description ?? skill?.describe().description ?? (isCalendarDatasourceType(type) ? "Apple Calendar and Reminders via EventKit MCP" : type),
					enabled,
					status: overallStatus({ enabled, install, agent }, refresh),
					install,
					agent,
					index,
				};
			}),
		);
		return { ...empty, refresh, local: localIndexState(config.workspacePath), sources };
	};

	const inFlight = new Map<string, Promise<DataSourceSyncResult>>();

	const runSync = async (id: string): Promise<DataSourceSyncResult> => {
		const startedAt = Date.now();
		const base: DataSourceSyncResult = {
			id,
			ok: false,
			state: "not-configured",
			chunkCount: null,
			indexedAt: null,
			durationMs: 0,
			diagnostics: [],
			error: null,
		};
		const path = configPath();
		if (!(await stat(path).then(() => true, () => false))) return { ...base, error: "AutoRAG config not found" };
		let config: CliConfig;
		try {
			config = resolveConfigReadOnly({ flags: {}, env: deps.env, cwd: deps.cwd });
		} catch (error) {
			return { ...base, error: error instanceof Error ? error.message : String(error) };
		}
		// Keyword-only mode applies to this path too: it builds its own skill, outside the refresh the policy wraps.
		const semantic = readAppIndexing(readRawConfigObject(path)).semanticSearch;
		const rawEntry: unknown = withSemanticPolicyApplied(config, semantic).datasources?.[id];
		if (rawEntry === undefined) return { ...base, error: `Unknown datasource: ${id}` };
		const entry: DatasourceSkillConfig = isJsonObject(rawEntry) ? rawEntry : {};
		if (rawEntry === false || entry.enabled === false) {
			return { ...base, error: "This datasource is turned off" };
		}
		const type = entry.type ?? id;
		if (!BUILTIN_DATASOURCE_SKILL_NAMES.includes(type) && !isCalendarDatasourceType(type)) {
			return { ...base, state: "unsupported", error: `No built-in Dazzi datasource named "${type}"` };
		}
		const install = await installState(type, entry, deps.env, platform);
		if (install.state === "unsupported") {
			return { ...base, state: "unsupported", error: install.detail, durationMs: Date.now() - startedAt };
		}
		if (install.state === "missing" || install.state === "credential-missing") {
			return { ...base, state: "unavailable", error: install.detail, durationMs: Date.now() - startedAt };
		}
		if (isCalendarDatasourceType(type)) {
			const raw = readRawConfigObject(path);
			syncCalendarMcpConfig(raw, raw, deps.env.PI_CODING_AGENT_DIR ?? getAgentDir(), platform);
			return {
				id,
				ok: true,
				state: "indexed",
				chunkCount: 0,
				indexedAt: new Date().toISOString(),
				durationMs: Date.now() - startedAt,
				diagnostics: [],
				error: null,
			};
		}
		// Only a sync that ran and failed is a bug to report; a missing install, credential or config is the user's to fix.
		const failed = (error: string, diagnostics: readonly ConfigRefreshDiagnostic[] = []): DataSourceSyncResult => {
			const durationMs = Date.now() - startedAt;
			reportError(datasourceFailureReport(type, error, durationMs));
			return { ...base, state: "failed", durationMs, diagnostics, error };
		};
		let skill: DatasourceSkill | undefined;
		try {
			// A datasource that embeds needs the local embedding server up before it indexes; every embed
			// call then finds the one endpoint the config selects (the server, or the one the user configured).
			const raw = readRawConfigObject(path);
			if (semantic) await ensureEmbeddingForConfig(raw);
			skill = buildSkill(
				id,
				entry,
				config.workspacePath,
				semantic ? datasourceEmbeddingFor(() => resolveEmbeddingEndpoint(readRawConfigObject(path), { local: localEmbeddingServer }), { env: deps.env }) : undefined,
			);
		} catch (error) {
			return failed(error instanceof Error ? error.message : String(error));
		}
		if (skill === undefined) {
			return { ...base, state: "unsupported", error: `No built-in Dazzi datasource named "${type}"` };
		}
		let result: DatasourceIndexResult;
		try {
			const indexing = skill;
			result = await (semantic ? indexing.index() : runWithoutSemanticIndexing(() => indexing.index()));
		} catch (error) {
			return failed(error instanceof Error ? error.message : String(error));
		}
		const diagnostics = result.diagnostics.map(toDiagnostic);
		const durationMs = Date.now() - startedAt;
		if (result.ok) {
			return {
				id,
				ok: true,
				state: result.chunkCount > 0 ? "indexed" : "empty",
				chunkCount: result.chunkCount,
				indexedAt: new Date(result.indexedAt).toISOString(),
				durationMs,
				diagnostics,
				error: null,
			};
		}
		return failed(result.error ?? result.message ?? "The datasource CLI reported a failure", diagnostics);
	};

	return {
		list: listSnapshot,
		sync: (id) => {
			const existing = inFlight.get(id);
			if (existing !== undefined) return existing;
			const run = runSync(id).finally(() => inFlight.delete(id));
			inFlight.set(id, run);
			return run;
		},
		setEnabled: async (id, enabled) => {
			updateEntry(id, (entry) => (isJsonObject(entry) ? { ...entry, enabled } : enabled));
		},
		setDescription: async (id, description) => {
			const text = description.trim();
			updateEntry(id, (entry) => {
				const { description: _previous, ...rest } = isJsonObject(entry) ? entry : entry === false ? { enabled: false } : {};
				return text.length === 0 ? rest : { ...rest, description: text };
			});
		},
	};
}
