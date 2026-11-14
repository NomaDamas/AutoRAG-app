import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConnectStatus } from "../shared/agent-connect-contract";
import type { RemoteTunnelStatus } from "../shared/remote-contract";
import type { McpLaunch } from "../shared/mcp-connect";
import { writePrivateState } from "./remote/private-state";

/** The token as the file holds it: one JSON string, written by the same atomic private writer as the paired-device records. */

/**
 * Lets an always-on cloud agent (Claude Duet, OpenAI dots, Meta Muse, Grok Bot) search this machine's index.
 *
 * Those agents run in their vendor's cloud and connect to an MCP server by URL, so the stdio server `mcp-connect-info`
 * hands to a local CLI is no use to them. This runs the librarian's own streamable-HTTP server (`--http`) as a child on
 * loopback, read-only unless the user opts in, and puts the app's existing Cloudflare tunnel in front of it. The tunnel
 * address becomes the server's `--public-url`, which is what turns on the OAuth endpoints a connector dialog needs.
 *
 * It is not the remote-access server: that one serves the Finder UI to a person behind a pairing code. This one serves
 * search tools to an agent behind an owner token, and the two never share a port or a credential.
 *
 * The tunnel address is only known once the tunnel is up, and the tunnel needs the server's port, so the server starts
 * twice: first on loopback to learn a free port, then again with the tunnel address as its public URL.
 */

/** The file in the private settings directory holding the owner token. */
export const AGENT_TOKEN_FILE = "agent-mcp-token";

const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 3_000;
const LISTENING_RE = /autorag-mcp: listening on (http:\/\/\S+)/;
const OUTPUT_TAIL_CHARS = 2_000;
/** Everything the child needs to find its tools and config; nothing else of the app's environment reaches it. */
const PASSED_ENV = ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "LANG", "SystemRoot", "APPDATA", "LOCALAPPDATA", "AUTORAG_HOME", "AUTORAG_CONFIG", "AUTORAG_TOOLS_DIR"] as const;

/** The slice of the app's tunnel manager this needs; a test passes a fake. */
export interface AgentConnectTunnel {
	status(): RemoteTunnelStatus;
	start(port: number): Promise<RemoteTunnelStatus>;
	stop(): Promise<void>;
	setHostname(hostname: string): Promise<void>;
	login(): Promise<RemoteTunnelStatus>;
}

export interface AgentConnectDeps {
	/** The private settings directory (`<userData>/settings`); holds the token file. */
	readonly stateDir: string;
	/** How to run the librarian server: the node binary, `mcp-server.js`, and the environment that finds the bundled tools. */
	readonly launch: McpLaunch;
	readonly env: NodeJS.ProcessEnv;
	/** The port to bind; 0 asks the system for a free one. */
	readonly port: number;
	readonly tunnel: AgentConnectTunnel;
	readonly spawnProcess?: (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => ChildProcess;
	readonly onChange?: () => void;
}

export type { AgentConnectStatus };

export interface AgentConnect {
	start(): Promise<AgentConnectStatus>;
	stop(): Promise<void>;
	status(): Promise<AgentConnectStatus>;
	setAllowWrite(allow: boolean): Promise<AgentConnectStatus>;
	/** A new owner token: every token the old one signed (OAuth sessions included) stops working. */
	rotateToken(): Promise<AgentConnectStatus>;
	/** The owner token, for an agent that sends it as a bearer header. Only on an explicit request. */
	revealToken(): Promise<string>;
}

function newToken(): string {
	return randomBytes(32).toString("base64url");
}

function readToken(path: string): string | null {
	try {
		const token: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof token === "string" && token.length >= 32 ? token : null;
	} catch {
		return null;
	}
}

function defaultSpawn(command: string, args: readonly string[], env: NodeJS.ProcessEnv): ChildProcess {
	return spawn(command, [...args], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

interface Running {
	readonly child: ChildProcess;
	readonly port: number;
	readonly publicUrl: string | null;
	readonly tail: { text: string };
}

export function createAgentConnect(deps: AgentConnectDeps): AgentConnect {
	const spawnProcess = deps.spawnProcess ?? defaultSpawn;
	const tokenPath = join(deps.stateDir, AGENT_TOKEN_FILE);
	let running: Running | null = null;
	/**
	 * The port and address the tunnel was opened for. A tunnel keeps pointing at the port it started on, so every
	 * restart of the server (write access, a new token) must listen there again and carry the same public address.
	 */
	let tunneled: { readonly port: number; readonly url: string } | null = null;
	let allowWrite = false;
	let error: string | null = null;
	let inFlight: Promise<AgentConnectStatus> | null = null;

	const notify = (): void => deps.onChange?.();

	const ownerToken = (): string => {
		const existing = readToken(tokenPath);
		if (existing !== null) return existing;
		const token = newToken();
		writePrivateState(tokenPath, token);
		return token;
	};

	const childEnv = (token: string): NodeJS.ProcessEnv => {
		const env: NodeJS.ProcessEnv = {};
		for (const name of PASSED_ENV) if (deps.env[name] !== undefined) env[name] = deps.env[name];
		// The launch env is authoritative for what locates the bundled tools and the AutoRAG config.
		Object.assign(env, deps.launch.env);
		env.AUTORAG_MCP_TOKEN = token;
		return env;
	};

	const killChild = (child: ChildProcess): Promise<void> =>
		new Promise((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null) {
				resolve();
				return;
			}
			const timer = setTimeout(resolve, STOP_TIMEOUT_MS);
			timer.unref();
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			try {
				child.kill();
			} catch {
				clearTimeout(timer);
				resolve();
			}
		});

	/** Runs the server until it says where it listens, or fails with what it last printed. */
	const launchServer = (port: number, publicUrl: string | null): Promise<Running> =>
		new Promise((resolve, reject) => {
			const args = [...deps.launch.args, "--http", "--host", "127.0.0.1", "--port", String(port)];
			if (publicUrl !== null) args.push("--public-url", publicUrl);
			if (allowWrite) args.push("--allow-write");
			const child = spawnProcess(deps.launch.command, args, childEnv(ownerToken()));
			const tail = { text: "" };
			let settled = false;
			const settle = (action: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				action();
			};
			const timer = setTimeout(() => {
				settle(() => {
					void killChild(child);
					reject(new Error(`The agent server did not start in time. ${tail.text.trim()}`.trim()));
				});
			}, START_TIMEOUT_MS);
			timer.unref();
			const onChunk = (chunk: Buffer | string): void => {
				tail.text = (tail.text + (typeof chunk === "string" ? chunk : chunk.toString("utf8"))).slice(-OUTPUT_TAIL_CHARS);
				const found = LISTENING_RE.exec(tail.text);
				if (found?.[1] === undefined) return;
				const bound = Number(new URL(found[1]).port);
				settle(() => resolve({ child, port: bound, publicUrl, tail }));
			};
			child.stdout?.on("data", onChunk);
			child.stderr?.on("data", onChunk);
			child.once("error", (cause) => settle(() => reject(cause)));
			child.once("exit", (code) => {
				if (settled) {
					// Died after start: the status must stop claiming it serves.
					if (running?.child === child) {
						running = null;
						error = `The agent server stopped (exit ${code ?? "signal"}). ${tail.text.trim().split("\n").at(-1) ?? ""}`.trim();
						notify();
					}
					return;
				}
				settle(() => reject(new Error(tail.text.trim().split("\n").at(-1) ?? `The agent server exited with code ${code}.`)));
			});
		});

	const snapshot = (): AgentConnectStatus => {
		const tunnel = deps.tunnel.status();
		const publicUrl = running?.publicUrl ?? null;
		return {
			serving: running !== null,
			mcpUrl: publicUrl === null ? null : `${publicUrl.replace(/\/+$/, "")}/mcp`,
			oauth: publicUrl !== null,
			allowWrite,
			tunnel,
			error,
		};
	};

	const stopInternal = async (): Promise<void> => {
		const current = running;
		running = null;
		if (current !== null) await killChild(current.child);
	};

	const startInternal = async (): Promise<AgentConnectStatus> => {
		error = null;
		await stopInternal();
		try {
			if (tunneled !== null && deps.tunnel.status().state === "online") {
				// The tunnel is still up for this port and address: only the server restarts.
				running = await launchServer(tunneled.port, tunneled.url);
			} else {
				tunneled = null;
				const first = await launchServer(deps.port, null);
				running = first;
				notify();
				const tunnel = await deps.tunnel.start(first.port);
				if (tunnel.state === "online" && tunnel.url !== null) {
					// The address exists only now, so the server restarts to learn it: that is what enables OAuth.
					await stopInternal();
					tunneled = { port: first.port, url: tunnel.url };
					running = await launchServer(first.port, tunnel.url);
				}
			}
		} catch (cause) {
			await stopInternal();
			error = cause instanceof Error ? cause.message : String(cause);
		}
		notify();
		return snapshot();
	};

	const start = async (): Promise<AgentConnectStatus> => {
		if (running !== null && inFlight === null) return snapshot();
		inFlight ??= startInternal().finally(() => {
			inFlight = null;
		});
		return inFlight;
	};

	const restartIfRunning = async (): Promise<AgentConnectStatus> => {
		if (running === null && inFlight === null) return snapshot();
		if (inFlight !== null) await inFlight;
		return startInternal();
	};

	return {
		start,
		status: async () => snapshot(),
		stop: async () => {
			if (inFlight !== null) await inFlight.catch(() => undefined);
			await stopInternal();
			tunneled = null;
			await deps.tunnel.stop();
			error = null;
			notify();
		},
		setAllowWrite: async (allow) => {
			allowWrite = allow;
			return restartIfRunning();
		},
		rotateToken: async () => {
			writePrivateState(tokenPath, newToken());
			return restartIfRunning();
		},
		revealToken: async () => ownerToken(),
	};
}

/** Whether the owner token file exists; the Settings page shows "not created yet" until the first start. */
export function agentTokenExists(stateDir: string): boolean {
	return existsSync(join(stateDir, AGENT_TOKEN_FILE));
}

/** Owner-only on POSIX even if the file was created by something that ignored the mode. */
export function tightenAgentTokenMode(stateDir: string): void {
	if (process.platform === "win32") return;
	try {
		chmodSync(join(stateDir, AGENT_TOKEN_FILE), 0o600);
	} catch {
		/* no token yet */
	}
}
