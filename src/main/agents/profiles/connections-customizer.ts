import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentProfile } from "@autorag/librarian/profiles";
import { isJsonObject, type JsonObject, type JsonValue, type McpExposure, type McpServerRow } from "../../../shared/settings-contract";
import { REFRESH_INTERVALS } from "../../../shared/settings-options";
import { intentPromptLine, withIntentTools } from "../profile-progress";
import {
	createCustomizerKit,
	REPLY_LANGUAGE_NAME,
	textResult,
	type ConfigCustomizerDeps,
	type ConfigCustomizerProfileInput,
	type CustomizerToolkit,
	type Localized,
	type ReplyLanguage,
} from "./customizer-kit";

/**
 * Settings → MCP servers (`mcp`) and Settings → 모든 연결 (`apps`). Both pages are edited by one assistant because
 * they are the same question — what this computer is connected to — and the config each row writes is the same the
 * page writes: the shared `mcp.json` (validated by the real MCP service) and `datasources.<id>` of the AutoRAG config.
 */

/** Install states in which a datasource cannot work yet, so turning it on would be a lie. */
const NOT_INSTALLABLE: readonly string[] = ["unsupported", "missing", "credential-missing"];

export interface ConnectionsCustomizerToolkitDeps extends ConfigCustomizerDeps {
	/** Accepted for parity with the other profiles' factories; this toolkit writes no OS-specific value. */
	readonly platform?: NodeJS.Platform;
}

function localized(ko: string, en: string, ja: string, zh: string): Localized {
	return { ko, en, ja, zh };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function stringKeys(value: unknown): string[] | undefined {
	return isJsonObject(value) && Object.values(value).every((entry) => typeof entry === "string") ? Object.keys(value) : undefined;
}

/** The entry with `enabled` / `exposure` set; the defaults remove the key, exactly like pi's own `/mcp` and McpPage. */
function withSwitches(config: JsonObject, patch: { readonly enabled?: boolean; readonly exposure?: McpExposure }): JsonObject {
	const next: Record<string, JsonValue> = { ...config };
	if (patch.enabled !== undefined) {
		if (patch.enabled) delete next.enabled;
		else next.enabled = false;
	}
	if (patch.exposure !== undefined) {
		if (patch.exposure === "codemode") delete next.exposure;
		else next.exposure = patch.exposure;
	}
	return next;
}

/** Everything the assistant may see about one server: never an env or header value, only the key names. */
function mcpSummary(row: McpServerRow): Record<string, unknown> {
	const config = row.config as Record<string, unknown>;
	const summary: Record<string, unknown> = {
		name: row.name,
		transport: row.transport,
		enabled: row.enabled,
		exposure: row.exposure,
		problem: row.problem,
	};
	if (typeof config.description === "string") summary.description = config.description;
	if (typeof config.url === "string") summary.url = config.url;
	if (typeof config.command === "string") {
		summary.command = config.command;
		if (Array.isArray(config.args)) summary.args = config.args.filter((arg): arg is string => typeof arg === "string");
	}
	const envKeys = stringKeys(config.env);
	if (envKeys !== undefined) summary.envKeys = envKeys;
	const headerKeys = stringKeys(config.headers);
	if (headerKeys !== undefined) summary.headerKeys = headerKeys;
	return summary;
}

function pollingIntervalOf(config: JsonObject, id: string): number {
	const datasources = isJsonObject(config.datasources) ? config.datasources : {};
	const entry = datasources[id];
	if (isJsonObject(entry) && typeof entry.pollingIntervalMs === "number") return entry.pollingIntervalMs;
	return 0;
}

export function createConnectionsCustomizerToolkit(deps: ConnectionsCustomizerToolkitDeps): CustomizerToolkit {
	const kit = createCustomizerKit(deps);
	const lang = (): ReplyLanguage => deps.language?.() ?? "ko";

	const getConnections = defineTool({
		name: "get_connections",
		label: "Inspect Connections",
		description:
			"Read the MCP servers in the agent's `mcp.json` (name, transport, enabled, exposure, validation problem, description, url or command+args, and the KEY NAMES of env/headers — never their values) and every configured datasource (id, type, description, enabled, install/agent/index state and count, and its polling interval; 0 = manual).",
		parameters: Type.Object({}),
		execute: async () => {
			kit.ensureLive();
			const [mcp, sources, config] = await Promise.all([deps.settings.mcpGet(), deps.settings.sourcesList(), deps.settings.configGet()]);
			return textResult({
				ok: true,
				mcp: {
					path: mcp.path,
					exists: mcp.exists,
					error: mcp.error,
					servers: mcp.servers.map((row) => mcpSummary(row)),
				},
				datasources: sources.sources.map((row) => ({
					id: row.id,
					type: row.type,
					description: row.description,
					enabled: row.enabled,
					status: row.status,
					installState: row.install.state,
					agentState: row.agent.state,
					indexState: row.index.state,
					indexCount: row.index.chunkCount,
					indexUnit: row.index.unit,
					pollingIntervalMs: pollingIntervalOf(config.config, row.id),
				})),
			});
		},
	});

	const updateDatasource = defineTool({
		name: "update_datasource",
		label: "Update A Connected Datasource",
		description:
			"Edit one existing datasource: turn it on/off (`enabled`), set or clear its description (`description`, blank clears), and set its refresh cadence (`pollingIntervalMs`, 0 = manual or one of the offered intervals). It cannot add or remove a connection, edit its connector or credentials, or start a sync — direct the person to the page for those.",
		parameters: Type.Object({
			id: Type.String({ description: "Existing configured datasource id as returned by get_connections." }),
			enabled: Type.Optional(Type.Boolean({ description: "Turn the datasource on (`true`) or off (`false`)." })),
			description: Type.Optional(Type.String({ description: "Description the agent reads for this source; a blank string clears it." })),
			pollingIntervalMs: Type.Optional(
				Type.Number({ description: "Refresh cadence in milliseconds: 0 for manual, or one of the offered intervals (300000, 900000, 1800000, 3600000, 21600000, 86400000)." }),
			),
		}),
		execute: async (_callId, params) => {
			kit.ensureLive();
			const sources = await deps.settings.sourcesList();
			const row = sources.sources.find((entry) => entry.id === params.id);
			if (row === undefined) {
				const valid = sources.sources.map((entry) => entry.id);
				return textResult({
					ok: false,
					error: `There is no datasource with id '${params.id}'. Configured datasources: ${valid.length > 0 ? valid.join(", ") : "(none)"}.`,
				});
			}

			const warnings: string[] = [];
			const applied: string[] = [];
			const fields: string[] = [];
			kit.ensureLive();
			try {
				if (params.enabled !== undefined) {
					if (NOT_INSTALLABLE.includes(row.install.state)) {
						warnings.push(
							`'${row.id}' is '${row.install.state}' and cannot work yet; turn it on after the connection is finished on its Settings page.`,
						);
					} else {
						await deps.settings.sourcesSetEnabled(row.id, params.enabled);
						applied.push(params.enabled ? "enabled" : "disabled");
						fields.push(`datasources.${row.id}.enabled`);
					}
				}
				if (params.description !== undefined) {
					await deps.settings.sourcesSetDescription(row.id, params.description);
					applied.push("description");
					fields.push(`datasources.${row.id}.description`);
				}
				if (params.pollingIntervalMs !== undefined) {
					const ms = params.pollingIntervalMs;
					if (ms !== 0 && !REFRESH_INTERVALS.some((option) => option.ms === ms)) {
						warnings.push(
							`${ms}ms is not an offered refresh interval; use 0 for manual or one of ${[0, ...REFRESH_INTERVALS.map((option) => option.ms)].join(", ")}.`,
						);
					} else {
						await deps.settings.configPatch([{ path: ["datasources", row.id, "pollingIntervalMs"], value: ms }]);
						applied.push(`pollingIntervalMs=${ms}`);
						fields.push(`datasources.${row.id}.pollingIntervalMs`);
						try {
							await deps.settings.refreshScheduleApply();
						} catch (error) {
							warnings.push(`The refresh schedule could not be updated: ${errorMessage(error)}`);
						}
					}
				}
			} catch (error) {
				return textResult({ ok: false, error: errorMessage(error), warnings });
			}

			if (applied.length > 0) {
				kit.record({
					kind: "connections",
					summary: localized(
						`연결 "${row.id}" 설정 변경 (${applied.join(", ")})`,
						`Updated connection "${row.id}" (${applied.join(", ")})`,
						`接続 "${row.id}" の設定を変更 (${applied.join(", ")})`,
						`已更新连接 "${row.id}" 的设置 (${applied.join(", ")})`,
					),
					fields,
					...(warnings.length > 0 ? { warnings } : {}),
				});
			}

			return textResult({ ok: true, warnings, applied, datasource: { id: row.id, installState: row.install.state } });
		},
	});

	const updateMcpServer = defineTool({
		name: "update_mcp_server",
		label: "Update An MCP Server",
		description:
			"Add, edit, enable/disable, re-expose or remove one MCP server in `mcp.json`. For `upsert` give the transport as `url` (http/https) or `command` + `args`, plus optional `description`, `env` and `headers` (KEY -> VALUE) and `replaces` (the current name, when renaming). `remove` is a real, destructive action and needs `confirmedByUser: true` after the person explicitly named that server. Values are written to disk and are never echoed back.",
		parameters: Type.Object({
			name: Type.String({ description: "Server name (letters, digits, `_` and `-`)." }),
			action: Type.Union(
				[Type.Literal("enable"), Type.Literal("disable"), Type.Literal("set_exposure"), Type.Literal("remove"), Type.Literal("upsert")],
				{ description: "What to do to the named server." },
			),
			exposure: Type.Optional(
				Type.Union([Type.Literal("codemode"), Type.Literal("deferred"), Type.Literal("direct"), Type.Literal("hidden")], {
					description: "Required for `set_exposure`: how the agent sees the server's tools (`codemode` is the default).",
				}),
			),
			url: Type.Optional(Type.String({ description: "For `upsert`: the http(s) endpoint of a remote server." })),
			command: Type.Optional(Type.String({ description: "For `upsert`: the executable of a local (stdio) server." })),
			args: Type.Optional(Type.Array(Type.String(), { description: "For `upsert` with `command`: its arguments." })),
			description: Type.Optional(Type.String({ description: "Optional human description stored with the entry." })),
			env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "For `upsert` with `command`: environment KEY -> VALUE pairs." })),
			headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "For `upsert` with `url`: HTTP header KEY -> VALUE pairs." })),
			replaces: Type.Optional(Type.String({ description: "For `upsert`: the server's current name when renaming or editing it." })),
			confirmedByUser: Type.Optional(Type.Boolean({ description: "Set `true` only for `remove`, and only after the person explicitly asked to remove this server." })),
		}),
		execute: async (_callId, params) => {
			kit.ensureLive();
			const snapshot = await deps.settings.mcpGet();
			if (snapshot.error !== null) return textResult({ ok: false, error: snapshot.error });
			const current = snapshot.servers.find((row) => row.name === params.name);
			const name = params.name;
			const warnings: string[] = [];
			const fields: string[] = [`mcpServers.${name}`];

			if (params.action === "remove") {
				if (params.confirmedByUser !== true) {
					return textResult({
						ok: false,
						error: `Removing an MCP server is real and destructive; pass confirmedByUser: true only after the person explicitly asked to remove '${name}'.`,
					});
				}
				if (current === undefined) return textResult({ ok: false, error: `There is no MCP server named '${name}'.` });
				kit.ensureLive();
				try {
					await deps.settings.mcpRemove(name);
				} catch (error) {
					return textResult({ ok: false, error: errorMessage(error), warnings });
				}
				kit.record({
					kind: "connections",
					summary: localized(`MCP 서버 "${name}" 제거`, `Removed MCP server "${name}"`, `MCP サーバー "${name}" を削除`, `已移除 MCP 服务器 "${name}"`),
					fields,
				});
				return textResult({ ok: true, warnings, name, action: "remove" });
			}

			if (params.action === "enable" || params.action === "disable" || params.action === "set_exposure") {
				if (current === undefined) return textResult({ ok: false, error: `There is no MCP server named '${name}'.` });
				let config: JsonObject;
				let summary: Localized;
				if (params.action === "set_exposure") {
					if (params.exposure === undefined) return textResult({ ok: false, error: "`exposure` is required for `set_exposure`." });
					config = withSwitches(current.config, { exposure: params.exposure });
					summary = localized(`MCP 서버 "${name}" 노출 방식 변경 (${params.exposure})`, `Changed MCP server "${name}" exposure (${params.exposure})`, `MCP サーバー "${name}" の公開方式を変更 (${params.exposure})`, `已更改 MCP 服务器 "${name}" 的暴露方式 (${params.exposure})`);
				} else {
					const enabled = params.action === "enable";
					config = withSwitches(current.config, { enabled });
					summary = enabled
						? localized(`MCP 서버 "${name}" 활성화`, `Enabled MCP server "${name}"`, `MCP サーバー "${name}" を有効化`, `已启用 MCP 服务器 "${name}"`)
						: localized(`MCP 서버 "${name}" 비활성화`, `Disabled MCP server "${name}"`, `MCP サーバー "${name}" を無効化`, `已禁用 MCP 服务器 "${name}"`);
				}
				kit.ensureLive();
				try {
					await deps.settings.mcpUpsert({ name, replaces: name, config });
				} catch (error) {
					return textResult({ ok: false, error: errorMessage(error), warnings });
				}
				kit.record({ kind: "connections", summary, fields });
				return textResult({ ok: true, warnings, name, action: params.action });
			}

			// action === "upsert": add a new server or edit/rename an existing one.
			const description = params.description?.trim() ?? "";
			if (params.url !== undefined && params.command !== undefined) {
				return textResult({ ok: false, error: "Give either `url` (http) or `command` + `args` (stdio), not both." });
			}
			if (params.url === undefined && params.command === undefined) {
				return textResult({ ok: false, error: "Give the transport: `url` for a remote server or `command` for a local one." });
			}
			// Start from the existing entry and change only what was given, so keys the assistant cannot see (env/header
			// values) and keys it does not manage (oauth, toolExposure, …) are never destroyed by an unrelated edit.
			const config: Record<string, JsonValue> = current === undefined ? {} : { ...current.config };
			if (params.description !== undefined) {
				if (description.length > 0) config.description = description;
				else delete config.description;
			}
			if (params.url !== undefined) {
				delete config.command;
				delete config.args;
				delete config.env;
				delete config.cwd;
				config.url = params.url.trim();
				if (params.headers !== undefined) {
					if (Object.keys(params.headers).length > 0) config.headers = { ...params.headers };
					else delete config.headers;
				}
			} else if (params.command !== undefined) {
				delete config.url;
				delete config.headers;
				config.command = params.command.trim();
				if (params.args !== undefined) {
					const args = params.args.map((arg) => arg.trim()).filter((arg) => arg.length > 0);
					if (args.length > 0) config.args = args;
					else delete config.args;
				}
				if (params.env !== undefined) {
					if (Object.keys(params.env).length > 0) config.env = { ...params.env };
					else delete config.env;
				}
			}

			kit.ensureLive();
			try {
				const input = params.replaces === undefined ? { name, config } : { name, replaces: params.replaces, config };
				await deps.settings.mcpUpsert(input);
			} catch (error) {
				return textResult({ ok: false, error: errorMessage(error), warnings });
			}
			const verb = current === undefined ? "added" : "edited";
			kit.record({
				kind: "connections",
				summary: localized(
					`MCP 서버 "${name}" 설정 저장`,
					`Saved MCP server "${name}" (${verb})`,
					`MCP サーバー "${name}" の設定を保存`,
					`已保存 MCP 服务器 "${name}"`,
				),
				fields,
			});
			return textResult({ ok: true, warnings, name, action: "upsert" });
		},
	});

	return kit.toolkit([getConnections, updateDatasource, updateMcpServer]);
}

function systemPrompt(language: ReplyLanguage, surface: string, intervalHint: string): string {
	const replyLang = REPLY_LANGUAGE_NAME[language];
	const section = surface === "mcp" ? "Settings → MCP 서버 (MCP servers)" : "Settings → 모든 연결 (connected apps/datasources)";

	return [
		`You are Dazzi's dedicated Connections Assistant (\`connections-customizer\`), embedded inside ${section}.`,
		`Always reply in ${replyLang}, concisely and warmly.`,
		"",
		"## Role & Scope",
		"- You edit the connections this computer is set up with, through the same services the Settings pages write through: the shared `mcp.json` (validated by the real MCP service) and `datasources.<id>` of the shared AutoRAG config.",
		`- Offered refresh intervals for a datasource: ${intervalHint} (milliseconds; 0 means manual).`,
		"",
		"## Non-Negotiable Invariants",
		"1. **No secrets, ever**: you never ask for, write, invent, or reveal API keys, tokens, passwords, or credentials, and you never edit sign-in or remote-access settings. `get_connections` shows only the KEY NAMES of env/headers, never their values — keep it that way.",
		"2. **Closed datasource scope**: you can only enable/disable an existing datasource, change its description, or change its refresh cadence. You CANNOT add, connect, or remove a datasource, edit its connector or credentials, or start a sync (내 연결 / 앱 연결하기 and 새로고침 live on the page — point the person there).",
		"3. **Closed MCP scope**: you can add/edit/enable/disable/re-expose/remove one MCP server exactly as the page's form does, and you keep every key the page does not manage (`oauth`, `toolExposure`, …). An entry is validated by the real service; a rejected value is reported, not forced.",
		"4. **Explicit destructive requests**: `remove` — and adding a server that runs a command — are real actions. Only do them when the person explicitly asked for that exact server, and for `remove` pass `confirmedByUser: true`; without it the tool refuses.",
		"",
		"## Workflow",
		"1. Call `get_connections` first when you are unsure what exists; it names every server and datasource and their state.",
		"2. Call `update_datasource` or `update_mcp_server` to apply the change.",
		"3. Summarize in 1-3 short sentences what changed (and note anything you refused to change and where to do it instead).",
		"",
		intentPromptLine(language),
	].join("\n");
}

export function connectionsCustomizerProfile(input: ConfigCustomizerProfileInput): AgentProfile {
	const intervalHint = [0, ...REFRESH_INTERVALS.map((option) => option.ms)].join(", ");
	return {
		id: "connections-customizer",
		systemPrompt: systemPrompt(input.language, input.surface, intervalHint),
		tools: [],
		customTools: withIntentTools(input.toolkit.tools, { language: input.language }),
		thinking: "low",
	};
}
