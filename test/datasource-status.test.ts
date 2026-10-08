import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentOptions, resolveConfigReadOnly } from "@autorag/librarian";
import { afterEach, describe, expect, it } from "vitest";
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

async function writeConfig(fixture: Fixture, datasources: Record<string, unknown>, allowedTags: readonly string[]): Promise<void> {
	await writeFile(
		fixture.configPath,
		`${JSON.stringify({
			searchPaths: [join(fixture.workspace, "docs")],
			workspacePath: fixture.workspace,
			datasources,
			datasourceAccess: { allowedTags },
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
		await writeConfig(fixture, MIXED_DATASOURCES, ["chat", "documents"]);
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
		expect(snapshot.accessTags).toEqual(["chat", "documents"]);
		expect(snapshot.sources.map((row) => row.id)).toEqual(["slack", "my-drive", "github", "telegram", "team", "foo"]);

		const slack = byId(snapshot.sources, "slack");
		expect(slack.install).toMatchObject({ state: "installed", binary: "slacrawl" });
		expect(slack.agent).toMatchObject({ state: "connected", skillName: "datasource-slack" });
		expect(slack.index.state).toBe("external");
		expect(slack.status).toBe("ready");

		const drive = byId(snapshot.sources, "my-drive");
		expect(drive.type).toBe("cloud-drive");
		expect(drive.install).toMatchObject({ state: "missing", binary: "rclone" });
		expect(drive.agent.state).toBe("connected");
		expect(drive.index).toMatchObject({ state: "indexed", chunkCount: 2, indexedAt: "2026-09-30T01:02:03.000Z" });
		expect(drive.status).toBe("attention");

		const github = byId(snapshot.sources, "github");
		expect(github.install).toMatchObject({ state: "credential-missing", binary: null });
		expect(github.agent.state).toBe("blocked");
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
		await writeConfig(fixture, { slack: {} }, ["chat"]);

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
		await writeConfig(windowsFixture, { slack: { connector: { binaryPath: "slacrawl.cmd" } } }, ["chat"]);

		const [slack] = (await createDataSourceStatusService({ env: windowsFixture.env, cwd: windowsFixture.root }).list()).sources;

		expect(slack?.install).toMatchObject({ state: "installed", path: cli });
	});

	it("still treats an exact CLI name as executable on POSIX", async () => {
		// Given the existing extensionless script on PATH
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		await writeConfig(fixture, { slack: {} }, ["chat"]);

		// When the status is listed
		const [slack] = (await createDataSourceStatusService({ env: fixture.env, cwd: fixture.root }).list()).sources;

		// Then it is found without any PATHEXT
		expect(slack?.install).toMatchObject({ state: "installed", path: join(fixture.root, "bin", "slacrawl") });
	});

	it("reports default-deny when datasourceAccess has no allowed tags", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		await writeConfig(fixture, { slack: {} }, []);

		const [slack] = (await createDataSourceStatusService({ env: fixture.env, cwd: fixture.root }).list()).sources;

		expect(slack?.agent.state).toBe("blocked");
		expect(slack?.status).toBe("attention");
	});

	it("re-reads the shared config on every list so edits from any AutoRAG surface show up", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		await writeConfig(fixture, { slack: {} }, ["chat"]);
		const service = createDataSourceStatusService({ env: fixture.env, cwd: fixture.root });
		expect((await service.list()).sources.map((row) => row.id)).toEqual(["slack"]);

		await writeConfig(fixture, { slack: { enabled: false }, rss: { connector: { feeds: [] } } }, ["chat"]);

		const rows = (await service.list()).sources;
		expect(rows.map((row) => row.id)).toEqual(["slack", "rss"]);
		expect(byId(rows, "slack").status).toBe("paused");
		expect(byId(rows, "rss").install.state).toBe("builtin");
	});

	it("writes the toggle into the shared config so every AutoRAG agent sees it", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		await writeConfig(fixture, { slack: { description: "Team" }, telegram: false }, ["chat"]);
		const service = createDataSourceStatusService({ env: fixture.env, cwd: fixture.root });

		await service.setEnabled("slack", false);
		await service.setEnabled("telegram", true);

		const onDisk = JSON.parse(await readFile(fixture.configPath, "utf8")) as Record<string, any>;
		expect(onDisk.datasources).toEqual({ slack: { description: "Team", enabled: false }, telegram: true });
		expect(onDisk.datasourceAccess).toEqual({ allowedTags: ["chat"] });
		const agentSkills = buildAgentOptions(resolveConfigReadOnly({ flags: {}, env: fixture.env, cwd: fixture.root }))
			.datasourceSkills?.map((skill) => skill.describe().name);
		expect(agentSkills).toEqual(["telegram"]);
		await expect(service.setEnabled("missing", true)).rejects.toThrow("Unknown datasource: missing");
	});

	it("saves an edited description into the shared config that the agent reads", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		await writeConfig(fixture, { slack: { description: "Old", tags: ["chat"] }, telegram: false, whatsapp: true }, ["chat"]);
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
		await writeConfig(fixture, { slack: {}, telegram: false }, ["chat"]);
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

	it("syncs one source through its skill and explains unavailable/unknown sources", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		await writeConfig(fixture, { vault: { type: "obsidian", connector: { vaultPath: join(fixture.workspace, "vault") } } }, []);
		const service = createDataSourceStatusService({ env: fixture.env, cwd: fixture.root });

		const unavailable = await service.sync("vault");
		expect(unavailable).toMatchObject({ id: "vault", ok: false, state: "unavailable" });
		expect(unavailable.error).toContain("qmd");
		expect(typeof unavailable.durationMs).toBe("number");

		const unknown = await service.sync("nope");
		expect(unknown).toMatchObject({ id: "nope", ok: false, state: "not-configured" });
		expect(unknown.error).toContain("Unknown datasource");
	});

	it("grants and revokes one source's access without changing another's", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		await writeConfig(
			fixture,
			{ slack: {}, feed: { type: "rss", connector: { feeds: [{ url: "https://example.com/feed.xml" }] } } },
			[],
		);
		const service = createDataSourceStatusService({ env: fixture.env, cwd: fixture.root });

		await service.setAccess("slack", true);
		const granted = await service.list();
		expect(byId(granted.sources, "slack").agent.state).toBe("connected");
		expect(byId(granted.sources, "feed").agent.state).toBe("blocked");

		await service.setAccess("slack", false);
		const revoked = await service.list();
		expect(revoked.accessTags).toEqual([]);
		expect(byId(revoked.sources, "slack").agent.state).toBe("blocked");
		expect(byId(revoked.sources, "feed").agent.state).toBe("blocked");
	});

	it("detects the desktop source app separately from the CLI", async () => {
		const fixture = await createFixtureWithOnlySlacrawlOnPath();
		await writeConfig(
			fixture,
			{ slack: {}, feed: { type: "rss", connector: { feeds: [{ url: "https://example.com/feed.xml" }] } } },
			[],
		);

		const snapshot = await createDataSourceStatusService({ env: fixture.env, cwd: fixture.root }).list();

		expect(byId(snapshot.sources, "slack").install.app).toMatchObject({ required: true, name: "Slack" });
		expect(byId(snapshot.sources, "feed").install.app).toMatchObject({ required: false, name: "" });
	});
});
