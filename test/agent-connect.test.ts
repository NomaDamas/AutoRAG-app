import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentConnect, type AgentConnectDeps } from "../src/main/agent-connect";
import type { RemoteTunnelStatus } from "../src/shared/remote-contract";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class FakeChild extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	killed = false;
	// A real ChildProcess holds both at null while it runs and sets one when it ends.
	exitCode: number | null = null;
	signalCode: string | null = null;
	kill(): boolean {
		this.killed = true;
		queueMicrotask(() => {
			this.signalCode = "SIGTERM";
			this.emit("exit", null, "SIGTERM");
		});
		return true;
	}
}

interface Spawned {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: NodeJS.ProcessEnv;
	readonly child: FakeChild;
}

/** The owner token as stored: one JSON string. */
async function storedToken(stateDir: string): Promise<string> {
	return JSON.parse(await readFile(join(stateDir, "agent-mcp-token"), "utf8"));
}

function tunnelStatus(patch: Partial<RemoteTunnelStatus> = {}): RemoteTunnelStatus {
	return { available: true, mode: "quick", hostname: null, loggedIn: false, state: "off", url: null, error: null, errorCode: null, ...patch };
}

async function setup(overrides: Partial<AgentConnectDeps> = {}) {
	const stateDir = await mkdtemp(join(tmpdir(), "dazzi-agent-connect-"));
	cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
	const spawned: Spawned[] = [];
	const tunnelCalls: string[] = [];
	let tunnel = tunnelStatus();
	const manager = createAgentConnect({
		stateDir,
		launch: { command: "/node", args: ["/app/mcp-server.js"], env: { AUTORAG_TOOLS_DIR: "/tools" } },
		env: { PATH: "/usr/bin", HOME: "/home/u", ANTHROPIC_API_KEY: "secret", OPENAI_API_KEY: "secret", AUTORAG_MCP_TOKEN: "stale" },
		port: 0,
		spawnProcess: (command, args, env) => {
			const child = new FakeChild();
			spawned.push({ command, args, env, child });
			// The librarian binds the port it is given (0 means any free one) and prints where it listens.
			const asked = Number(args[args.indexOf("--port") + 1]);
			const bound = asked > 0 ? asked : 40000 + spawned.length;
			queueMicrotask(() => child.stderr.write(`autorag-mcp: listening on http://127.0.0.1:${bound}/mcp (read-only)\n`));
			return child as never;
		},
		tunnel: {
			status: () => tunnel,
			start: async (port: number) => {
				tunnelCalls.push(`start:${port}`);
				tunnel = tunnelStatus({ state: "online", url: "https://quick-words.trycloudflare.com" });
				return tunnel;
			},
			stop: async () => {
				tunnelCalls.push("stop");
				tunnel = tunnelStatus();
			},
			setHostname: async () => undefined,
			login: async () => tunnel,
		},
		...overrides,
	});
	cleanups.push(() => manager.stop());
	return { manager, spawned, tunnelCalls, stateDir, setTunnel: (next: RemoteTunnelStatus) => (tunnel = next) };
}

/** A tunnel that never comes up, so the server is started once and stays local. */
function offlineTunnel(): AgentConnectDeps["tunnel"] {
	return {
		status: () => tunnelStatus({ state: "error", error: "cloudflared is not installed", errorCode: "missing_binary" }),
		start: async () => tunnelStatus({ state: "error", error: "cloudflared is not installed", errorCode: "missing_binary" }),
		stop: async () => undefined,
		setHostname: async () => undefined,
		login: async () => tunnelStatus(),
	};
}

describe("agent connection", () => {
	it("starts the librarian server read-only on loopback, with a token and without provider keys", async () => {
		const { manager, spawned } = await setup({ tunnel: offlineTunnel() });
		await manager.start();
		expect(spawned).toHaveLength(1);
		const first = spawned[0];
		expect(first?.command).toBe("/node");
		expect(first?.args).toEqual(["/app/mcp-server.js", "--http", "--host", "127.0.0.1", "--port", "0"]);
		expect(first?.args).not.toContain("--allow-write");
		const env = first?.env ?? {};
		expect(env.AUTORAG_TOOLS_DIR).toBe("/tools");
		expect(env.PATH).toBe("/usr/bin");
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.OPENAI_API_KEY).toBeUndefined();
		expect(env.AUTORAG_MCP_TOKEN).not.toBe("stale");
		expect((env.AUTORAG_MCP_TOKEN ?? "").length).toBeGreaterThanOrEqual(32);
	});

	it("keeps the owner token in a private file and reuses it across restarts, so issued tokens stay valid", async () => {
		const { manager, spawned, stateDir } = await setup();
		await manager.start();
		const file = join(stateDir, "agent-mcp-token");
		const token = await storedToken(stateDir);
		expect(spawned[0]?.env.AUTORAG_MCP_TOKEN).toBe(token);
		if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
		await manager.stop();
		await manager.start();
		expect(spawned.at(-1)?.env.AUTORAG_MCP_TOKEN).toBe(token);
	});

	it("never puts the owner token in the status it reports to the renderer", async () => {
		const { manager, stateDir } = await setup();
		await manager.start();
		const token = await storedToken(stateDir);
		expect(JSON.stringify(await manager.status())).not.toContain(token);
	});

	it("opens the app's tunnel on the server's port and restarts the server with that address as its public URL", async () => {
		const { manager, spawned, tunnelCalls } = await setup();
		const status = await manager.start();
		expect(tunnelCalls).toEqual(["start:40001"]);
		expect(spawned).toHaveLength(2);
		expect(spawned[0]?.child.killed).toBe(true);
		expect(spawned[1]?.args).toEqual([
			"/app/mcp-server.js", "--http", "--host", "127.0.0.1", "--port", "40001", "--public-url", "https://quick-words.trycloudflare.com",
		]);
		expect(status.serving).toBe(true);
		expect(status.mcpUrl).toBe("https://quick-words.trycloudflare.com/mcp");
	});

	it("serves local-only, with no public address and no OAuth, when the tunnel cannot come up", async () => {
		const { manager, spawned } = await setup({
			tunnel: {
				status: () => tunnelStatus({ state: "error", error: "cloudflared is not installed", errorCode: "missing_binary" }),
				start: async () => tunnelStatus({ state: "error", error: "cloudflared is not installed", errorCode: "missing_binary" }),
				stop: async () => undefined,
				setHostname: async () => undefined,
				login: async () => tunnelStatus(),
			},
		});
		const status = await manager.start();
		expect(spawned).toHaveLength(1);
		expect(status.serving).toBe(true);
		expect(status.mcpUrl).toBeNull();
		expect(status.tunnel.errorCode).toBe("missing_binary");
	});

	it("reports a server that exits at start as an error with its last words, not as serving", async () => {
		const { manager } = await setup({
			spawnProcess: () => {
				const child = new FakeChild();
				queueMicrotask(() => {
					child.stderr.write("Error: Cannot find package 'x'\n");
					child.exitCode = 1;
					child.emit("exit", 1, null);
				});
				return child as never;
			},
		});
		const status = await manager.start();
		expect(status.serving).toBe(false);
		expect(status.error).toContain("Cannot find package");
	});

	it("stops the server and the tunnel together, and a second stop is harmless", async () => {
		const { manager, spawned, tunnelCalls } = await setup();
		await manager.start();
		await manager.stop();
		await manager.stop();
		expect(spawned.at(-1)?.child.killed).toBe(true);
		expect(tunnelCalls.at(-1)).toBe("stop");
		expect((await manager.status()).serving).toBe(false);
	});

	it("starting twice does not start a second server", async () => {
		const { manager, spawned } = await setup();
		await Promise.all([manager.start(), manager.start()]);
		const afterFirst = spawned.length;
		await manager.start();
		expect(spawned).toHaveLength(afterFirst);
	});

	it("a restart rebinds the port the running tunnel already points at, so the public address keeps reaching the server", async () => {
		const { manager, spawned } = await setup();
		await manager.start();
		const port = (await manager.status()).mcpUrl === null ? 0 : 40001;
		expect(port).toBe(40001);
		for (const restart of [() => manager.setAllowWrite(true), () => manager.rotateToken()]) {
			await restart();
			const ports = spawned.slice(-1).map((entry) => entry.args[entry.args.indexOf("--port") + 1]);
			expect(ports, "the server must listen on the port the tunnel was opened for").toEqual(["40001"]);
		}
		// Every launch after the first must carry the public address too, or OAuth silently turns off.
		expect(spawned.at(-1)?.args).toContain("--public-url");
	});

	it("write access is a separate opt-in that restarts the server with it", async () => {
		const { manager, spawned } = await setup();
		await manager.start();
		await manager.setAllowWrite(true);
		expect(spawned.at(-1)?.args).toContain("--allow-write");
		expect((await manager.status()).allowWrite).toBe(true);
	});

	it("turns the token over on request: the old one stops being the one the server runs with", async () => {
		const { manager, spawned, stateDir } = await setup();
		await manager.start();
		const before = await storedToken(stateDir);
		await manager.rotateToken();
		const after = await storedToken(stateDir);
		expect(after).not.toBe(before);
		expect(spawned.at(-1)?.env.AUTORAG_MCP_TOKEN).toBe(after);
	});

	it("hands the renderer the token only through an explicit reveal, for a bearer-header agent", async () => {
		const { manager, stateDir } = await setup();
		await manager.start();
		const token = await storedToken(stateDir);
		expect(await manager.revealToken()).toBe(token);
	});
});

describe("agent connection is out of reach of a remote browser session", () => {
	it("is not a target the remote dispatcher can route to, so a paired phone cannot read or rotate the owner token", async () => {
		const { createRemoteDispatcher, RemoteUnsupportedError } = await import("../src/main/remote/registry");
		const { AGENT_CONNECT_CHANNELS } = await import("../src/shared/agent-connect-contract");
		const dispatch = createRemoteDispatcher({ workerFor: () => ({}) as never, targets: { settings: {} } });
		for (const method of ["revealToken", "rotateToken", "start", "stop", "status", "setAllowWrite"]) {
			await expect(dispatch({ target: "agentConnect", method, args: [] }, "session")).rejects.toBeInstanceOf(RemoteUnsupportedError);
		}
		// The channel names are all in one namespace the remote target list does not include.
		expect(Object.values(AGENT_CONNECT_CHANNELS).every((channel) => channel.startsWith("agentConnect:"))).toBe(true);
	});

	it("the desktop's remote target list does not name it", async () => {
		const { readFile } = await import("node:fs/promises");
		const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
		const block = /const remoteTargets = \{([\s\S]*?)\} as const;/.exec(source)?.[1] ?? "";
		expect(block.length).toBeGreaterThan(0);
		expect(block).not.toMatch(/agent/i);
	});
});
