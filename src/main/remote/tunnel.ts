/**
 * Non-Tailscale remote access over an outbound Cloudflare tunnel. Nothing listens on
 * the router and the phone needs no app; every visitor still meets Dazzi's own gate
 * (pairing code, `dazzi_device` cookie, or access token).
 *
 * Two modes:
 * - Quick Tunnel (default, no account): `cloudflared tunnel --url http://127.0.0.1:<port>`.
 *   Cloudflare hands out a random `https://<words>.trycloudflare.com` address that changes
 *   every time the tunnel starts and carries no uptime guarantee.
 * - Own domain: a named tunnel on a hostname the user owns on Cloudflare (`remote.example.com`).
 *   Needs `cloudflared tunnel login` once (writes `~/.cloudflared/cert.pem`); Dazzi then creates
 *   the tunnel `dazzi-<hostname>` (credentials kept under Dazzi's state directory), routes the
 *   hostname to it (`route dns`, never overwriting a record that already exists), and runs it
 *   with `--url`, so the address stays the same across restarts.
 *
 * Every invocation passes an empty `--config`: a user's own `~/.cloudflared/config.yml`
 * (named tunnels, ingress rules) must never reroute Dazzi's traffic.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { RemoteTunnelErrorCode, RemoteTunnelStatus } from "../../shared/remote-contract";

const START_TIMEOUT_MS = 25_000;
const COMMAND_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const EXTRA_MAC_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];
const TRYCLOUDFLARE_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;
/** cloudflared logs this once the edge accepted the connection of a named tunnel. */
const REGISTERED_RE = /Registered tunnel connection/i;

export function extractTryCloudflareUrl(text: string): string | null {
	const match = TRYCLOUDFLARE_URL_RE.exec(text);
	return match ? match[0] : null;
}

export function findCloudflaredBinary(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
	const exts = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
	const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...(platform === "darwin" ? EXTRA_MAC_DIRS : [])];
	for (const dir of dirs) {
		for (const ext of exts) {
			const candidate = join(dir, `cloudflared${ext}`);
			if (existsSync(candidate)) return candidate;
		}
	}
	return null;
}

/** `cloudflared tunnel login` writes the account certificate here unless TUNNEL_ORIGIN_CERT says otherwise. */
export function cloudflaredCertPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.TUNNEL_ORIGIN_CERT ?? join(homedir(), ".cloudflared", "cert.pem");
}

/** The named tunnel Dazzi owns for one hostname: `remote.example.com` -> `dazzi-remote-example-com`. */
export function namedTunnelName(hostname: string): string {
	return `dazzi-${hostname.replace(/[^a-z0-9]+/g, "-")}`;
}

export interface TunnelCommandResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface TunnelManagerDeps {
	readonly findBinary?: () => string | null;
	readonly spawnProcess?: (command: string, args: readonly string[]) => ChildProcess;
	/** One finite cloudflared command (`create`, `route dns`, `login`). */
	readonly runCommand?: (binary: string, args: readonly string[], timeoutMs: number) => Promise<TunnelCommandResult>;
	/** Whether `cloudflared tunnel login` has written the account certificate. */
	readonly hasLogin?: () => boolean;
	/** Where named-tunnel credentials are kept (Dazzi's private settings directory). */
	readonly stateDir?: string;
	readonly onChange?: () => void;
}

export interface TunnelManager {
	status(): RemoteTunnelStatus;
	start(port: number): Promise<RemoteTunnelStatus>;
	stop(): Promise<void>;
	/** Switch between Quick Tunnel (`""`) and an own domain; a running tunnel for the old address stops. */
	setHostname(hostname: string): Promise<void>;
	/** `cloudflared tunnel login`: opens Cloudflare's authorization page and waits for the certificate. */
	login(): Promise<RemoteTunnelStatus>;
}

function defaultRunCommand(binary: string, args: readonly string[], timeoutMs: number): Promise<TunnelCommandResult> {
	return new Promise((resolve) => {
		execFile(binary, [...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
			resolve({ code, stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

/** The last meaningful line cloudflared printed: what the user is shown when setup fails. */
function failureReason(result: TunnelCommandResult): string {
	const lines = `${result.stderr}\n${result.stdout}`.split("\n").map((line) => line.trim()).filter(Boolean);
	return lines.at(-1) ?? `cloudflared exited with code ${result.code}`;
}

export function createTunnelManager(deps: TunnelManagerDeps = {}): TunnelManager {
	const findBinary = deps.findBinary ?? (() => findCloudflaredBinary());
	const runCommand = deps.runCommand ?? defaultRunCommand;
	const hasLogin = deps.hasLogin ?? (() => existsSync(cloudflaredCertPath()));
	const spawnProcess =
		deps.spawnProcess ??
		((command: string, args: readonly string[]) => spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));

	let hostname: string | null = null;
	let child: ChildProcess | null = null;
	let state: RemoteTunnelStatus["state"] = "off";
	let url: string | null = null;
	let error: string | null = null;
	let errorCode: RemoteTunnelErrorCode | null = null;
	let inFlightStart: Promise<RemoteTunnelStatus> | null = null;

	const currentStatus = (): RemoteTunnelStatus => ({
		available: findBinary() !== null,
		mode: hostname === null ? "quick" : "custom",
		hostname,
		loggedIn: hasLogin(),
		state,
		url,
		error,
		errorCode,
	});

	const notify = (): void => {
		deps.onChange?.();
	};

	const fail = (code: RemoteTunnelErrorCode, message: string): RemoteTunnelStatus => {
		state = "error";
		url = null;
		error = message;
		errorCode = code;
		notify();
		return currentStatus();
	};

	const emptyConfig = (): string => {
		const path = join(tmpdir(), "dazzi-cloudflared-empty.yml");
		if (!existsSync(path)) writeFileSync(path, "# Dazzi passes this empty config so ~/.cloudflared/config.yml never applies.\n", "utf8");
		return path;
	};

	const stop = async (): Promise<void> => {
		const proc = child;
		child = null;
		inFlightStart = null;
		state = "off";
		url = null;
		error = null;
		errorCode = null;
		if (proc !== null) {
			await new Promise<void>((resolve) => {
				const done = (): void => resolve();
				proc.once("exit", done);
				proc.once("error", done);
				try {
					proc.kill();
				} catch {
					resolve();
				}
				setTimeout(done, 2000).unref();
			});
		}
		notify();
	};

	/** Create (once) and route the named tunnel; returns the `run` arguments, or a failure status. */
	const prepareNamedTunnel = async (binary: string, name: string, port: number): Promise<readonly string[] | RemoteTunnelStatus> => {
		const stateDir = deps.stateDir ?? join(homedir(), ".dazzi-tunnels");
		const tunnelDir = join(stateDir, "tunnels");
		mkdirSync(tunnelDir, { recursive: true, mode: 0o700 });
		const tunnelName = namedTunnelName(name);
		const credentials = join(tunnelDir, `${tunnelName}.json`);
		const config = emptyConfig();
		if (!existsSync(credentials)) {
			const created = await runCommand(binary, ["tunnel", "--config", config, "create", "--credentials-file", credentials, tunnelName], COMMAND_TIMEOUT_MS);
			if (created.code !== 0 || !existsSync(credentials)) return fail("setup_failed", failureReason(created));
		}
		const routed = await runCommand(binary, ["tunnel", "--config", config, "route", "dns", tunnelName, name], COMMAND_TIMEOUT_MS);
		if (routed.code !== 0) return fail("setup_failed", failureReason(routed));
		return ["tunnel", "--config", config, "--no-autoupdate", "run", "--credentials-file", credentials, "--url", `http://127.0.0.1:${port}`, tunnelName];
	};

	const start = async (port: number): Promise<RemoteTunnelStatus> => {
		if (state === "online" && child !== null) return currentStatus();
		if (inFlightStart !== null) return inFlightStart;
		const binary = findBinary();
		if (binary === null) return fail("missing_binary", "cloudflared is not installed");
		if (port <= 0) return fail("server_stopped", "Remote server must be running before starting the tunnel");
		if (child !== null) await stop();
		const customHost = hostname;
		if (customHost !== null && !hasLogin()) return fail("login_required", "cloudflared tunnel login has not been run");

		state = "starting";
		url = null;
		error = null;
		errorCode = null;
		notify();

		const promise = (async (): Promise<RemoteTunnelStatus> => {
			let args: readonly string[];
			if (customHost === null) {
				args = ["tunnel", "--config", emptyConfig(), "--no-autoupdate", "--url", `http://127.0.0.1:${port}`];
			} else {
				const prepared = await prepareNamedTunnel(binary, customHost, port);
				if (!Array.isArray(prepared)) {
					inFlightStart = null;
					return prepared as RemoteTunnelStatus;
				}
				args = prepared;
			}
			return new Promise<RemoteTunnelStatus>((resolve) => {
				const proc = spawnProcess(binary, args);
				child = proc;
				let settled = false;
				let logTail = "";
				const finish = (online: string | null, code: RemoteTunnelErrorCode | null, message: string | null): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (child === proc) {
						state = online === null ? "error" : "online";
						url = online;
						error = message;
						errorCode = code;
						notify();
					}
					inFlightStart = null;
					resolve(currentStatus());
				};
				const timer = setTimeout(() => {
					// Record the timeout before killing: the exit that follows must not overwrite it.
					finish(null, "timeout", "Timed out waiting for the tunnel to connect");
					if (child === proc) {
						child = null;
						try {
							proc.kill();
						} catch {
							/* the process is already gone */
						}
					}
				}, START_TIMEOUT_MS);
				timer.unref();
				const onChunk = (chunk: Buffer | string): void => {
					logTail = (logTail + (typeof chunk === "string" ? chunk : chunk.toString("utf8"))).slice(-4096);
					if (customHost === null) {
						const found = extractTryCloudflareUrl(logTail);
						if (found !== null) finish(found, null, null);
					} else if (REGISTERED_RE.test(logTail)) {
						finish(`https://${customHost}`, null, null);
					}
				};
				proc.stdout?.on("data", onChunk);
				proc.stderr?.on("data", onChunk);
				proc.once("error", (err) => {
					finish(null, "exited", err.message);
					if (child === proc) child = null;
				});
				proc.once("exit", (code) => {
					const wasCurrent = child === proc;
					if (!settled) {
						finish(null, "exited", `cloudflared exited with code ${code ?? "unknown"}`);
					} else if (wasCurrent && state === "online") {
						state = "error";
						url = null;
						error = `Tunnel disconnected (code ${code ?? "unknown"})`;
						errorCode = "disconnected";
						notify();
					}
					if (wasCurrent) child = null;
				});
			});
		})();
		inFlightStart = promise;
		return promise;
	};

	return {
		status: currentStatus,
		start,
		stop,
		async setHostname(next) {
			const normalized = next.trim() === "" ? null : next.trim().toLowerCase();
			if (normalized === hostname) return;
			hostname = normalized;
			if (child !== null || state !== "off") await stop();
			else notify();
		},
		async login() {
			const binary = findBinary();
			if (binary === null) return fail("missing_binary", "cloudflared is not installed");
			if (hasLogin()) return currentStatus();
			const result = await runCommand(binary, ["tunnel", "--config", emptyConfig(), "login"], LOGIN_TIMEOUT_MS);
			if (result.code !== 0 && !hasLogin()) return fail("setup_failed", failureReason(result));
			error = null;
			errorCode = null;
			if (state === "error") state = "off";
			notify();
			return currentStatus();
		},
	};
}
