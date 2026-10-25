import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMcpConnectInfo, type McpConnectDeps } from "../src/main/mcp-connect-info";

const RESOURCES = join("/Applications", "Dazzi.app", "Contents", "Resources");
const TOOLS = join(RESOURCES, "tools");
const NODE = join(TOOLS, "node", "bin", "node");
const ENTRY = join(RESOURCES, "app", "out", "main", "mcp-server.js");

/** A packaged install: the entry and the bundled tools exist, and the bundled Node is the one found. */
const packaged: McpConnectDeps = {
	resourcesPath: RESOURCES,
	entryPath: ENTRY,
	env: {},
	platform: "darwin",
	exists: (path) => path === ENTRY || path === join(TOOLS, "bin"),
	findNode: () => NODE,
};

describe("resolveMcpConnectInfo", () => {
	it("starts the server on the install's own Node and names the bundled tools, so the agent needs no PATH", () => {
		expect(resolveMcpConnectInfo(packaged)).toEqual({
			available: true,
			platform: "darwin",
			command: NODE,
			args: [ENTRY],
			env: { AUTORAG_TOOLS_DIR: TOOLS },
		});
	});

	it("needs no environment in development, where the tools come from the user's PATH", () => {
		const info = resolveMcpConnectInfo({ ...packaged, exists: (path) => path === ENTRY, findNode: () => "/opt/homebrew/bin/node" });
		expect(info.command).toBe("/opt/homebrew/bin/node");
		expect(info.env).toEqual({});
		expect(info.available).toBe(true);
	});

	it("hands the server the AutoRAG home and config the app itself resolves, so both read the same index", () => {
		const info = resolveMcpConnectInfo({ ...packaged, env: { AUTORAG_HOME: "/data/autorag", AUTORAG_CONFIG: "/data/autorag/other.json", HOME: "/Users/a", PATH: "/usr/bin" } });
		expect(info.env).toEqual({ AUTORAG_TOOLS_DIR: TOOLS, AUTORAG_HOME: "/data/autorag", AUTORAG_CONFIG: "/data/autorag/other.json" });
	});

	it("ignores blank overrides instead of writing an empty variable an agent would pass on", () => {
		expect(resolveMcpConnectInfo({ ...packaged, env: { AUTORAG_HOME: "  ", AUTORAG_CONFIG: "" } }).env).toEqual({ AUTORAG_TOOLS_DIR: TOOLS });
	});

	it("follows a tools directory the app was told to use", () => {
		const custom = join("/qa", "tools");
		const info = resolveMcpConnectInfo({ ...packaged, env: { AUTORAG_TOOLS_DIR: custom }, exists: (path) => path === ENTRY || path === join(custom, "bin") });
		expect(info.env).toEqual({ AUTORAG_TOOLS_DIR: custom });
	});

	it("is unavailable, not wrong, when this build has no server entry", () => {
		expect(resolveMcpConnectInfo({ ...packaged, exists: (path) => path !== ENTRY }).available).toBe(false);
	});

	it("is unavailable when no Node can be found to run it", () => {
		expect(resolveMcpConnectInfo({ ...packaged, findNode: () => undefined }).available).toBe(false);
	});

	it("reports the platform the paste targets, folding anything that is not macOS or Windows into linux", () => {
		expect(resolveMcpConnectInfo({ ...packaged, platform: "win32" }).platform).toBe("win32");
		expect(resolveMcpConnectInfo({ ...packaged, platform: "freebsd" }).platform).toBe("linux");
	});
});
