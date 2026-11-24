import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutoRAGLite, createAutoRAGMcpServer } from "@autorag/librarian";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataSourceStatusService } from "../src/main/datasource-status";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	vi.unstubAllEnvs();
});

/** The fake's own marker: a hit that carries it came from the fake `wombat`, never from a real session store. */
const FAKE_MARKER = "FAKE-WOMBAT-SESSION";
const HIT = {
	chunk_id: "chunk-abc",
	snippet: "we decided to cut the patch release from main after CI is green",
	score: 0.91,
	agent: "claude-code",
	session_id: "sess-1",
	catalog_key: "claude-code:sess-1",
	title: FAKE_MARKER,
	cwd: "/work/app",
	start_turn: 3,
	end_turn: 4,
	started_at: "2026-10-22T12:06:50Z",
};

/** A fake `wombat` on PATH: doctor, sync and search answer the way the real CLI's JSON does. */
async function fixture(datasources: Record<string, unknown>, options: { readonly refresh?: boolean } = {}): Promise<{ client: Client; root: string }> {
	const root = await mkdtemp(join(tmpdir(), "autorag-wombat-mcp-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const bin = join(root, "bin");
	await mkdir(bin, { recursive: true });
	await writeFile(
		join(bin, "wombat"),
		`#!/bin/sh
case "$*" in
  *doctor*) echo '{"ready":true,"freshness":{"indexed_sessions":1,"indexed_turns":4}}' ;;
  *sync*) echo '{"ok":true,"total_sessions":1,"total_messages":4,"failed":0,"indexed":{"ok":true,"chunkCount":1}}' ;;
  *search*) echo '${JSON.stringify([HIT])}' ;;
  *) echo '{}' ;;
esac
`,
	);
	await chmod(join(bin, "wombat"), 0o755);
	const configPath = join(root, "config.json");
	await mkdir(join(root, "docs"), { recursive: true });
	await writeFile(configPath, JSON.stringify({ searchPaths: [join(root, "docs")], workspacePath: join(root, "ws"), datasources }));
	// The librarian's CLI clients build their child's environment from `process.env`, not from the `env` handed to a
	// service, so the isolation must be in the process itself: a test that only passed `env` ran the real `wombat`
	// against the real `~/.wombat`. The system directories stay on PATH for `sh`; no `.cargo/bin`, so no real wombat.
	const env = { HOME: root, PATH: `${bin}:/usr/bin:/bin`, AUTORAG_CONFIG: configPath, AUTORAG_HOME: root, WOMBAT_DATA_DIR: join(root, "wombat-data") };
	for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
	// The app indexes a datasource through its own status service; the read-only MCP server then searches that index.
	if (options.refresh === true) {
		const synced = await createDataSourceStatusService({ env, cwd: root }).sync(Object.keys(datasources)[0] ?? "wombat");
		expect(synced).toMatchObject({ ok: true });
		// The server answers only once the app's full refresh has marked the workspace ready (the local index is empty here).
		await mkdir(join(root, "ws", ".autorag"), { recursive: true });
		await writeFile(join(root, "ws", ".autorag", "refresh-complete.json"), JSON.stringify({ version: 1, completed: true, parsed: true }));
	}
	const lite = createAutoRAGLite({ env, cwd: root, readOnly: true });
	const server = createAutoRAGMcpServer(lite, { readOnly: true });
	const client = new Client({ name: "wombat-mcp-test", version: "1.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	cleanup.push(async () => {
		await client.close();
		await server.close();
	});
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	return { client, root };
}

function json(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
	const text = result.content.find((item) => item.type === "text");
	if (text?.type !== "text") throw new Error("no text content");
	return JSON.parse(text.text) as Record<string, unknown>;
}

describe("AI Sessions through the MCP server the app ships", () => {
	it("lists the connection and gives it a dedicated search tool", async () => {
		const { client } = await fixture({ wombat: {} });
		const listed = json(await client.callTool({ name: "autorag.datasources.list", arguments: {} }));
		const ids = (listed.datasources as { datasourceId: string }[]).map((entry) => entry.datasourceId);
		expect(ids).toEqual(["wombat"]);
		const tools = (await client.listTools()).tools.map((tool) => tool.name);
		expect(tools).toContain("autorag.search_datasource_wombat");
	});

	it("answers a search with session-labelled hits whose source is an opaque /wombat chunk path", async () => {
		const { client } = await fixture({ wombat: {} }, { refresh: true });
		const answer = json(await client.callTool({ name: "autorag.search_datasource_wombat", arguments: { query: "how do we cut a patch release" } }));
		const results = answer.results as { source: string; content: string; metadata: Record<string, unknown> }[];
		expect(results).toHaveLength(1);
		expect(results[0]?.source).toBe("/wombat/default/chunks/chunk-abc");
		expect(results[0]?.metadata.title).toBe(FAKE_MARKER);
		expect(results[0]?.content.split("\n")[0]).toContain("claude-code:sess-1");
		expect(results[0]?.metadata).toMatchObject({ sessionKey: "claude-code:sess-1", agent: "claude-code" });
		expect(JSON.stringify(answer)).not.toContain("/work/app/.claude");
	});

	it("is selectable by datasourceIds under a connection alias, whose id then roots its sources", async () => {
		const { client } = await fixture({ "ai-sessions": { type: "wombat" } }, { refresh: true });
		const ids = (json(await client.callTool({ name: "autorag.datasources.list", arguments: {} })).datasources as { datasourceId: string }[]).map((entry) => entry.datasourceId);
		expect(ids).toEqual(["ai-sessions"]);
		const answer = json(await client.callTool({ name: "autorag.search", arguments: { query: "patch release", datasourceIds: ["ai-sessions"], local: false } }));
		expect((answer.results as { source: string }[]).map((entry) => entry.source)).toEqual(["/ai-sessions/ai-sessions/chunks/chunk-abc"]);
	});

	it("exposes nothing for a disabled connection", async () => {
		const { client } = await fixture({ wombat: { enabled: false } });
		const listed = json(await client.callTool({ name: "autorag.datasources.list", arguments: {} }));
		expect(listed.datasources).toEqual([]);
		expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("autorag.search_datasource_wombat");
	});
});
