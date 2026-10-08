import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, extname, join } from "node:path";
import {
	BUILTIN_DATASOURCE_SKILL_NAMES,
	buildDatasourceSkills,
	DatasourceAccessContext,
	type DatasourceDiagnostic,
	type DatasourceIndexResult,
	type DatasourceSkill,
	type DatasourceSkillConfig,
	datasourceChunkStorePath,
	resolveConfigReadOnly,
	writeConfigObject,
} from "@autorag/librarian";
import { readRawConfigObject, resolveConfigPath, type CliConfig } from "@autorag/librarian/core";
import type { DiscrawlEmbeddingRuntime } from "./embedding-settings-service";
import type {
	ConfigRefreshDiagnostic,
	DataSourceAppRequirement,
	DataSourceRow,
	DataSourcesSnapshot,
	DataSourceSyncResult,
} from "../shared/settings-contract";

/**
 * Settings > Data Sources reads the shared AutoRAG config — the same file the
 * CLI, TUI, serve, and every app agent resolve — on each call, and judges agent
 * reachability with the librarian's own skill factory and access context. The
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
	/**
	 * Grant or revoke agent access for one source by editing
	 * `datasourceAccess.allowedTags` only when no other configured source sharing
	 * its tags changes accessibility. Refuses (throws) rather than silently
	 * granting or revoking a different source.
	 */
	setAccess(id: string, allowed: boolean): Promise<void>;
}

export interface DataSourceStatusDeps {
	readonly env: NodeJS.ProcessEnv;
	readonly cwd: string;
	/**
	 * The discrawl embedding runtime the app should hand its skill so an index
	 * run rewrites the managed config and rebuilds embeddings. `undefined` when
	 * the selected global embedder cannot be served over loopback.
	 */
	readonly discrawlEmbeddingRuntime?: () => DiscrawlEmbeddingRuntime | undefined;
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
function desktopAppRequirement(type: string, env: NodeJS.ProcessEnv): DataSourceAppRequirement {
	const name = DESKTOP_APPS[type];
	if (name === undefined) return { required: false, installed: null, name: "" };
	if (process.platform !== "darwin") return { required: true, installed: null, name };
	const home = env.HOME ?? "";
	const candidates = [`/Applications/${name}.app`, home.length === 0 ? "" : join(home, "Applications", `${name}.app`)];
	return { required: true, installed: candidates.some((candidate) => candidate.length > 0 && existsSync(candidate)), name };
}

const DEFAULT_TOKEN_ENV = "GITHUB_TOKEN";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

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

/** `accessSync(X_OK)` on Windows only proves existence, so a directory would pass too. */
function isExecutableFile(candidate: string): boolean {
	try {
		accessSync(candidate, constants.X_OK);
		return statSync(candidate).isFile();
	} catch {
		return false;
	}
}

function findExecutable(name: string, env: NodeJS.ProcessEnv): string | null {
	if (name.includes("/") || name.includes("\\")) {
		return isExecutableFile(name) ? name : null;
	}
	const extensions = executableExtensions(name, env);
	const directories = (env.PATH ?? "").split(delimiter).filter(Boolean);
	for (const directory of directories) {
		for (const extension of extensions) {
			const candidate = join(directory, `${name}${extension}`);
			if (isExecutableFile(candidate)) return candidate;
		}
	}
	return null;
}

function installState(type: string, entry: DatasourceSkillConfig, env: NodeJS.ProcessEnv): DataSourceRow["install"] {
	const app = desktopAppRequirement(type, env);
	if (!BUILTIN_DATASOURCE_SKILL_NAMES.includes(type)) {
		return { state: "unsupported", binary: null, path: null, detail: `No built-in AutoRAG datasource named "${type}"`, app };
	}
	const connector = isRecord(entry.connector) ? entry.connector : {};
	if (type === "github" || type === "github-gist") {
		const tokenEnv = typeof connector.tokenEnv === "string" ? connector.tokenEnv : DEFAULT_TOKEN_ENV;
		const hasToken = typeof connector.token === "string" || Boolean(env[tokenEnv]);
		const gh = type === "github-gist" ? findExecutable("gh", env) : null;
		return hasToken || gh !== null
			? { state: "builtin", binary: null, path: gh, detail: hasToken ? `Token from ${tokenEnv}` : "Token from gh auth", app }
			: { state: "credential-missing", binary: null, path: null, detail: `Set ${tokenEnv} to let AutoRAG reach GitHub`, app };
	}
	const binary = BACKEND_BINARIES[type];
	if (binary === undefined) return { state: "builtin", binary: null, path: null, detail: "Built into AutoRAG", app };
	const configured = typeof connector.binaryPath === "string" ? connector.binaryPath : binary;
	const path = findExecutable(configured, env);
	return path === null
		? { state: "missing", binary, path: null, detail: `${configured} was not found on PATH`, app }
		: { state: "installed", binary, path, detail: `${binary} at ${path}`, app };
}

/** Build the librarian skill for one entry; disabled entries are built as if enabled to learn their descriptor. */
function buildSkill(
	id: string,
	entry: DatasourceSkillConfig,
	workspacePath: string,
	embeddingRuntime?: DiscrawlEmbeddingRuntime,
): DatasourceSkill | undefined {
	return buildDatasourceSkills({ [id]: { ...entry, enabled: true } }, workspacePath, embeddingRuntime).skills[0];
}

function agentState(
	skill: DatasourceSkill | undefined,
	enabled: boolean,
	access: DatasourceAccessContext,
	allowedTags: readonly string[],
): DataSourceRow["agent"] {
	if (skill === undefined) {
		return { state: "unsupported", skillName: null, tags: [], detail: "The AutoRAG agent skips unknown datasources" };
	}
	const descriptor = skill.describe();
	const skillName = skill.skillManifest().name;
	if (!enabled) return { state: "disabled", skillName, tags: descriptor.tags, detail: "Turned off in the AutoRAG config" };
	if (!access.isAccessible(descriptor)) {
		return {
			state: "blocked",
			skillName,
			tags: descriptor.tags,
			detail: allowedTags.length === 0
				? "datasourceAccess.allowedTags is empty, so every datasource is denied"
				: `None of its tags (${descriptor.tags.join(", ")}) is in datasourceAccess.allowedTags`,
		};
	}
	return { state: "connected", skillName, tags: descriptor.tags, detail: `Agents load ${skillName}` };
}

function indexState(type: string, skill: DatasourceSkill | undefined, workspacePath: string): DataSourceRow["index"] {
	if (skill === undefined) return { state: "not-indexed", chunkCount: null, indexedAt: null, detail: "Not indexed" };
	if (!CHUNK_STORE_TEMPLATES.has(type)) {
		const binary = BACKEND_BINARIES[type] ?? type;
		return { state: "external", chunkCount: null, indexedAt: null, detail: `${binary} keeps its own index` };
	}
	const descriptor = skill.describe();
	const storePath = datasourceChunkStorePath(workspacePath, descriptor.name, descriptor.instanceId ?? "default");
	try {
		const parsed: unknown = JSON.parse(readFileSync(storePath, "utf8"));
		const chunks = isRecord(parsed) && Array.isArray(parsed.chunks) ? parsed.chunks.length : 0;
		const indexedAt = isRecord(parsed) && typeof parsed.updatedAt === "number" ? new Date(parsed.updatedAt).toISOString() : null;
		return chunks === 0
			? { state: "empty", chunkCount: 0, indexedAt, detail: "The last refresh found nothing to index" }
			: { state: "indexed", chunkCount: chunks, indexedAt, detail: `${chunks} chunks` };
	} catch {
		return { state: "not-indexed", chunkCount: null, indexedAt: null, detail: "Run `autorag refresh` to index it" };
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

function refreshState(workspacePath: string): DataSourcesSnapshot["refresh"] {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(workspacePath, ".autorag", "refresh-progress.json"), "utf8"));
		if (!isRecord(parsed)) return { state: "idle", phase: null, finishedAt: null };
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

/**
 * Compute the `allowedTags` set that grants/revokes exactly one source without
 * changing any other configured source's accessibility.
 *
 * Sources are gated by tag intersection, so a tag shared with another source
 * cannot be added or removed freely. When the request cannot be met without
 * affecting another source the helper returns `null` and the caller refuses.
 */
export function computeAccessTags(
	sources: readonly { readonly id: string; readonly tags: readonly string[] }[],
	current: readonly string[],
	targetId: string,
	allowed: boolean,
): string[] | null {
	const target = sources.find((source) => source.id === targetId);
	if (target === undefined) return null;
	const accessible = (tags: readonly string[], set: ReadonlySet<string>): boolean => tags.some((tag) => set.has(tag));
	const currentSet = new Set(current);
	const candidate = new Set(current);
	if (allowed) {
		for (const tag of target.tags) {
			// A tag shared with another source would grant that source too.
			if (!sources.some((other) => other.id !== targetId && other.tags.includes(tag))) candidate.add(tag);
		}
	} else {
		for (const tag of target.tags) candidate.delete(tag);
	}
	for (const other of sources) {
		if (other.id === targetId) continue;
		if (accessible(other.tags, currentSet) !== accessible(other.tags, candidate)) return null;
	}
	if (accessible(target.tags, candidate) !== allowed) return null;
	return [...candidate].sort();
}

function toDiagnostic(diagnostic: DatasourceDiagnostic): ConfigRefreshDiagnostic {
	return { code: String(diagnostic.code), severity: diagnostic.severity, message: diagnostic.message };
}

export function createDataSourceStatusService(deps: DataSourceStatusDeps): DataSourceStatusService {
	const configPath = (): string => resolveConfigPath({ flags: {}, env: deps.env, cwd: deps.cwd }).configPath;
	const updateEntry = (id: string, update: (entry: unknown) => unknown): void => {
		const path = configPath();
		const raw = readRawConfigObject(path);
		const datasources = raw.datasources;
		if (!isRecord(datasources) || !Object.hasOwn(datasources, id)) throw new Error(`Unknown datasource: ${id}`);
		datasources[id] = update(datasources[id]);
		writeConfigObject(path, raw);
	};

	const listSnapshot = async (): Promise<DataSourcesSnapshot> => {
		const path = configPath();
		const empty: DataSourcesSnapshot = {
			configPath: path,
			configExists: existsSync(path),
			error: null,
			accessTags: [],
			refresh: { state: "idle", phase: null, finishedAt: null },
			sources: [],
		};
		if (!empty.configExists) return empty;
		let config: CliConfig;
		try {
			config = resolveConfigReadOnly({ flags: {}, env: deps.env, cwd: deps.cwd });
		} catch (error) {
			return { ...empty, error: error instanceof Error ? error.message : String(error) };
		}
		const allowedTags = config.datasourceAccess?.allowedTags ?? [];
		const access = new DatasourceAccessContext({
			allowedTags,
			...(config.datasourceAccess?.allowedScopes === undefined ? {} : { allowedScopes: config.datasourceAccess.allowedScopes }),
		});
		const refresh = refreshState(config.workspacePath);
		const sources = Object.entries(config.datasources ?? {}).map(([id, raw]): DataSourceRow => {
			const entry: DatasourceSkillConfig = isRecord(raw) ? raw : {};
			const enabled = raw !== false && entry.enabled !== false;
			const type = entry.type ?? id;
			const skill = BUILTIN_DATASOURCE_SKILL_NAMES.includes(type) ? buildSkill(id, entry, config.workspacePath) : undefined;
			const install = installState(type, entry, deps.env);
			const agent = agentState(skill, enabled, access, allowedTags);
			return {
				id,
				type,
				description: entry.description ?? skill?.describe().description ?? type,
				enabled,
				status: overallStatus({ enabled, install, agent }, refresh),
				install,
				agent,
				index: indexState(type, skill, config.workspacePath),
			};
		});
		return { ...empty, accessTags: allowedTags, refresh, sources };
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
		if (!existsSync(path)) return { ...base, error: "AutoRAG config not found" };
		let config: CliConfig;
		try {
			config = resolveConfigReadOnly({ flags: {}, env: deps.env, cwd: deps.cwd });
		} catch (error) {
			return { ...base, error: error instanceof Error ? error.message : String(error) };
		}
		const rawEntry: unknown = config.datasources?.[id];
		if (rawEntry === undefined) return { ...base, error: `Unknown datasource: ${id}` };
		const entry: DatasourceSkillConfig = isRecord(rawEntry) ? rawEntry : {};
		if (rawEntry === false || entry.enabled === false) {
			return { ...base, error: "This datasource is turned off" };
		}
		const type = entry.type ?? id;
		if (!BUILTIN_DATASOURCE_SKILL_NAMES.includes(type)) {
			return { ...base, state: "unsupported", error: `No built-in AutoRAG datasource named "${type}"` };
		}
		const install = installState(type, entry, deps.env);
		if (install.state === "missing" || install.state === "credential-missing") {
			return { ...base, state: "unavailable", error: install.detail, durationMs: Date.now() - startedAt };
		}
		let skill: DatasourceSkill | undefined;
		try {
			skill = buildSkill(id, entry, config.workspacePath, deps.discrawlEmbeddingRuntime?.());
		} catch (error) {
			return { ...base, state: "failed", error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt };
		}
		if (skill === undefined) {
			return { ...base, state: "unsupported", error: `No built-in AutoRAG datasource named "${type}"` };
		}
		let result: DatasourceIndexResult;
		try {
			result = await skill.index();
		} catch (error) {
			return { ...base, state: "failed", error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt };
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
		return {
			...base,
			state: "failed",
			durationMs,
			diagnostics,
			error: result.error ?? result.message ?? "The datasource CLI reported a failure",
		};
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
		setAccess: async (id, allowed) => {
			const snapshot = await listSnapshot();
			if (snapshot.error !== null) throw new Error(snapshot.error);
			const sources = snapshot.sources.map((row) => ({ id: row.id, tags: row.agent.tags }));
			const next = computeAccessTags(sources, snapshot.accessTags, id, allowed);
			if (next === null) {
				throw new Error(
					`Cannot ${allowed ? "grant" : "revoke"} access for "${id}" without changing another datasource that shares its tags`,
				);
			}
			const path = configPath();
			const raw = readRawConfigObject(path);
			const access = isRecord(raw.datasourceAccess) ? raw.datasourceAccess : {};
			raw.datasourceAccess = { ...access, allowedTags: next };
			writeConfigObject(path, raw);
		},
		setEnabled: async (id, enabled) => {
			updateEntry(id, (entry) => (isRecord(entry) ? { ...entry, enabled } : enabled));
		},
		setDescription: async (id, description) => {
			const text = description.trim();
			updateEntry(id, (entry) => {
				const { description: _previous, ...rest } = isRecord(entry) ? entry : entry === false ? { enabled: false } : {};
				return text.length === 0 ? rest : { ...rest, description: text };
			});
		},
	};
}
