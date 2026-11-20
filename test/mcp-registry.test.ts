import { describe, expect, it, vi } from "vitest";
import { compareVersions, resolveMcpRegistryServer, searchMcpRegistry } from "../src/main/mcp-registry";

/** One `servers[]` entry of the registry response, in the shape the live endpoint returned (see the route's comment). */
function registryServer(server: Record<string, unknown>): { readonly server: Record<string, unknown> } {
	return { server };
}

const npmServer = registryServer({
	name: "io.github.acme/notes-server",
	description: "Notes over MCP",
	version: "0.1.5",
	repository: { url: "https://github.com/acme/notes-server", source: "github" },
	packages: [
		{
			registryType: "npm",
			identifier: "notes-mcp-server",
			version: "0.1.5",
			runtimeHint: "npx",
			transport: { type: "stdio" },
			environmentVariables: [
				{ name: "NOTES_ROOT", isRequired: true, description: "Folder to index" },
				{ name: "NOTES_API_KEY", isSecret: true, description: "API key" },
				{ name: "NOTES_LABEL", description: "Optional label" },
			],
		},
	],
});

const httpServer = registryServer({
	name: "ai.smithery/remote-notes",
	description: "Hosted notes server",
	version: "2.0.0",
	remotes: [
		{
			type: "streamable-http",
			url: "https://server.smithery.ai/@remote-notes/mcp",
			headers: [
				{ name: "Authorization", isRequired: true, isSecret: true, description: "Bearer token", value: "Bearer {smithery_api_key}" },
				{ name: "X-Server", isRequired: true, description: "Server id" },
			],
		},
	],
});

const sseServer = registryServer({
	name: "io.github.acme/sse-only",
	description: "Legacy sse server",
	version: "1.0.0",
	remotes: [{ type: "sse", url: "https://example.com/sse" }],
});

function fetchReturning(body: unknown): typeof globalThis.fetch {
	return (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof globalThis.fetch;
}

describe("mcp-registry search", () => {
	it("compacts a registry server into install options with secrets and needs, and dedupes by newest version", async () => {
		const olderPackages = JSON.parse(JSON.stringify((npmServer.server as Record<string, unknown>).packages)) as Array<Record<string, unknown>>;
		olderPackages[0]!.version = "0.1.2";
		const older = registryServer({ ...(npmServer.server as Record<string, unknown>), version: "0.1.2", packages: olderPackages });
		const fetchImpl = fetchReturning({ servers: [older, npmServer, httpServer, sseServer] });

		const result = await searchMcpRegistry("notes", { fetch: fetchImpl });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const byId = new Map(result.servers.map((server) => [server.id, server]));
		expect(byId.size).toBe(3);

		const npm = byId.get("io.github.acme/notes-server")!;
		expect(npm.version).toBe("0.1.5");
		expect(npm.repository).toBe("https://github.com/acme/notes-server");
		expect(npm.installable).toBe(true);
		expect(npm.install).toEqual([{ index: 0, kind: "npm", location: "notes-mcp-server@0.1.5", secrets: ["NOTES_API_KEY"], needs: ["NOTES_ROOT"] }]);

		const http = byId.get("ai.smithery/remote-notes")!;
		expect(http.install).toEqual([{ index: 0, kind: "remote", location: "https://server.smithery.ai/@remote-notes/mcp", secrets: ["Authorization"], needs: ["X-Server"] }]);

		const sse = byId.get("io.github.acme/sse-only")!;
		expect(sse.installable).toBe(false);
		expect(sse.install).toEqual([]);
		expect(sse.reason).toMatch(/streamable-http/);
	});

	it("strips control characters, trims and caps the description", async () => {
		const long = `A${"x".repeat(400)}\u0007bad`;
		const result = await searchMcpRegistry("x", { fetch: fetchReturning({ servers: [registryServer({ name: "a/b", description: long, version: "1.0.0", packages: [] })] }) });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const description = result.servers[0]!.description;
		expect(description.length).toBeLessThanOrEqual(200);
		expect(description).not.toContain("\u0007");
	});

	it("caps and clamps the requested limit in the URL", async () => {
		const seen: string[] = [];
		const fetchImpl = (async (url: string) => {
			seen.push(String(url));
			return { ok: true, status: 200, json: async () => ({ servers: [] }) };
		}) as unknown as typeof globalThis.fetch;

		await searchMcpRegistry("a", { fetch: fetchImpl });
		await searchMcpRegistry("a", { fetch: fetchImpl, limit: 999 });
		await searchMcpRegistry("a", { fetch: fetchImpl, limit: 5 });
		expect(seen[0]).toContain("limit=8");
		expect(seen[1]).toContain("limit=20");
		expect(seen[2]).toContain("limit=5");
	});

	it("returns {ok:false,error} instead of throwing when the registry fails", async () => {
		const fetchImpl = (async () => {
			throw new Error("network down");
		}) as unknown as typeof globalThis.fetch;
		const failed = await searchMcpRegistry("a", { fetch: fetchImpl });
		expect(failed.ok).toBe(false);
		if (!failed.ok) expect(failed.error).toContain("network down");

		const badStatus = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof globalThis.fetch;
		const refused = await searchMcpRegistry("a", { fetch: badStatus });
		expect(refused.ok).toBe(false);

		const empty = await searchMcpRegistry("   ", { fetch: fetchImpl });
		expect(empty.ok).toBe(false);
	});
});

describe("mcp-registry resolve", () => {
	it("re-fetches one exact server by name and keeps its full install details", async () => {
		const resolved = await resolveMcpRegistryServer("io.github.acme/notes-server", { fetch: fetchReturning({ servers: [httpServer, npmServer] }) });
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		expect(resolved.server.id).toBe("io.github.acme/notes-server");
		expect(resolved.server.candidates).toHaveLength(1);
		const candidate = resolved.server.candidates[0]!;
		expect(candidate.kind).toBe("npm");
		expect(candidate.identifier).toBe("notes-mcp-server");
		expect(candidate.version).toBe("0.1.5");
		expect(candidate.env.map((entry) => entry.name)).toEqual(["NOTES_ROOT", "NOTES_API_KEY", "NOTES_LABEL"]);
		expect(candidate.env.find((entry) => entry.name === "NOTES_API_KEY")?.secret).toBe(true);
		expect(candidate.secrets).toEqual(["NOTES_API_KEY"]);
		expect(candidate.needs).toEqual(["NOTES_ROOT"]);
	});

	it("keeps the registry's header value template", async () => {
		const resolved = await resolveMcpRegistryServer("ai.smithery/remote-notes", { fetch: fetchReturning({ servers: [httpServer] }) });
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		const header = resolved.server.candidates[0]!.headers.find((entry) => entry.name === "Authorization")!;
		expect(header.secret).toBe(true);
		expect(header.template).toBe("Bearer {smithery_api_key}");
	});

	it("refuses a name the registry does not have and never throws", async () => {
		const missing = await resolveMcpRegistryServer("no/such-server", { fetch: fetchReturning({ servers: [npmServer] }) });
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error).toContain("no/such-server");

		const broken = await resolveMcpRegistryServer("a/b", { fetch: fetchReturning({ nope: true }) });
		expect(broken.ok).toBe(false);
	});
});

describe("compareVersions", () => {
	it("orders numeric dot versions", () => {
		expect(compareVersions("0.1.5", "0.1.2")).toBeGreaterThan(0);
		expect(compareVersions("2.0.0", "10.0.0")).toBeLessThan(0);
		expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
	});
});
