import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpSettingsService, validateMcpServer, type McpSettingsService } from "../src/main/mcp-settings-service";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(initial?: unknown): Promise<{ readonly service: McpSettingsService; readonly file: string }> {
	const dir = await mkdtemp(join(tmpdir(), "autorag-mcp-"));
	directories.push(dir);
	const file = join(dir, "mcp.json");
	if (initial !== undefined) await writeFile(file, typeof initial === "string" ? initial : JSON.stringify(initial));
	return { service: createMcpSettingsService({ agentDir: () => dir }), file };
}

const read = async (file: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(file, "utf8"));

describe("validateMcpServer", () => {
	it("accepts a stdio entry and an http entry", () => {
		expect(validateMcpServer("fs", { command: "npx", args: ["-y", "server"], env: { A: "1" } })).toBeNull();
		expect(validateMcpServer("docs", { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${T}" } })).toBeNull();
	});

	it.each([
		["a name with a space", "my server", { command: "x" }],
		["no transport", "s", { description: "x" }],
		["an empty command", "s", { command: "  " }],
		["the legacy sse transport", "s", { type: "sse", url: "https://example.com" }],
		["a non-http url", "s", { url: "ftp://example.com" }],
		["args that are not strings", "s", { command: "x", args: [1] }],
		["an unknown exposure", "s", { command: "x", exposure: "everywhere" }],
		["a non-positive timeout", "s", { command: "x", timeout: 0 }],
		["headers that are not strings", "s", { url: "https://example.com", headers: { A: 1 } }],
	])("rejects %s", (_label, name, config) => {
		expect(validateMcpServer(name, config)).not.toBeNull();
	});

	it("accepts the older exposure name pi still understands", () => {
		expect(validateMcpServer("s", { command: "x", exposure: "codemode-deferred" })).toBeNull();
	});
});

describe("createMcpSettingsService", () => {
	it("reports a missing file as an empty list instead of an error", async () => {
		const { service, file } = await fixture();

		expect(await service.get()).toMatchObject({ path: file, exists: false, error: null, servers: [] });
	});

	it("flags an entry pi would reject but still lists it, so the user can fix or remove it", async () => {
		const { service } = await fixture({ mcpServers: { good: { command: "x" }, bad: { description: "no transport" } } });

		const snapshot = await service.get();

		expect(snapshot.servers.map((row) => [row.name, row.problem === null])).toEqual([["good", true], ["bad", false]]);
	});

	it("adds a server and creates the file readable by its owner only, since it can hold tokens", async () => {
		const { service, file } = await fixture();

		await service.upsert({ name: "docs", config: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${T}" } } });

		expect(await read(file)).toEqual({ mcpServers: { docs: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${T}" } } } });
		if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
	});

	it("keeps top-level options and the keys of other servers when it edits one server", async () => {
		const { service, file } = await fixture({
			autoEnableCodemode: false,
			mcpServers: { a: { command: "a", oauth: { clientId: "c" } }, b: { command: "b", toolExposure: { "x*": "direct" } } },
		});

		await service.upsert({ name: "a", replaces: "a", config: { command: "a2", oauth: { clientId: "c" }, exposure: "direct" } });

		expect(await read(file)).toEqual({
			autoEnableCodemode: false,
			mcpServers: { a: { command: "a2", oauth: { clientId: "c" }, exposure: "direct" }, b: { command: "b", toolExposure: { "x*": "direct" } } },
		});
	});

	it("renames a server in place, without reshuffling the file", async () => {
		const { service, file } = await fixture({ mcpServers: { a: { command: "a" }, b: { command: "b" }, c: { command: "c" } } });

		await service.upsert({ name: "renamed", replaces: "b", config: { command: "b" } });

		expect(Object.keys((await read(file)).mcpServers as object)).toEqual(["a", "renamed", "c"]);
	});

	it("refuses to add over an existing name, and to rename onto one", async () => {
		const { service, file } = await fixture({ mcpServers: { a: { command: "a" }, b: { command: "b" } } });

		await expect(service.upsert({ name: "a", config: { command: "other" } })).rejects.toThrow("a");
		await expect(service.upsert({ name: "a", replaces: "b", config: { command: "b" } })).rejects.toThrow("a");
		await expect(service.upsert({ name: "z", replaces: "missing", config: { command: "z" } })).rejects.toThrow("missing");
		expect((await read(file)).mcpServers).toEqual({ a: { command: "a" }, b: { command: "b" } });
	});

	it("does not write an invalid entry", async () => {
		const { service, file } = await fixture({ mcpServers: { a: { command: "a" } } });

		await expect(service.upsert({ name: "bad name", config: { command: "x" } })).rejects.toThrow();
		await expect(service.upsert({ name: "b", config: { url: "not a url" } })).rejects.toThrow();

		expect((await read(file)).mcpServers).toEqual({ a: { command: "a" } });
	});

	it("removes one server and leaves the rest", async () => {
		const { service, file } = await fixture({ mcpServers: { a: { command: "a" }, b: { command: "b" } } });

		const snapshot = await service.remove("a");

		expect(snapshot.servers.map((row) => row.name)).toEqual(["b"]);
		expect((await read(file)).mcpServers).toEqual({ b: { command: "b" } });
		await expect(service.remove("a")).rejects.toThrow("a");
	});

	it("refuses to overwrite a file it cannot parse, and leaves it byte for byte", async () => {
		const broken = "{ \"mcpServers\": { \"a\": ";
		const { service, file } = await fixture(broken);

		const snapshot = await service.get();

		expect(snapshot).toMatchObject({ exists: true, servers: [] });
		expect(snapshot.error).toContain("mcp.json");
		await expect(service.upsert({ name: "b", config: { command: "b" } })).rejects.toThrow("mcp.json");
		await expect(service.remove("a")).rejects.toThrow();
		expect(await readFile(file, "utf8")).toBe(broken);
	});

	it("applies a burst of writes one after another without losing any", async () => {
		const { service, file } = await fixture();

		await Promise.all(["a", "b", "c", "d"].map((name) => service.upsert({ name, config: { command: name } })));

		expect(Object.keys((await read(file)).mcpServers as object).sort()).toEqual(["a", "b", "c", "d"]);
	});
});
