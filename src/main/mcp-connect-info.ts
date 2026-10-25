import { existsSync } from "node:fs";
import { join } from "node:path";
import type { McpConnectInfo } from "../shared/settings-contract";
import { resolveNodeBinary } from "./automation-runtime";

/**
 * How another agent starts Dazzi's own MCP server (Settings → MCP 서버 → "다른 에이전트에 연결").
 *
 * The server is `mcp-server.js`, built next to the main bundle, run on a real Node: the one the installer ships under
 * `<tools>/node`, else the first `node` on `PATH`. It is deliberately not the app's own binary started as Node
 * (`ELECTRON_RUN_AS_NODE`): Gemini CLI strips that variable from an MCP server's environment as dangerous, which
 * would start the whole app instead, and the librarian CLI already runs on the bundled Node the same way.
 *
 * An agent starts the server with its own environment, which knows nothing of the bundle, so the one thing the
 * install must hand over is where its tools are (`AUTORAG_TOOLS_DIR`): the server puts that directory on `PATH`
 * exactly as the app does, so minsync and the datasource CLIs are found. A development run has none and needs none.
 */

/** The variables that choose which AutoRAG config and home the app reads; the server must read the same ones. */
const FORWARDED_ENV = ["AUTORAG_HOME", "AUTORAG_CONFIG"] as const;

export interface McpConnectDeps {
	/** Electron's `process.resourcesPath`: the bundle that carries `tools/`. */
	readonly resourcesPath: string;
	/** The built `mcp-server.js`. */
	readonly entryPath: string;
	readonly env: NodeJS.ProcessEnv;
	readonly platform: NodeJS.Platform;
	/** Defaults to `existsSync`; injected in tests so no real build is needed. */
	readonly exists?: (path: string) => boolean;
	/** Defaults to {@link resolveNodeBinary}. */
	readonly findNode?: () => string | undefined;
}

export function resolveMcpConnectInfo(deps: McpConnectDeps): McpConnectInfo {
	const exists = deps.exists ?? existsSync;
	const node = (deps.findNode ?? (() => resolveNodeBinary({ resourcesPath: deps.resourcesPath, env: deps.env, platform: deps.platform })))();
	const env: Record<string, string> = {};
	const toolsRoot = deps.env.AUTORAG_TOOLS_DIR?.trim() || join(deps.resourcesPath, "tools");
	if (exists(join(toolsRoot, "bin"))) env.AUTORAG_TOOLS_DIR = toolsRoot;
	for (const name of FORWARDED_ENV) {
		const value = deps.env[name]?.trim() ?? "";
		if (value.length > 0) env[name] = value;
	}
	return {
		available: node !== undefined && exists(deps.entryPath),
		platform: deps.platform === "darwin" || deps.platform === "win32" ? deps.platform : "linux",
		command: node ?? "node",
		args: [deps.entryPath],
		env,
	};
}
