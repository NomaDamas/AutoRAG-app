/**
 * What another agent needs to start Dazzi's own MCP server, and how each agent wants to be told.
 *
 * The server is the librarian's stdio MCP server (search, file names, duplicates, index status). The main
 * process resolves the launch (`McpConnectInfo`: the program, its arguments, the environment); this module only
 * turns that launch into the text a user pastes into an agent. It is pure so the exact strings are testable, and
 * every command line here was checked against the real `claude`, `codex` and `gemini` binaries.
 */

/** The name an agent registers the server under. */
export const MCP_SERVER_NAME = "dazzi";

/** The librarian MCP server hides its writing tools (`autorag.refresh`, `autorag.report`) when this is `1`. */
export const MCP_READ_ONLY_ENV = "AUTORAG_MCP_READ_ONLY";

/** The agents the page offers, in tab order. `json` is the `mcpServers` file Cursor, Claude Desktop and most others read. */
export const MCP_CLIENT_IDS = ["claude", "codex", "gemini", "json"] as const;
export type McpClientId = (typeof MCP_CLIENT_IDS)[number];

export interface McpLaunch {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
}

export type McpPlatform = "darwin" | "win32" | "linux";

/** `launch` with the server's read-only switch set; unchanged when `readOnly` is false. */
export function withReadOnly(launch: McpLaunch, readOnly: boolean): McpLaunch {
	return readOnly ? { ...launch, env: { ...launch.env, [MCP_READ_ONLY_ENV]: "1" } } : launch;
}

const POSIX_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/u;
const WINDOWS_SAFE = /^[A-Za-z0-9_@%+=:,./\\-]+$/u;

/** `word` as one shell word: single quotes on POSIX, double quotes on Windows, and nothing when it is already safe. */
export function shellQuote(word: string, platform: McpPlatform): string {
	if (platform === "win32") return WINDOWS_SAFE.test(word) ? word : `"${word.replaceAll('"', '\\"')}"`;
	return POSIX_SAFE.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The environment as `NAME=value` lines. */
export function envLines(launch: McpLaunch): string {
	return Object.entries(launch.env)
		.map(([name, value]) => `${name}=${value}`)
		.join("\n");
}

function jsonSnippet(launch: McpLaunch): string {
	const entry: Record<string, unknown> = { command: launch.command, args: launch.args };
	if (Object.keys(launch.env).length > 0) entry.env = launch.env;
	return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: entry } }, null, 2);
}

/** The text to paste into `client`: a command line for the three CLIs, the `mcpServers` JSON for the rest. */
export function clientSnippet(client: McpClientId, launch: McpLaunch, platform: McpPlatform): string {
	if (client === "json") return jsonSnippet(launch);
	const env = Object.entries(launch.env).map(([name, value]) => shellQuote(`${name}=${value}`, platform));
	const program = [launch.command, ...launch.args].map((word) => shellQuote(word, platform));
	switch (client) {
		// Claude Code reads `-e` as a list that swallows the next word, so the name goes first and `--` ends the list.
		case "claude":
			return ["claude mcp add --scope user", MCP_SERVER_NAME, ...env.flatMap((pair) => ["-e", pair]), "--", ...program].join(" ");
		case "codex":
			return ["codex mcp add", MCP_SERVER_NAME, ...env.flatMap((pair) => ["--env", pair]), "--", ...program].join(" ");
		case "gemini":
			return ["gemini mcp add --scope user", ...env.flatMap((pair) => ["-e", pair]), MCP_SERVER_NAME, ...program].join(" ");
	}
}
