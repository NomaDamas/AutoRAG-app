import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAutoRagConfigService } from "../src/main/autorag-config-service";
import { syncCalendarMcpConfig } from "../src/main/calendar-mcp";
import { createDataSourceStatusService } from "../src/main/datasource-status";
import { calendarSupported } from "../src/shared/calendar-platform";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("calendarSupported", () => {
	it("is true on macOS only: EventKit is Apple's framework", () => {
		expect(calendarSupported("darwin")).toBe(true);
		expect(calendarSupported("win32")).toBe(false);
		expect(calendarSupported("linux")).toBe(false);
		expect(calendarSupported("freebsd")).toBe(false);
	});
});

async function fixture(platform: NodeJS.Platform) {
	const root = await mkdtemp(join(tmpdir(), "autorag-calendar-platform-"));
	directories.push(root);
	const agentDir = join(root, "pi-agent");
	await mkdir(agentDir, { recursive: true });
	const configPath = join(root, "config.json");
	await writeFile(configPath, `${JSON.stringify({ searchPaths: [root], workspacePath: root, memoryPath: join(root, "memory.json") }, null, 2)}\n`);
	const env = { HOME: root, PATH: "", AUTORAG_CONFIG: configPath, PI_CODING_AGENT_DIR: agentDir };
	return {
		agentDir,
		mcpPath: join(agentDir, "mcp.json"),
		config: createAutoRagConfigService({ env, cwd: root, platform }),
		status: createDataSourceStatusService({ env, cwd: root, platform }),
	};
}

const CALENDAR_ENTRY = { type: "calendar", connector: { exposure: "direct" } };

describe("Calendar on a machine without EventKit", () => {
	it.each(["win32", "linux"] as const)("%s: a calendar connection starts no MCP server, whoever wrote it", async (platform) => {
		const { config, status, mcpPath } = await fixture(platform);
		await config.set(["datasources", "calendar"], CALENDAR_ENTRY);
		// A shared config can carry the entry from a Mac; it must stay inert here.
		await status.setEnabled("calendar", true);
		await expect(readFile(mcpPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("keeps unrelated MCP servers and removes a stale apple-events entry a Mac left behind", async () => {
		const { config, mcpPath } = await fixture("linux");
		await writeFile(
			mcpPath,
			JSON.stringify({ mcpServers: { filesystem: { command: "npx" }, "apple-events": { command: "npx", args: ["-y", "mcp-server-apple-events"] } } }),
		);

		await config.set(["datasources", "calendar"], CALENDAR_ENTRY);

		expect(JSON.parse(await readFile(mcpPath, "utf8")).mcpServers).toEqual({ filesystem: { command: "npx" } });
	});

	it.each(["win32", "linux"] as const)("%s: the row says unsupported, never connected, and sync refuses with the reason", async (platform) => {
		const { config, status } = await fixture(platform);
		await config.set(["datasources", "calendar"], CALENDAR_ENTRY);

		const row = (await status.list()).sources.find((source) => source.id === "calendar");
		expect(row?.install.state).toBe("unsupported");
		expect(row?.agent.state).toBe("unsupported");
		expect(row?.status).toBe("attention");
		const synced = await status.sync("calendar");
		expect(synced).toMatchObject({ ok: false, state: "unsupported" });
		expect(synced.error).toContain("macOS");
	});

	it("macOS still connects it (the shared rule is the only difference)", async () => {
		const { config, status, mcpPath } = await fixture("darwin");
		await config.set(["datasources", "calendar"], CALENDAR_ENTRY);
		expect(JSON.parse(await readFile(mcpPath, "utf8")).mcpServers["apple-events"]).toMatchObject({ command: "npx" });
		expect((await status.list()).sources.find((source) => source.id === "calendar")?.agent.state).toBe("connected");
	});

	it("syncCalendarMcpConfig itself writes nothing off macOS", async () => {
		const { agentDir, mcpPath } = await fixture("linux");
		syncCalendarMcpConfig({ datasources: { calendar: CALENDAR_ENTRY } }, {}, agentDir, "linux");
		await expect(readFile(mcpPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});
});
