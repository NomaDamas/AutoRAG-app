import { createServer, type Server } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentOptions, resolveConfigReadOnly } from "@autorag/librarian";
import { afterEach, describe, expect, it } from "vitest";
import { createAutoRagConfigService } from "../src/main/autorag-config-service";
import { createDataSourceStatusService } from "../src/main/datasource-status";
import { withIndexingPoliciesApplied } from "../src/main/indexing-policy";
import { withSemanticPolicyApplied } from "../src/main/semantic-policy";
import type { DataSourceRow } from "../src/shared/settings-contract";

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
				}),
		),
	);
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface Fixture {
	readonly root: string;
	readonly workspace: string;
	readonly bin: string;
	readonly agentDir: string;
	readonly configPath: string;
	readonly env: NodeJS.ProcessEnv;
}

async function createFixture(): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "autorag-hister-calendar-"));
	directories.push(root);
	const workspace = join(root, "workspace");
	const bin = join(root, "bin");
	const agentDir = join(root, "pi-agent");
	await mkdir(join(workspace, "docs"), { recursive: true });
	await mkdir(bin, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	for (const name of ["hister", "npx"]) {
		const target = join(bin, process.platform === "win32" ? `${name}.cmd` : name);
		await writeFile(target, process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
		await chmod(target, 0o755);
	}
	const configPath = join(root, "config.json");
	await writeFile(
		configPath,
		`${JSON.stringify(
			{
				searchPaths: [join(workspace, "docs")],
				workspacePath: workspace,
				memoryPath: join(workspace, "memory.json"),
			},
			null,
			2,
		)}\n`,
	);
	const pathValue =
		process.platform === "win32"
			? `${bin};${process.env.SystemRoot ?? "C:\\Windows"}\\System32`
			: `${bin}:/usr/bin:/bin`;
	return {
		root,
		workspace,
		bin,
		agentDir,
		configPath,
		env: {
			HOME: root,
			PATH: pathValue,
			 ...(process.platform === "win32" ? { PATHEXT: ".COM;.EXE;.BAT;.CMD" } : {}),
			AUTORAG_CONFIG: configPath,
			PI_CODING_AGENT_DIR: agentDir,
		},
	};
}

async function startHisterServer(options: {
	readonly webCount: number;
	readonly authenticated?: boolean;
	readonly expectedToken?: string;
}): Promise<string> {
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const token = req.headers["x-access-token"];
		const authed =
			options.expectedToken !== undefined
				? token === options.expectedToken
				: options.authenticated !== false;
		res.setHeader("content-type", "application/json");
		if (url.pathname === "/api/config") {
			res.writeHead(200);
			res.end(
				JSON.stringify({
					authenticated: authed,
					auth_mode: options.expectedToken !== undefined ? "token" : "none",
					semantic_enabled: true,
				}),
			);
			return;
		}
		if (url.pathname === "/search") {
			if (!authed) {
				res.writeHead(401);
				res.end(JSON.stringify({ error: "unauthorized" }));
				return;
			}
			const rawQuery = url.searchParams.get("query");
			const parsedQuery = rawQuery !== null ? (JSON.parse(rawQuery) as { text?: string }) : {};
			const query = parsedQuery.text ?? url.searchParams.get("q") ?? "";
			const isWeb = query.includes("type:web") && !query.includes("-type:web");
			const total = isWeb ? options.webCount : 0;
			const docs = Array.from({ length: total }, (_, idx) => ({
				url: `https://example.com/page-${idx + 1}`,
				domain: "example.com",
				title: `Page ${idx + 1}`,
				text: `Captured page text ${idx + 1}`,
				doc_type: 0,
				score: 1,
				updated: 1_760_000_000_000,
			}));
			res.writeHead(200);
			res.end(JSON.stringify({ total, documents: docs, semantic_enabled: true }));
			return;
		}
		res.writeHead(404);
		res.end(JSON.stringify({ error: "not found" }));
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("unexpected server address");
	return `http://127.0.0.1:${address.port}`;
}

function byId(rows: readonly DataSourceRow[], id: string): DataSourceRow {
	const row = rows.find((item) => item.id === id);
	if (row === undefined) throw new Error(`missing datasource row ${id}`);
	return row;
}

describe("Hister datasource config, status, and keyword-only policy", () => {
	it("validates hister connector fields and enforces https when tokenEnv targets a non-loopback host", async () => {
		const fixture = await createFixture();
		const config = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });

		const snapshot = await config.set(["datasources", "hister"], {
			type: "hister",
			connector: {
				baseUrl: "http://127.0.0.1:4433",
				tokenEnv: "HISTER_TOKEN",
				semantic: true,
				timeoutMs: 15000,
			},
		});
		expect(snapshot.error).toBeNull();

		await expect(
			config.set(["datasources", "hister", "connector", "semantic"], "yes"),
		).rejects.toThrow(/semantic must be a boolean/);
		await expect(
			config.set(["datasources", "hister", "connector", "baseUrl"], "not-a-url"),
		).rejects.toThrow(/http\(s\) URL/);
		await expect(
			config.set(["datasources", "hister", "connector"], {
				baseUrl: "http://history.example.com:4433",
				tokenEnv: "HISTER_TOKEN",
			}),
		).rejects.toThrow(/https/);

		const httpsRemote = await config.set(["datasources", "hister", "connector"], {
			baseUrl: "https://history.example.com:4433",
			tokenEnv: "HISTER_TOKEN",
			semantic: false,
		});
		expect(httpsRemote.error).toBeNull();
	});

	it("probes a running Hister server for indexed web-page counts and syncs through HisterSkill", async () => {
		const fixture = await createFixture();
		const baseUrl = await startHisterServer({ webCount: 3 });
		const config = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });
		await config.set(["datasources", "browser"], {
			type: "hister",
			description: "Visited web pages",
			connector: { baseUrl, semantic: true },
		});

		const status = createDataSourceStatusService({ env: fixture.env, cwd: fixture.root });
		const listed = await status.list();
		const row = byId(listed.sources, "browser");
		expect(row.install.state).toBe("installed");
		expect(row.agent).toMatchObject({ state: "connected", skillName: "datasource-browser" });
		expect(row.index).toMatchObject({ state: "indexed", chunkCount: 3, unit: "document" });
		expect(row.status).toBe("ready");

		const synced = await status.sync("browser");
		expect(synced).toMatchObject({ id: "browser", ok: true, state: "indexed", chunkCount: 3 });
	});

	it("reports credential-missing when Hister tokenEnv is configured but missing in env", async () => {
		const fixture = await createFixture();
		const baseUrl = await startHisterServer({ webCount: 2, expectedToken: "secret-token" });
		const config = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });
		await config.set(["datasources", "hister"], {
			connector: { baseUrl, tokenEnv: "HISTER_TOKEN" },
		});

		const status = createDataSourceStatusService({ env: fixture.env, cwd: fixture.root });
		const [missingToken] = (await status.list()).sources;
		expect(missingToken?.install.state).toBe("credential-missing");
		expect(missingToken?.status).toBe("attention");

		fixture.env.HISTER_TOKEN = "secret-token";
		const [withToken] = (await status.list()).sources;
		expect(withToken?.install.state).toBe("installed");
		expect(withToken?.index).toMatchObject({ state: "indexed", chunkCount: 2 });
		expect(withToken?.status).toBe("ready");
	});

	it("turns off Hister semantic search in keyword-only mode", () => {
		const effective = withSemanticPolicyApplied(
			{
				searchPaths: ["/docs"],
				workspacePath: "/ws",
				memoryPath: "/ws/memory.json",
				datasources: {
					browser: { type: "hister", connector: { baseUrl: "http://127.0.0.1:4433", semantic: true } },
					hister: { connector: { semantic: true } },
				},
			},
			false,
		);
		expect(effective.datasources?.browser).toEqual({
			type: "hister",
			connector: { baseUrl: "http://127.0.0.1:4433", semantic: false },
		});
		expect(effective.datasources?.hister).toEqual({
			connector: { semantic: false },
		});
	});
});

describe("Calendar integration settings and MCP server synchronization", () => {
	it("writes and updates <piAgentDir>/mcp.json when connecting, configuring, disabling, and removing calendar", async () => {
		const fixture = await createFixture();
		const mcpPath = join(fixture.agentDir, "mcp.json");
		await writeFile(
			mcpPath,
			JSON.stringify({
				mcpServers: {
					filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] },
				},
			}),
		);

		const config = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });
		const status = createDataSourceStatusService({ env: fixture.env, cwd: fixture.root });

		await config.set(["datasources", "calendar"], {
			type: "calendar",
			description: "Work & personal events",
			connector: {
				requireWriteConfirmation: true,
				exposure: "direct",
			},
		});

		const readMcp = async () => JSON.parse(await readFile(mcpPath, "utf8")) as { mcpServers: Record<string, unknown> };
		expect((await readMcp()).mcpServers).toEqual({
			filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] },
			"apple-events": {
				command: "npx",
				args: ["-y", "mcp-server-apple-events", "--require-write-confirmation"],
				description: "Work & personal events",
				exposure: "direct",
			},
		});

		const listed = await status.list();
		const row = byId(listed.sources, "calendar");
		expect(row.install.state).toBe("installed");
		expect(row.agent).toMatchObject({ state: "connected", skillName: "mcp-apple-events" });
		expect(row.index).toMatchObject({ state: "live", chunkCount: null });
		expect(row.status).toBe("ready");

		await status.setEnabled("calendar", false);
		expect((await readMcp()).mcpServers["apple-events"]).toMatchObject({
			command: "npx",
			enabled: false,
		});
		expect(byId((await status.list()).sources, "calendar").status).toBe("paused");

		await status.setEnabled("calendar", true);
		await config.set(["datasources", "calendar", "connector", "requireWriteConfirmation"], false);
		expect((await readMcp()).mcpServers["apple-events"]).toEqual({
			command: "npx",
			args: ["-y", "mcp-server-apple-events"],
			description: "Work & personal events",
			exposure: "direct",
		});

		// Stripped from the librarian's datasource skill builder so no unknown-datasource-skill diagnostic is emitted.
		const resolved = withIndexingPoliciesApplied(
			resolveConfigReadOnly({ flags: {}, env: fixture.env, cwd: fixture.root }),
		);
		const agentOpts = buildAgentOptions(resolved);
		expect(agentOpts.startupDiagnostics ?? []).toEqual([]);

		await config.remove(["datasources", "calendar"]);
		expect((await readMcp()).mcpServers).toEqual({
			filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] },
		});
	});

	it("validates calendar connector options", async () => {
		const fixture = await createFixture();
		const config = createAutoRagConfigService({ env: fixture.env, cwd: fixture.root });

		await expect(
			config.set(["datasources", "calendar"], {
				type: "calendar",
				connector: { exposure: "invalid-mode" },
			}),
		).rejects.toThrow(/exposure must be one of/);

		await expect(
			config.set(["datasources", "calendar"], {
				type: "calendar",
				connector: { requireWriteConfirmation: "yes" },
			}),
		).rejects.toThrow(/requireWriteConfirmation must be a boolean/);
	});
});
