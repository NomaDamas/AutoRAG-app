import { describe, expect, it } from "vitest";
import { MCP_CLIENT_IDS, MCP_READ_ONLY_ENV, MCP_SERVER_NAME, clientSnippet, envLines, shellQuote, withReadOnly, type McpLaunch } from "../src/shared/mcp-connect";

const RESOURCES = "/Applications/Dazzi.app/Contents/Resources";
const NODE = `${RESOURCES}/tools/node/bin/node`;
const ENTRY = `${RESOURCES}/app/out/main/mcp-server.js`;
const TOOLS_ENV = `AUTORAG_TOOLS_DIR=${RESOURCES}/tools`;

const MAC: McpLaunch = { command: NODE, args: [ENTRY], env: { AUTORAG_TOOLS_DIR: `${RESOURCES}/tools` } };

const WIN: McpLaunch = {
	command: "C:\\Users\\Kim Min\\AppData\\Local\\Programs\\Dazzi\\resources\\tools\\node\\node.exe",
	args: ["C:\\Users\\Kim Min\\AppData\\Local\\Programs\\Dazzi\\resources\\app\\out\\main\\mcp-server.js"],
	env: { AUTORAG_TOOLS_DIR: "C:\\Users\\Kim Min\\AppData\\Local\\Programs\\Dazzi\\resources\\tools" },
};

describe("shellQuote", () => {
	it("leaves a plain word alone", () => {
		expect(shellQuote(NODE, "darwin")).toBe(NODE);
		expect(shellQuote("NAME=value", "darwin")).toBe("NAME=value");
	});

	it("wraps a POSIX word that holds a space or a quote so the shell reads it back as one word", () => {
		expect(shellQuote("/Users/a b/c.json", "darwin")).toBe("'/Users/a b/c.json'");
		expect(shellQuote("it's here", "linux")).toBe("'it'\\''s here'");
		expect(shellQuote("", "darwin")).toBe("''");
	});

	it("double-quotes a Windows word with a space and keeps its backslashes", () => {
		expect(shellQuote("C:\\Program Files\\Dazzi\\node.exe", "win32")).toBe('"C:\\Program Files\\Dazzi\\node.exe"');
		expect(shellQuote("C:\\Dazzi\\node.exe", "win32")).toBe("C:\\Dazzi\\node.exe");
	});
});

describe("withReadOnly", () => {
	it("adds the server's read-only switch after the existing environment", () => {
		expect(withReadOnly(MAC, true).env).toEqual({ AUTORAG_TOOLS_DIR: `${RESOURCES}/tools`, [MCP_READ_ONLY_ENV]: "1" });
		expect(Object.keys(withReadOnly(MAC, true).env)).toEqual(["AUTORAG_TOOLS_DIR", MCP_READ_ONLY_ENV]);
	});

	it("returns the launch unchanged when read-only is off, and never mutates its input", () => {
		expect(withReadOnly(MAC, false)).toEqual(MAC);
		withReadOnly(MAC, true);
		expect(MAC.env).toEqual({ AUTORAG_TOOLS_DIR: `${RESOURCES}/tools` });
	});
});

describe("clientSnippet", () => {
	it("Claude Code: registers for the user, the name before the options, the program after `--`", () => {
		expect(clientSnippet("claude", MAC, "darwin")).toBe(`claude mcp add --scope user ${MCP_SERVER_NAME} -e ${TOOLS_ENV} -- ${NODE} ${ENTRY}`);
	});

	it("Codex: one `--env` per variable, the program after `--`", () => {
		expect(clientSnippet("codex", withReadOnly(MAC, true), "darwin")).toBe(`codex mcp add ${MCP_SERVER_NAME} --env ${TOOLS_ENV} --env ${MCP_READ_ONLY_ENV}=1 -- ${NODE} ${ENTRY}`);
	});

	it("Gemini CLI: the options first, then the name, the program and its arguments", () => {
		expect(clientSnippet("gemini", MAC, "darwin")).toBe(`gemini mcp add --scope user -e ${TOOLS_ENV} ${MCP_SERVER_NAME} ${NODE} ${ENTRY}`);
	});

	it("has no environment flags at all when the launch needs none (development)", () => {
		const bare: McpLaunch = { command: "/opt/homebrew/bin/node", args: ["/repo/out/main/mcp-server.js"], env: {} };
		expect(clientSnippet("claude", bare, "darwin")).toBe(`claude mcp add --scope user ${MCP_SERVER_NAME} -- /opt/homebrew/bin/node /repo/out/main/mcp-server.js`);
		expect(clientSnippet("codex", bare, "darwin")).toBe(`codex mcp add ${MCP_SERVER_NAME} -- /opt/homebrew/bin/node /repo/out/main/mcp-server.js`);
		expect(clientSnippet("gemini", bare, "darwin")).toBe(`gemini mcp add --scope user ${MCP_SERVER_NAME} /opt/homebrew/bin/node /repo/out/main/mcp-server.js`);
	});

	it("quotes what holds a space, per platform, in every command line", () => {
		const posix: McpLaunch = { command: "/Volumes/My Disk/Dazzi.app/Contents/Resources/tools/node/bin/node", args: ["/Volumes/My Disk/x/mcp-server.js"], env: { AUTORAG_CONFIG: "/Users/a b/config.json" } };
		for (const client of ["claude", "codex", "gemini"] as const) {
			const line = clientSnippet(client, posix, "darwin");
			expect(line).toContain("'/Volumes/My Disk/Dazzi.app/Contents/Resources/tools/node/bin/node'");
			expect(line).toContain("'/Volumes/My Disk/x/mcp-server.js'");
			expect(line).toContain("'AUTORAG_CONFIG=/Users/a b/config.json'");
		}
		const windows = clientSnippet("claude", WIN, "win32");
		expect(windows).toContain(`"${WIN.command}" "${WIN.args[0]}"`);
		expect(windows).toContain(`-e "AUTORAG_TOOLS_DIR=${WIN.env.AUTORAG_TOOLS_DIR}"`);
	});

	it("JSON: the standard `mcpServers` entry that parses back to exactly the launch", () => {
		const text = clientSnippet("json", withReadOnly(WIN, true), "win32");
		expect(JSON.parse(text)).toEqual({
			mcpServers: { [MCP_SERVER_NAME]: { command: WIN.command, args: WIN.args, env: { ...WIN.env, [MCP_READ_ONLY_ENV]: "1" } } },
		});
	});

	it("JSON: omits `env` when the launch has none", () => {
		const parsed = JSON.parse(clientSnippet("json", { command: "dazzi-mcp", args: [], env: {} }, "darwin")) as { mcpServers: Record<string, Record<string, unknown>> };
		expect(parsed.mcpServers[MCP_SERVER_NAME]).toEqual({ command: "dazzi-mcp", args: [] });
	});

	it("covers every client the page offers", () => {
		for (const client of MCP_CLIENT_IDS) expect(clientSnippet(client, MAC, "darwin").length).toBeGreaterThan(0);
	});
});

describe("envLines", () => {
	it("is NAME=value per line, in order, and empty with no environment", () => {
		expect(envLines(withReadOnly(MAC, true))).toBe(`${TOOLS_ENV}\n${MCP_READ_ONLY_ENV}=1`);
		expect(envLines({ command: "x", args: [], env: {} })).toBe("");
	});
});
