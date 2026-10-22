import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isJsonObject, type JsonObject, type McpExposure, type McpServerInput, type McpServerRow, type McpSnapshot } from "../shared/settings-contract";
import { t } from "../shared/i18n/core";

/**
 * Settings → MCP servers. The librarian connects the servers listed in
 * `<agentDir>/mcp.json` to every search and chat session (a project-level
 * `.pi/mcp.json` is ignored on purpose), so this service is the only editor the app
 * needs: it reads that file, validates an entry with the rules pi applies when the
 * session starts, and rewrites the file keeping everything it does not manage
 * (top-level options, per-server `oauth`, `auth`, `toolExposure`, …).
 *
 * pi's validator is not part of its public API, so the rules are repeated here; pi
 * validates again at session start and reports a bad entry verbatim, which makes this
 * check early feedback, not the last line of defense.
 */

export interface McpSettingsService {
	get(): Promise<McpSnapshot>;
	/** Adds a server, replaces one by name, or (with `replaces`) renames and replaces it in place. */
	upsert(input: McpServerInput): Promise<McpSnapshot>;
	remove(name: string): Promise<McpSnapshot>;
}

export interface McpSettingsDeps {
	/** The pi agent directory; read on each call so a changed environment is honoured. */
	readonly agentDir: () => string;
}

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const EXPOSURES: readonly McpExposure[] = ["codemode", "deferred", "direct", "hidden"];
/** Older exposure names pi still accepts, with what they stand for. */
const EXPOSURE_ALIASES: Readonly<Record<string, McpExposure>> = { "codemode-deferred": "codemode" };

function isStringRecord(value: unknown): value is Record<string, string> {
	return isJsonObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function resolveExposure(value: unknown): McpExposure | undefined {
	if (typeof value !== "string") return undefined;
	const resolved = EXPOSURE_ALIASES[value] ?? value;
	return EXPOSURES.find((exposure) => exposure === resolved);
}

function invalid(field: string): string {
	return t("main.mcp.errors.invalidField", { field });
}

/** Null when the entry is acceptable, otherwise the first problem found, in the user's language. */
export function validateMcpServer(name: string, config: unknown): string | null {
	if (!SERVER_NAME.test(name)) return t("main.mcp.errors.invalidName");
	if (!isJsonObject(config)) return t("main.mcp.errors.notObject");
	const { type, exposure, enabled, timeout, toolExposure, description } = config;
	if (exposure !== undefined && resolveExposure(exposure) === undefined) return invalid("exposure");
	if (toolExposure !== undefined && !(isJsonObject(toolExposure) && Object.values(toolExposure).every((entry) => resolveExposure(entry) !== undefined))) return invalid("toolExposure");
	if (enabled !== undefined && typeof enabled !== "boolean") return invalid("enabled");
	if (description !== undefined && typeof description !== "string") return invalid("description");
	if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) return invalid("timeout");
	if (type === "sse") return t("main.mcp.errors.sseUnsupported");
	if (typeof config.url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
		if (!URL.canParse(config.url) || !/^https?:$/u.test(new URL(config.url).protocol)) return t("main.mcp.errors.badUrl");
		if (config.headers !== undefined && !isStringRecord(config.headers)) return invalid("headers");
		return null;
	}
	if (typeof config.command === "string" && config.command.trim().length > 0 && (type === undefined || type === "stdio")) {
		if (config.args !== undefined && !(Array.isArray(config.args) && config.args.every((arg) => typeof arg === "string"))) return invalid("args");
		if (config.env !== undefined && !isStringRecord(config.env)) return invalid("env");
		if (config.cwd !== undefined && typeof config.cwd !== "string") return invalid("cwd");
		return null;
	}
	return t("main.mcp.errors.needsTransport");
}

function rowOf(name: string, config: Record<string, unknown>): McpServerRow {
	const type = config.type;
	const transport = typeof config.url === "string" && (type === undefined || type === "http" || type === "streamable-http") ? "http" : typeof config.command === "string" && (type === undefined || type === "stdio") ? "stdio" : "unknown";
	return {
		name,
		// Parsed from the file, so it is JSON by construction.
		config: config as JsonObject,
		transport,
		enabled: config.enabled !== false,
		exposure: resolveExposure(config.exposure) ?? "codemode",
		problem: validateMcpServer(name, config),
	};
}

interface McpFile {
	readonly root: Record<string, unknown>;
	readonly servers: Record<string, unknown>;
}

export function createMcpSettingsService(deps: McpSettingsDeps): McpSettingsService {
	const filePath = (): string => join(deps.agentDir(), "mcp.json");
	// Writes are read-modify-write on one file; running them one after another keeps a burst of toggles from losing edits.
	let queue: Promise<unknown> = Promise.resolve();
	const serialized = <T>(work: () => Promise<T>): Promise<T> => {
		const next = queue.then(work, work);
		queue = next.catch(() => undefined);
		return next;
	};

	/** The parsed file; `null` when it does not exist. Throws with a readable reason when it exists but cannot be used. */
	const load = async (path: string): Promise<McpFile | null> => {
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw new Error(t("main.mcp.errors.unreadable", { path, reason: error instanceof Error ? error.message : String(error) }));
		}
		let parsed: unknown;
		try {
			parsed = text.trim().length === 0 ? {} : JSON.parse(text);
		} catch (error) {
			throw new Error(t("main.mcp.errors.unreadable", { path, reason: error instanceof Error ? error.message : String(error) }));
		}
		if (!isJsonObject(parsed)) throw new Error(t("main.mcp.errors.unreadable", { path, reason: t("main.mcp.errors.notObject") }));
		if (parsed.mcpServers !== undefined && !isJsonObject(parsed.mcpServers)) {
			throw new Error(t("main.mcp.errors.unreadable", { path, reason: t("main.mcp.errors.serversNotObject") }));
		}
		return { root: parsed, servers: isJsonObject(parsed.mcpServers) ? parsed.mcpServers : {} };
	};

	const snapshotOf = (path: string, file: McpFile | null): McpSnapshot => ({
		path,
		exists: file !== null,
		error: null,
		servers: Object.entries(file?.servers ?? {}).map(([name, config]) => rowOf(name, isJsonObject(config) ? config : {})),
	});

	/** The file can hold tokens (headers, env), so it is created readable by the owner only and replaced atomically. */
	const save = async (path: string, root: Record<string, unknown>, servers: Record<string, unknown>): Promise<void> => {
		await mkdir(dirname(path), { recursive: true });
		const temporary = `${path}.${process.pid}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify({ ...root, mcpServers: servers }, null, 2)}\n`, { mode: 0o600 });
			await rename(temporary, path);
		} catch (error) {
			await rm(temporary, { force: true });
			throw error;
		}
	};

	return {
		get: async () => {
			const path = filePath();
			try {
				return snapshotOf(path, await load(path));
			} catch (error) {
				return { path, exists: true, error: error instanceof Error ? error.message : String(error), servers: [] };
			}
		},
		upsert: (input) =>
			serialized(async () => {
				const path = filePath();
				const problem = validateMcpServer(input.name, input.config);
				if (problem !== null) throw new Error(problem);
				const file = (await load(path)) ?? { root: {}, servers: {} };
				const current = input.replaces;
				if (current === undefined && Object.hasOwn(file.servers, input.name)) throw new Error(t("main.mcp.errors.duplicate", { name: input.name }));
				if (current !== undefined && !Object.hasOwn(file.servers, current)) throw new Error(t("main.mcp.errors.unknownServer", { name: current }));
				if (current !== undefined && current !== input.name && Object.hasOwn(file.servers, input.name)) throw new Error(t("main.mcp.errors.duplicate", { name: input.name }));
				// An edit keeps the entry where it was: renaming must not reshuffle the user's file.
				const servers: Record<string, unknown> = {};
				for (const [name, config] of Object.entries(file.servers)) servers[name === current ? input.name : name] = name === current ? input.config : config;
				if (current === undefined) servers[input.name] = input.config;
				await save(path, file.root, servers);
				return snapshotOf(path, { root: file.root, servers });
			}),
		remove: (name) =>
			serialized(async () => {
				const path = filePath();
				const file = await load(path);
				if (file === null || !Object.hasOwn(file.servers, name)) throw new Error(t("main.mcp.errors.unknownServer", { name }));
				const servers: Record<string, unknown> = {};
				for (const [existing, config] of Object.entries(file.servers)) if (existing !== name) servers[existing] = config;
				await save(path, file.root, servers);
				return snapshotOf(path, { root: file.root, servers });
			}),
	};
}
