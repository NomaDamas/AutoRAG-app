/**
 * The command lines Settings → MCP → "Connect other agents" hands out, run against the real agent programs.
 *
 * No window: it builds each line with the same function the page uses (`src/shared/mcp-connect.ts`), pastes it into a
 * shell exactly as a user would, in a throwaway HOME so no real agent configuration is touched, and then asks the
 * agent itself whether it can use the server:
 *
 *   - Claude Code: `claude mcp list` starts the server and reports "Connected";
 *   - Gemini CLI: the same through `gemini mcp list` (it also refuses some environment variables, so a probe server
 *     that records what it was started with proves every variable of the snippet arrives);
 *   - Codex: has no health check without a model, so `codex mcp get --json` must show the program, the arguments and
 *     the variables as registered.
 *
 * Agents that are not installed are skipped, loudly. Prerequisite: `bun run build`. Run: `bun scripts/manual-qa/run-qa-mcp-clients.mjs`.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ROOT } from "./launch-finder.mjs";
import { clientSnippet, withReadOnly } from "../../src/shared/mcp-connect.ts";

const fails = [];
const check = (name, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
	if (!ok) fails.push(name);
};
const skip = (name, why) => console.log(`SKIP ${name} — ${why}`);

if (process.platform === "win32") {
	skip("all agents", "the lines are POSIX shell; Windows quoting is covered by unit tests");
	process.exit(0);
}

const onPath = (program) => (process.env.PATH ?? "").split(delimiter).some((dir) => dir.length > 0 && existsSync(join(dir, program)));
const node = execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim();
const entry = join(ROOT, "out", "main", "mcp-server.js");
if (!existsSync(entry)) throw new Error("out/main/mcp-server.js is missing — run `bun run build` first");

const root = mkdtempSync(join(tmpdir(), "autorag-qa-clients-"));
const docs = join(root, "docs");
mkdirSync(docs, { recursive: true });
writeFileSync(join(docs, "note.md"), "# note\n");
const configPath = join(root, "config.json");
writeFileSync(configPath, `${JSON.stringify({ searchPaths: [docs], workspacePath: join(root, "workspace"), appIndexing: { semanticSearch: false } })}\n`);

/** The environment a packaged install would hand over: where its tools are, and which AutoRAG config to read. */
const toolsDir = join(ROOT, "build", "stage", `${process.platform}-${process.arch}`, "tools");
const launchEnv = { AUTORAG_HOME: root, AUTORAG_CONFIG: configPath, ...(existsSync(join(toolsDir, "bin")) ? { AUTORAG_TOOLS_DIR: toolsDir } : {}) };

// A server that records its environment and then speaks just enough MCP to be called "connected".
const probe = join(root, "probe.mjs");
const record = join(root, "probe-env.json");
writeFileSync(
	probe,
	`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.env));
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (let end = buffer.indexOf("\\n"); end >= 0; end = buffer.indexOf("\\n")) {
		const line = buffer.slice(0, end).trim();
		buffer = buffer.slice(end + 1);
		if (line.length === 0) continue;
		const message = JSON.parse(line);
		if (message.id === undefined) continue;
		const result = message.method === "initialize" ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "probe", version: "0" } } : message.method === "tools/list" ? { tools: [] } : {};
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
	}
});
`,
);

/** A fresh HOME (and CODEX_HOME) with a project folder to stand in; returns how to run things in it. */
function sandbox(name) {
	const home = join(root, name);
	mkdirSync(join(home, "project"), { recursive: true });
	mkdirSync(join(home, "codex"), { recursive: true });
	const base = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, "codex"), GEMINI_CLI_TRUST_WORKSPACE: "true" };
	return {
		home,
		run: (command, extraEnv = {}) => spawnSync(command, { shell: true, cwd: join(home, "project"), env: { ...base, ...extraEnv }, encoding: "utf8", timeout: 120_000 }),
	};
}

const delivered = () => (existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) : null);

/** The two servers each agent is pointed at: a probe that records what it was started with, and the real one. */
const SERVERS = [
	{ label: "probe", launch: { command: node, args: [probe], env: withReadOnly({ command: node, args: [], env: launchEnv }, true).env } },
	{ label: "the real server", launch: { command: node, args: [entry], env: launchEnv } },
];

async function claude() {
	if (!onPath("claude")) return skip("Claude Code", "`claude` is not installed");
	for (const { label, launch } of SERVERS) {
		const box = sandbox(`claude-${label.replaceAll(" ", "-")}`);
		rmSync(record, { force: true });
		const line = clientSnippet("claude", launch, process.platform);
		const added = box.run(line);
		check(`Claude Code (${label}): the pasted line is accepted`, added.status === 0, (added.stdout + added.stderr).trim().split("\n")[0]);
		const listed = box.run("claude mcp list");
		check(`Claude Code (${label}): reports it Connected`, /dazzi:.*Connected/u.test(listed.stdout), listed.stdout.trim().split("\n").at(-1));
		if (label === "probe") {
			const seen = delivered();
			check("Claude Code: every variable of the line reaches the server", seen !== null && Object.entries(launch.env).every(([name, value]) => seen[name] === value), JSON.stringify(seen === null ? null : Object.keys(seen).filter((name) => name.startsWith("AUTORAG_"))));
		}
	}
}

async function gemini() {
	if (!onPath("gemini")) return skip("Gemini CLI", "`gemini` is not installed");
	for (const { label, launch } of SERVERS) {
		const box = sandbox(`gemini-${label.replaceAll(" ", "-")}`);
		rmSync(record, { force: true });
		const line = clientSnippet("gemini", launch, process.platform);
		const added = box.run(line);
		check(`Gemini CLI (${label}): the pasted line is accepted`, added.status === 0, (added.stdout + added.stderr).trim().split("\n").at(-1));
		const listed = box.run("gemini mcp list");
		const output = listed.stdout + listed.stderr;
		check(`Gemini CLI (${label}): reports it Connected`, /dazzi:.*Connected/u.test(output), output.trim().split("\n").at(-1));
		check(`Gemini CLI (${label}): blocks none of the variables`, !/Blocked dangerous environment variable/u.test(output), output.match(/Blocked[^\n]*/u)?.[0]);
		if (label === "probe") {
			const seen = delivered();
			check("Gemini CLI: every variable of the line reaches the server", seen !== null && Object.entries(launch.env).every(([name, value]) => seen[name] === value), JSON.stringify(seen === null ? null : Object.keys(seen).filter((name) => name.startsWith("AUTORAG_"))));
		}
	}
}

async function codex() {
	if (!onPath("codex")) return skip("Codex", "`codex` is not installed");
	const launch = { command: node, args: [entry], env: withReadOnly({ command: node, args: [], env: launchEnv }, true).env };
	const box = sandbox("codex");
	const added = box.run(clientSnippet("codex", launch, process.platform));
	check("Codex: the pasted line is accepted", added.status === 0, (added.stdout + added.stderr).trim().split("\n")[0]);
	const got = box.run("codex mcp get dazzi --json");
	let registered = null;
	try {
		registered = JSON.parse(got.stdout).transport;
	} catch {
		registered = null;
	}
	check("Codex: registers the program and its arguments", registered?.command === node && JSON.stringify(registered?.args) === JSON.stringify(launch.args), JSON.stringify(registered)?.slice(0, 160));
	check("Codex: registers every variable", registered !== null && Object.entries(launch.env).every(([name, value]) => registered.env?.[name] === value), JSON.stringify(registered?.env));
}

try {
	await claude();
	await gemini();
	await codex();
} finally {
	rmSync(root, { recursive: true, force: true });
}

if (fails.length > 0) {
	console.log("FAIL:", fails);
	process.exitCode = 1;
} else {
	console.log("PASS: the command lines work in the agents that are installed");
}
