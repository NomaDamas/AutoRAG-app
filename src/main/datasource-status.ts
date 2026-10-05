import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, extname, join } from "node:path";
import {
	BUILTIN_DATASOURCE_SKILL_NAMES,
	buildDatasourceSkills,
	DatasourceAccessContext,
	type DatasourceSkill,
	type DatasourceSkillConfig,
	datasourceChunkStorePath,
	resolveConfigReadOnly,
	writeConfigObject,
} from "@autorag/librarian";
import { readRawConfigObject, resolveConfigPath } from "@autorag/librarian/core";
import type { DataSourceRow, DataSourcesSnapshot } from "../shared/settings-contract";

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
}

export interface DataSourceStatusDeps {
	readonly env: NodeJS.ProcessEnv;
	readonly cwd: string;
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
	if (!BUILTIN_DATASOURCE_SKILL_NAMES.includes(type)) {
		return { state: "unsupported", binary: null, path: null, detail: `No built-in Dazzi datasource named "${type}"` };
	}
	const connector = isRecord(entry.connector) ? entry.connector : {};
	if (type === "github" || type === "github-gist") {
		const tokenEnv = typeof connector.tokenEnv === "string" ? connector.tokenEnv : DEFAULT_TOKEN_ENV;
		const hasToken = typeof connector.token === "string" || Boolean(env[tokenEnv]);
		const gh = type === "github-gist" ? findExecutable("gh", env) : null;
		return hasToken || gh !== null
			? { state: "builtin", binary: null, path: gh, detail: hasToken ? `Token from ${tokenEnv}` : "Token from gh auth" }
			: { state: "credential-missing", binary: null, path: null, detail: `Set ${tokenEnv} to let Dazzi reach GitHub` };
	}
	const binary = BACKEND_BINARIES[type];
	if (binary === undefined) return { state: "builtin", binary: null, path: null, detail: "Built into Dazzi" };
	const configured = typeof connector.binaryPath === "string" ? connector.binaryPath : binary;
	const path = findExecutable(configured, env);
	return path === null
		? { state: "missing", binary, path: null, detail: `${configured} was not found on PATH` }
		: { state: "installed", binary, path, detail: `${binary} at ${path}` };
}

/** Build the librarian skill for one entry; disabled entries are built as if enabled to learn their descriptor. */
function buildSkill(id: string, entry: DatasourceSkillConfig, workspacePath: string): DatasourceSkill | undefined {
	return buildDatasourceSkills({ [id]: { ...entry, enabled: true } }, workspacePath).skills[0];
}

function agentState(
	skill: DatasourceSkill | undefined,
	enabled: boolean,
	access: DatasourceAccessContext,
	allowedTags: readonly string[],
): DataSourceRow["agent"] {
	if (skill === undefined) {
		return { state: "unsupported", skillName: null, tags: [], detail: "The Dazzi agent skips unknown datasources" };
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

	return {
		list: async () => {
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
			let config: ReturnType<typeof resolveConfigReadOnly>;
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
