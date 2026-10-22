import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentOptions, resolveConfigReadOnly, saveMirrorIndex, type ParsedMirrorEntry as MirrorEntry } from "@autorag/librarian";
import { MailcrawlClient } from "@autorag/librarian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataSourceStatusService } from "../src/main/datasource-status";
import type { DataSourceRow } from "../src/shared/settings-contract";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface Fixture {
	readonly root: string;
	readonly workspace: string;
	readonly configPath: string;
	readonly env: NodeJS.ProcessEnv;
}

async function createFixtureWithOnlySlacrawlOnPath(): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "autorag-datasource-status-"));
	directories.push(root);
	const workspace = join(root, "workspace");
	const bin = join(root, "bin");
	await mkdir(join(workspace, "docs"), { recursive: true });
	await mkdir(bin, { recursive: true });
	await writeFile(join(bin, "slacrawl"), "#!/bin/sh\nexit 0\n");
	await chmod(join(bin, "slacrawl"), 0o755);
	const configPath = join(root, "config.json");
	return { root, workspace, configPath, env: { HOME: root, PATH: bin, AUTORAG_CONFIG: configPath } };
}

async function writeConfig(fixture: Fixture, datasources: Record<string, unknown>): Promise<void> {
	await writeFile(
		fixture.configPath,
		`${JSON.stringify({
			searchPaths: [join(fixture.workspace, "docs")],
			workspacePath: fixture.workspace,
			datasources,
		}, null, 2)}\n`,
	);
}

const MIXED_DATASOURCES = {
	slack: {},
	"my-drive": { type: "cloud-drive", connector: { remote: "drive:" } },
	github: { connector: { repos: ["octo/repo"] } },
	telegram: false,
	team: { type: "slack", enabled: false, description: "Team Slack" },
	foo: {},
};

function byId(rows: readonly DataSourceRow[], id: string): DataSourceRow {
	const row = rows.find((candidate) => candidate.id === id);
	if (row === undefined) throw new Error(`missing row ${id}`);
	return row;
}

describe("createDataSourceStatusService", () => {
	it("reports install, agent connection, and index state for every configured datasource", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		await writeConfig(fixture, MIXED_DATASOURCES);
		const chunkStore = join(fixture.workspace, ".autorag", "datasources", "my-drive", "my-drive", "chunks.json");
		await mkdir(join(chunkStore, ".."), { recursive: true });
		await writeFile(chunkStore, JSON.stringify({
			version: 1,
			skill: "my-drive",
			instance: "my-drive",
			updatedAt: Date.UTC(2026, 8, 30, 1, 2, 3),
			chunks: [
				{ chunkId: "c1", docId: "d1", hierarchy: [], content: "one", metadata: {} },
				{ chunkId: "c2", docId: "d1", hierarchy: [], content: "two", metadata: {} },
			],
		}));

		const snapshot = await createDataSourceStatusService({ env: fixture.env, cwd: fixture.root }).list();

		expect(snapshot.error).toBeNull();
		expect(snapshot.configPath).toBe(fixture.configPath);
		expect(snapshot.configExists).toBe(true);
		expect(snapshot.sources.map((row) => row.id)).toEqual(["slack", "my-drive", "github", "telegram", "team", "foo"]);

		const slack = byId(snapshot.sources, "slack");
		expect(slack.install).toMatchObject({ state: "installed", binary: "slacrawl" });
		expect(slack.agent).toMatchObject({ state: "connected", skillName: "datasource-slack" });
		// The fake slacrawl prints nothing parseable: that is "unreadable", never "empty".
		expect(slack.index).toMatchObject({ state: "not-indexed", chunkCount: null, unit: "message" });
		expect(slack.status).toBe("ready");

		const drive = byId(snapshot.sources, "my-drive");
		expect(drive.type).toBe("cloud-drive");
		expect(drive.install).toMatchObject({ state: "missing", binary: "rclone" });
		expect(drive.agent.state).toBe("connected");
		expect(drive.index).toMatchObject({ state: "indexed", chunkCount: 2, indexedAt: "2026-09-30T01:02:03.000Z" });
		expect(drive.status).toBe("attention");

		const github = byId(snapshot.sources, "github");
		expect(github.install).toMatchObject({ state: "credential-missing", binary: null });
		expect(github.agent.state).toBe("connected");
		expect(github.agent.tags).toEqual(["github", "issues"]);
		expect(github.index.state).toBe("not-indexed");
		expect(github.status).toBe("attention");

		const telegram = byId(snapshot.sources, "telegram");
		expect(telegram.enabled).toBe(false);
		expect(telegram.agent.state).toBe("disabled");
		expect(telegram.install).toMatchObject({ state: "missing", binary: "telecrawl" });
		expect(telegram.status).toBe("paused");

		const team = byId(snapshot.sources, "team");
		expect(team).toMatchObject({ enabled: false, type: "slack", description: "Team Slack", status: "paused" });
		expect(team.agent.state).toBe("disabled");

		const foo = byId(snapshot.sources, "foo");
		expect(foo.agent.state).toBe("unsupported");
		expect(foo.install.state).toBe("unsupported");
		expect(foo.status).toBe("attention");
	});

	it("resolves a Windows CLI by its PATHEXT extension", async () => {
		// Given a Windows-style PATH with only slacrawl.cmd (no extensionless file)
		const root = await mkdtemp(join(tmpdir(), "autorag-datasource-pathext-"));
		directories.push(root);
		const workspace = join(root, "workspace");
		const bin = join(root, "bin");
		await mkdir(join(workspace, "docs"), { recursive: true });
		await mkdir(bin, { recursive: true });
		const cli = join(bin, "slacrawl.cmd");
		await writeFile(cli, "@echo off\r\n");
		await chmod(cli, 0o755);
		const configPath = join(root, "config.json");
		const fixture: Fixture = {
			root,
			workspace,
			configPath,
			env: { HOME: root, PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD", AUTORAG_CONFIG: configPath },
		};
		await writeConfig(fixture, { slack: {} });

		// When the status is listed
		const [slack] = (await createDataSourceStatusService({ env: fixture.env, cwd: fixture.root }).list()).sources;

		// Then the installer found the .cmd on PATH instead of reporting it missing.
		// Windows resolves the extension case-insensitively, so compare case-insensitively.
		expect(slack?.install).toMatchObject({ state: "installed", binary: "slacrawl" });
		expect(slack?.install.path?.toLowerCase()).toBe(cli.toLowerCase());
		expect(slack?.status).toBe("ready");
	});

	it("resolves an explicitly extended CLI before appending PATHEXT suffixes", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		const cli = join(fixture.root, "bin", "slacrawl.cmd");
		await writeFile(cli, "@echo off\r\n");
		await chmod(cli, 0o755);
		const windowsFixture: Fixture = {
			...fixture,
			env: { ...fixture.env, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
		};
		await writeConfig(windowsFixture, { slack: { connector: { binaryPath: "slacrawl.cmd" } } });

		const [slack] = (await createDataSourceStatusService({ env: windowsFixture.env, cwd: windowsFixture.root }).list()).sources;

		expect(slack?.install).toMatchObject({ state: "installed", path: cli });
	});

	it("still treats an exact CLI name as executable on POSIX", async () => {
		// Given the existing extensionless script on PATH
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		await writeConfig(fixture, { slack: {} });

		// When the status is listed
		const [slack] = (await createDataSourceStatusService({ env: fixture.env, cwd: fixture.root }).list()).sources;

		// Then it is found without any PATHEXT
		expect(slack?.install).toMatchObject({ state: "installed", path: join(fixture.root, "bin", "slacrawl") });
	});

	it("treats every enabled datasource as connected without any access list", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		await writeConfig(fixture, { slack: {} });

		const snapshot = await createDataSourceStatusService({ env: fixture.env, cwd: fixture.root }).list();

		expect(snapshot.sources[0]?.agent.state).toBe("connected");
		expect(snapshot.sources[0]?.status).toBe("ready");
	});

	it("re-reads the shared config on every list so edits from any AutoRAG surface show up", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		await writeConfig(fixture, { slack: {} });
		const service = createDataSourceStatusService({ env: fixture.env, cwd: fixture.root });
		expect((await service.list()).sources.map((row) => row.id)).toEqual(["slack"]);

		await writeConfig(fixture, { slack: { enabled: false }, rss: { connector: { feeds: [] } } });

		const rows = (await service.list()).sources;
		expect(rows.map((row) => row.id)).toEqual(["slack", "rss"]);
		expect(byId(rows, "slack").status).toBe("paused");
		expect(byId(rows, "rss").install.state).toBe("builtin");
	});

	it("writes the toggle into the shared config so every AutoRAG agent sees it", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		await writeConfig(fixture, { slack: { description: "Team" }, telegram: false });
		const service = createDataSourceStatusService({ env: fixture.env, cwd: fixture.root });

		await service.setEnabled("slack", false);
		await service.setEnabled("telegram", true);

		const onDisk = JSON.parse(await readFile(fixture.configPath, "utf8")) as Record<string, any>;
		expect(onDisk.datasources).toEqual({ slack: { description: "Team", enabled: false }, telegram: true });
		const agentSkills = buildAgentOptions(resolveConfigReadOnly({ flags: {}, env: fixture.env, cwd: fixture.root }))
			.datasourceSkills?.map((skill) => skill.describe().name);
		expect(agentSkills).toEqual(["telegram"]);
		await expect(service.setEnabled("missing", true)).rejects.toThrow("Unknown datasource: missing");
	});

	it("saves an edited description into the shared config that the agent reads", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		await writeConfig(fixture, { slack: { description: "Old", tags: ["chat"] }, telegram: false, whatsapp: true });
		const service = createDataSourceStatusService({ env: fixture.env, cwd: fixture.root });

		await service.setDescription("slack", "  Team Slack for release talk  ");
		await service.setDescription("telegram", "Family chats");
		await service.setDescription("whatsapp", "Friends");

		const onDisk = JSON.parse(await readFile(fixture.configPath, "utf8")) as Record<string, any>;
		expect(onDisk.datasources).toEqual({
			slack: { description: "Team Slack for release talk", tags: ["chat"] },
			telegram: { enabled: false, description: "Family chats" },
			whatsapp: { description: "Friends" },
		});
		const agentSlack = buildAgentOptions(resolveConfigReadOnly({ flags: {}, env: fixture.env, cwd: fixture.root }))
			.datasourceSkills?.find((skill) => skill.describe().name === "slack");
		expect(agentSlack?.describe().description).toBe("Team Slack for release talk");
		expect(byId((await service.list()).sources, "slack").description).toBe("Team Slack for release talk");

		await service.setDescription("slack", "   ");
		const cleared = JSON.parse(await readFile(fixture.configPath, "utf8")) as Record<string, any>;
		expect(cleared.datasources.slack).toEqual({ tags: ["chat"] });
		await expect(service.setDescription("missing", "x")).rejects.toThrow("Unknown datasource: missing");
	});

	it("marks connected sources as syncing while a datasource refresh is running", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		await writeConfig(fixture, { slack: {}, telegram: false });
		await mkdir(join(fixture.workspace, ".autorag"), { recursive: true });
		await writeFile(join(fixture.workspace, ".autorag", "refresh-progress.json"), JSON.stringify({
			version: 1,
			runId: "run",
			pid: process.pid,
			state: "running",
			phase: "datasources",
			startedAt: "2026-09-30T00:00:00.000Z",
			updatedAt: "2026-09-30T00:00:01.000Z",
		}));

		const snapshot = await createDataSourceStatusService({ env: fixture.env, cwd: fixture.root }).list();

		expect(snapshot.refresh).toMatchObject({ state: "running", phase: "datasources" });
		expect(byId(snapshot.sources, "slack").status).toBe("syncing");
		expect(byId(snapshot.sources, "telegram").status).toBe("paused");
	});

	it("returns an error snapshot instead of throwing for a malformed config", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		await writeFile(fixture.configPath, "{ not json");

		const snapshot = await createDataSourceStatusService({ env: fixture.env, cwd: fixture.root }).list();

		expect(snapshot.sources).toEqual([]);
		expect(snapshot.error).toMatch(/parse/i);
	});

	describe("syncing one source in keyword-only mode", () => {
		async function mailcrawlFixture(appIndexing: Record<string, unknown> | undefined): Promise<Fixture> {
			const fixture = await createFixtureWithOnlySlacrawlOnPath();
			await writeFile(join(fixture.root, "bin", "mailcrawl"), "#!/bin/sh\nexit 0\n");
			await chmod(join(fixture.root, "bin", "mailcrawl"), 0o755);
			await writeConfig(fixture, { mail: { type: "mailcrawl", connector: { account: "work" } } });
			const raw = JSON.parse(await readFile(fixture.configPath, "utf8"));
			await writeFile(
				fixture.configPath,
				JSON.stringify({
					...raw,
					minSync: { embedder: { id: "openai:Qwen/Qwen3-Embedding-0.6B", baseUrl: "http://127.0.0.1:11434", dimension: 1024 } },
					...(appIndexing === undefined ? {} : { appIndexing }),
				}),
			);
			return fixture;
		}

		function stubMailcrawl(): { readonly embed: ReturnType<typeof vi.fn> } {
			const done = { stdout: "", stderr: "", code: 0 };
			vi.spyOn(MailcrawlClient.prototype, "sync").mockResolvedValue({ ok: true, data: { messages: 2, chunksAdded: 2 }, ...done } as never);
			const embed = vi.spyOn(MailcrawlClient.prototype, "index").mockResolvedValue({ ok: true, data: { embedded: 2, reused: 0 }, ...done } as never);
			return { embed };
		}

		it("runs the source's embedding step while semantic search is on", async () => {
			const { embed } = stubMailcrawl();
			try {
				const fixture = await mailcrawlFixture(undefined);
				const result = await createDataSourceStatusService({ env: fixture.env, cwd: fixture.root }).sync("mail");

				expect(result).toMatchObject({ ok: true, state: "indexed" });
				expect(embed).toHaveBeenCalledOnce();
			} finally {
				vi.restoreAllMocks();
			}
		});

		it("updates the source but never embeds it when semantic search is off, and restores the embedding step afterwards", async () => {
			const { embed } = stubMailcrawl();
			const realEmbed = MailcrawlClient.prototype.index;
			try {
				const fixture = await mailcrawlFixture({ semanticSearch: false });
				const result = await createDataSourceStatusService({ env: fixture.env, cwd: fixture.root }).sync("mail");

				expect(result).toMatchObject({ ok: true, state: "indexed", chunkCount: 2 });
				expect(embed).not.toHaveBeenCalled();
				expect(MailcrawlClient.prototype.index).toBe(realEmbed);
			} finally {
				vi.restoreAllMocks();
			}
		});
	});

	it("syncs one source through its skill and explains unavailable/unknown sources", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		await writeConfig(fixture, { vault: { type: "obsidian", connector: { vaultPath: join(fixture.workspace, "vault") } } });
		const service = createDataSourceStatusService({ env: fixture.env, cwd: fixture.root });

		const unavailable = await service.sync("vault");
		expect(unavailable).toMatchObject({ id: "vault", ok: false, state: "unavailable" });
		expect(unavailable.error).toContain("qmd");
		expect(typeof unavailable.durationMs).toBe("number");

		const unknown = await service.sync("nope");
		expect(unknown).toMatchObject({ id: "nope", ok: false, state: "not-configured" });
		expect(unknown.error).toContain("Unknown datasource");
	});

	it("detects the desktop source app separately from the CLI", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		await writeConfig(
			fixture,
			{ slack: {}, feed: { type: "rss", connector: { feeds: [{ url: "https://example.com/feed.xml" }] } } },
		);

		const snapshot = await createDataSourceStatusService({ env: fixture.env, cwd: fixture.root }).list();

		expect(byId(snapshot.sources, "slack").install.app).toMatchObject({ required: true, name: "Slack" });
		expect(byId(snapshot.sources, "feed").install.app).toMatchObject({ required: false, name: "" });
	});
});

/** Installs a fake backend CLI on PATH (which holds only the fixture bin, so shell builtins only) that prints `output` and records its argv. */
async function installFakeCli(fixture: Fixture, binary: string, output: string): Promise<string> {
	const argvLog = join(fixture.root, `${binary}.argv`);
	const quoted = `'${output.replaceAll("'", "'\\''")}'`;
	await writeFile(join(fixture.root, "bin", binary), `#!/bin/sh\necho "$@" >> '${argvLog}'\nprintf '%s\\n' ${quoted}\n`);
	await chmod(join(fixture.root, "bin", binary), 0o755);
	return argvLog;
}

/** The fake backend CLIs are `#!/bin/sh` scripts, which Windows cannot execute. */
describe.skipIf(process.platform === "win32")("backend-owned index counts", () => {
	it("reads what each backend CLI reports instead of showing a placeholder", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		await installFakeCli(fixture, "slacrawl", JSON.stringify({ messages: 179, last_sync_at: "2026-10-08T04:52:09Z" }));
		await installFakeCli(
			fixture,
			"discrawl",
			JSON.stringify({ last_sync_at: "2026-08-16T09:12:29Z", counts: [{ id: "channels", value: 179 }, { id: "messages", value: 3536 }] }),
		);
		await installFakeCli(fixture, "telecrawl", JSON.stringify({ messages: 976, last_import_at: "2026-09-22T01:04:28Z" }));
		await installFakeCli(fixture, "notcrawl", JSON.stringify({ pages: 12, last_sync_at: 1_790_000_000 }));
		await installFakeCli(fixture, "clawgallery", "config_dir: /x\nfolders: 1\nimages: 13635\ncaptions: 48");
		await installFakeCli(
			fixture,
			"lazykatok",
			JSON.stringify({ freshness: { last_sync: { total_messages: 50632, completed_at: "2026-09-23T06:07:17Z" } } }),
		);
		await writeConfig(fixture, { slack: {}, discord: {}, telegram: {}, notion: {}, clawgallery: {}, kakao: {} });

		const rows = (await createDataSourceStatusService({ env: fixture.env, cwd: fixture.root }).list()).sources;

		expect(byId(rows, "slack").index).toMatchObject({ state: "indexed", chunkCount: 179, unit: "message", indexedAt: "2026-10-08T04:52:09.000Z" });
		expect(byId(rows, "discord").index).toMatchObject({ state: "indexed", chunkCount: 3536, unit: "message", indexedAt: "2026-08-16T09:12:29.000Z" });
		expect(byId(rows, "telegram").index).toMatchObject({ state: "indexed", chunkCount: 976, unit: "message" });
		expect(byId(rows, "notion").index).toMatchObject({ state: "indexed", chunkCount: 12, unit: "document", indexedAt: "2026-09-21T14:13:20.000Z" });
		expect(byId(rows, "clawgallery").index).toMatchObject({ state: "indexed", chunkCount: 13635, unit: "image" });
		expect(byId(rows, "kakao").index).toMatchObject({ state: "indexed", chunkCount: 50632, unit: "message" });
	});

	it("reports kakao as not-indexed when sync ran without a committed semantic index, and indexed once both completed", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		await installFakeCli(
			fixture,
			"lazykatok",
			JSON.stringify({
				freshness: {
					last_sync: { total_messages: 50632, completed_at: "2026-09-23T06:07:17Z" },
					last_index: null,
					recommendation: { sync_before_search: false, index_before_semantic_search: true },
				},
			}),
		);
		await writeConfig(fixture, { kakao: {} });
		const service = createDataSourceStatusService({ env: fixture.env, cwd: fixture.root });

		const [unindexed] = (await service.list()).sources;
		expect(unindexed?.index).toMatchObject({ state: "not-indexed", chunkCount: null, unit: "message" });

		await installFakeCli(
			fixture,
			"lazykatok",
			JSON.stringify({
				freshness: {
					last_sync: { total_messages: 50632, completed_at: "2026-09-23T06:09:00Z" },
					last_index: { completed_at: "2026-09-23T06:08:00Z", embedded_texts: 120 },
					recommendation: { sync_before_search: false, index_before_semantic_search: true },
				},
			}),
		);
		const [stale] = (await service.list()).sources;
		expect(stale?.index).toMatchObject({ state: "not-indexed", chunkCount: null, unit: "message" });

		await installFakeCli(
			fixture,
			"lazykatok",
			JSON.stringify({
				freshness: {
					last_sync: { total_messages: 50632, completed_at: "2026-09-23T06:07:17Z" },
					last_index: { completed_at: "2026-09-23T06:08:00Z", embedded_texts: 120 },
					recommendation: { sync_before_search: false, index_before_semantic_search: false },
				},
			}),
		);
		const [indexed] = (await service.list()).sources;
		expect(indexed?.index).toMatchObject({
			state: "indexed",
			chunkCount: 50632,
			unit: "message",
			indexedAt: "2026-09-23T06:08:00.000Z",
		});
	});

	it("reports kakao as not-indexed while the sidecar holds no vectors, and indexed once it does", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		await installFakeCli(
			fixture,
			"lazykatok",
			JSON.stringify({
				freshness: {
					last_sync: { total_messages: 50632, completed_at: "2026-09-23T06:07:17Z" },
					last_index: null,
					recommendation: { sync_before_search: false, index_before_semantic_search: true },
				},
			}),
		);
		await writeConfig(fixture, { kakao: {} });
		const sidecarDir = join(fixture.workspace, ".autorag", "datasources", "kakao", "default");
		await mkdir(sidecarDir, { recursive: true });
		// What a failed first sync leaves behind: the tables, no identity, no vectors.
		const db = new DatabaseSync(join(sidecarDir, "sidecar.sqlite"));
		db.exec(`
			create table sidecar_meta (k text primary key, v text not null);
			create table sidecar_vec (message_key text primary key, hash text not null, vec blob not null);
		`);
		const service = createDataSourceStatusService({ env: fixture.env, cwd: fixture.root });

		const [failed] = (await service.list()).sources;
		expect(failed?.index).toMatchObject({ state: "not-indexed", chunkCount: null, unit: "message" });

		db.exec(`
			insert into sidecar_meta values ('identity', '{"provider":"qwen","model":"m","dimension":2}');
			insert into sidecar_vec values ('k1', 'h', x'00');
		`);
		db.close();
		const [indexed] = (await service.list()).sources;
		expect(indexed?.index).toMatchObject({
			state: "indexed",
			chunkCount: 50632,
			unit: "message",
			indexedAt: "2026-09-23T06:07:17.000Z",
		});
	});

	it("reports an empty archive as empty and an unreadable one as not-indexed", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		await installFakeCli(fixture, "slacrawl", JSON.stringify({ messages: 0, last_sync_at: "" }));
		await installFakeCli(fixture, "telecrawl", "not json at all");
		await writeConfig(fixture, { slack: {}, telegram: {} });

		const rows = (await createDataSourceStatusService({ env: fixture.env, cwd: fixture.root }).list()).sources;

		expect(byId(rows, "slack").index).toMatchObject({ state: "empty", chunkCount: 0, indexedAt: null });
		expect(byId(rows, "telegram").index).toMatchObject({ state: "not-indexed", chunkCount: null });
	});

	it("never runs a status command that would import: WhatsApp is asked with --sync never", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		const argv = await installFakeCli(fixture, "wacrawl", JSON.stringify({ messages: 16591, last_import_at: "2026-10-08T06:42:37Z" }));
		await writeConfig(fixture, { whatsapp: {} });

		const [row] = (await createDataSourceStatusService({ env: fixture.env, cwd: fixture.root }).list()).sources;

		expect(row?.index).toMatchObject({ state: "indexed", chunkCount: 16591 });
		expect(await readFile(argv, "utf8")).toBe("--json --sync never status\n");
	});

	it("passes the connector's own database and config flags to the backend", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		const argv = await installFakeCli(fixture, "telecrawl", JSON.stringify({ messages: 1 }));
		await writeConfig(fixture, { telegram: { connector: { databasePath: "/data/tg.db" } } });

		await createDataSourceStatusService({ env: fixture.env, cwd: fixture.root }).list();

		expect(await readFile(argv, "utf8")).toBe("--json --db /data/tg.db status\n");
	});

	it("does not claim a count for Lark, which answers each search live", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		await installFakeCli(fixture, "lark-cli", "{}");
		await writeConfig(fixture, { lark: {} });

		const [row] = (await createDataSourceStatusService({ env: fixture.env, cwd: fixture.root }).list()).sources;

		expect(row?.index).toMatchObject({ state: "live", chunkCount: null });
	});

	it("never runs one backend CLI twice at once, so overlapping lists cannot trip its database lock", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		const lock = join(fixture.root, "wacrawl.lock");
		// Fails the way wacrawl does when two status runs overlap: a held lock means SQLITE_BUSY.
		await writeFile(
			join(fixture.root, "bin", "wacrawl"),
			`#!/bin/sh\nif ! mkdir '${lock}' 2>/dev/null; then exit 1; fi\nsleep 0.2\nprintf '%s\\n' '{"messages":5}'\nrmdir '${lock}'\n`,
		);
		await chmod(join(fixture.root, "bin", "wacrawl"), 0o755);
		await writeConfig(fixture, { whatsapp: {} });
		const env = { ...fixture.env, PATH: `${join(fixture.root, "bin")}:/usr/bin:/bin` };
		const service = createDataSourceStatusService({ env, cwd: fixture.root });

		const lists = await Promise.all([service.list(), service.list(), service.list()]);

		for (const snapshot of lists) expect(snapshot.sources[0]?.index).toMatchObject({ state: "indexed", chunkCount: 5 });
	});

	it("counts the documents the last local refresh parsed, and says nothing before one has run", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		await writeConfig(fixture, {});
		const service = createDataSourceStatusService({ env: fixture.env, cwd: fixture.root });
		expect((await service.list()).local).toEqual({ documentCount: 0, updatedAt: null });

		const entry = (name: string, updatedAt: string): [string, MirrorEntry] => {
			const virtualPath = `/files/${name}.md`;
			return [virtualPath, { virtualPath, sourcePath: join(fixture.workspace, "docs", `${name}.md`), outputPath: `/out/${name}.md`, parserName: "plain-text", sourceMtimeNs: 1, sourceSizeBytes: 1, updatedAt }];
		};
		saveMirrorIndex(fixture.workspace, {
			version: 1,
			entries: Object.fromEntries([entry("a", "2026-10-01T00:00:00.000Z"), entry("b", "2026-10-03T00:00:00.000Z"), entry("c", "2026-10-02T00:00:00.000Z")]),
		});

		expect((await service.list()).local).toEqual({ documentCount: 3, updatedAt: "2026-10-03T00:00:00.000Z" });
	});
});
