import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject } from "../shared/settings-contract";

export const CALENDAR_MCP_PACKAGE = "mcp-server-apple-events";
export const CALENDAR_MCP_SERVER_NAME = "apple-events";
export const CALENDAR_MCP_EXPOSURES = ["codemode", "direct", "deferred", "hidden"] as const;

export function isCalendarDatasourceType(type: string): boolean {
	return type === "calendar" || type === "apple-events";
}

export function isCalendarDatasourceEntry(id: string, raw: unknown): boolean {
	if (raw === false) return isCalendarDatasourceType(id);
	if (raw === true) return isCalendarDatasourceType(id);
	if (!isJsonObject(raw)) return false;
	const type = typeof raw.type === "string" && raw.type.length > 0 ? raw.type : id;
	return isCalendarDatasourceType(type);
}

export function calendarMcpServerName(id: string): string {
	return id === "calendar" ? CALENDAR_MCP_SERVER_NAME : id;
}

export function buildCalendarMcpServerEntry(raw: unknown): Record<string, unknown> {
	const enabled = raw !== false && (!isJsonObject(raw) || raw.enabled !== false);
	const entry = isJsonObject(raw) ? raw : {};
	const connector = isJsonObject(entry.connector) ? entry.connector : {};
	const command = typeof connector.command === "string" && connector.command.trim().length > 0 ? connector.command.trim() : "npx";
	const requireConfirm = connector.requireWriteConfirmation !== false;
	const customArgs = Array.isArray(connector.args)
		? connector.args.filter((item): item is string => typeof item === "string" && item.length > 0)
		: null;
	const args =
		customArgs !== null
			? customArgs
			: command === "npx"
				? ["-y", CALENDAR_MCP_PACKAGE, ...(requireConfirm ? ["--require-write-confirmation"] : [])]
				: [...(requireConfirm ? ["--require-write-confirmation"] : [])];
	const description = typeof entry.description === "string" ? entry.description.trim() : "";
	const exposure =
		typeof connector.exposure === "string" &&
		(CALENDAR_MCP_EXPOSURES as readonly string[]).includes(connector.exposure)
			? connector.exposure
			: undefined;
	return {
		command,
		...(args.length > 0 ? { args } : {}),
		...(enabled ? {} : { enabled: false }),
		...(description.length > 0 ? { description } : {}),
		...(exposure !== undefined ? { exposure } : {}),
	};
}

function calendarEntriesOf(rawConfig: Record<string, unknown>): Map<string, unknown> {
	const out = new Map<string, unknown>();
	const datasources = isJsonObject(rawConfig.datasources) ? rawConfig.datasources : {};
	for (const [id, entry] of Object.entries(datasources)) {
		if (isCalendarDatasourceEntry(id, entry)) {
			out.set(calendarMcpServerName(id), entry);
		}
	}
	return out;
}

/**
 * Syncs `calendar` / `apple-events` datasource entries from the shared AutoRAG config
 * into `<agentDir>/mcp.json` so `createAutoRAGMcpClient(agentDir)` connects them on session start.
 * Preserves unrelated MCP server entries untouched.
 */
export function syncCalendarMcpConfig(
	candidate: Record<string, unknown>,
	previous: Record<string, unknown>,
	agentDir: string,
): void {
	const nextEntries = calendarEntriesOf(candidate);
	const prevEntries = calendarEntriesOf(previous);
	if (nextEntries.size === 0 && prevEntries.size === 0) return;

	const mcpPath = join(agentDir, "mcp.json");
	let root: Record<string, unknown> = {};
	if (existsSync(mcpPath)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(mcpPath, "utf8"));
			if (isJsonObject(parsed)) root = { ...parsed };
		} catch {
			root = {};
		}
	}
	const servers: Record<string, unknown> = isJsonObject(root.mcpServers) ? { ...root.mcpServers } : {};
	for (const prevName of prevEntries.keys()) {
		if (!nextEntries.has(prevName)) {
			delete servers[prevName];
		}
	}
	for (const [name, entry] of nextEntries) {
		servers[name] = buildCalendarMcpServerEntry(entry);
	}
	root.mcpServers = servers;
	mkdirSync(dirname(mcpPath), { recursive: true });
	writeFileSync(mcpPath, `${JSON.stringify(root, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
