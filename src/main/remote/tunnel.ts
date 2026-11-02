/**
 * Non-Tailscale remote access: outbound Cloudflare Quick Tunnel
 * (`cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<port>`).
 *
 * Requires no account, no router port forwarding, and no client software on the
 * phone or remote PC. Traffic between the browser and Dazzi remains gated by
 * Dazzi's pairing code / `dazzi_device` cookie / access token.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { RemoteTunnelStatus } from "../../shared/remote-contract";

const START_TIMEOUT_MS = 25_000;
const EXTRA_MAC_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];
const TRYCLOUDFLARE_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;

export function extractTryCloudflareUrl(text: string): string | null {
	const match = TRYCLOUDFLARE_URL_RE.exec(text);
	return match ? match[0] : null;
}

export function findCloudflaredBinary(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string | null {
	const exts = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
	const dirs = [
		...(env.PATH ?? "").split(delimiter).filter(Boolean),
		...(platform === "darwin" ? EXTRA_MAC_DIRS : []),
	];
	for (const dir of dirs) {
		for (const ext of exts) {
			const candidate = join(dir, `cloudflared${ext}`);
			if (existsSync(candidate)) return candidate;
		}
	}
	return null;
}

export interface TunnelManagerDeps {
	readonly findBinary?: () => string | null;
	readonly spawnProcess?: (command: string, args: readonly string[]) => ChildProcess;
	readonly onChange?: () => void;
}

export interface TunnelManager {
	status(): RemoteTunnelStatus;
	start(port: number): Promise<RemoteTunnelStatus>;
	stop(): Promise<void>;
}

export function createTunnelManager(deps: TunnelManagerDeps = {}): TunnelManager {
	const findBinary = deps.findBinary ?? (() => findCloudflaredBinary());
	const spawnProcess =
		deps.spawnProcess ??
		((command: string, args: readonly string[]) =>
			spawn(command, [...args], {
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			}));

	let child: ChildProcess | null = null;
	let state: RemoteTunnelStatus["state"] = "off";
	let url: string | null = null;
	let error: string | null = null;
	let inFlightStart: Promise<RemoteTunnelStatus> | null = null;

	const currentStatus = (): RemoteTunnelStatus => ({
		available: findBinary() !== null,
		state,
		url,
		error,
	});

	const notify = (): void => {
		deps.onChange?.();
	};

	const stop = async (): Promise<void> => {
		const proc = child;
		child = null;
		inFlightStart = null;
		state = "off";
		url = null;
		error = null;
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

	const start = async (port: number): Promise<RemoteTunnelStatus> => {
		if (state === "online" && child !== null) return currentStatus();
		if (inFlightStart !== null) return inFlightStart;

		const binary = findBinary();
		if (binary === null) {
			state = "error";
			url = null;
			error = "cloudflared is not installed";
			notify();
			return currentStatus();
		}
		if (port <= 0) {
			state = "error";
			url = null;
			error = "Remote server must be running before starting Quick Tunnel";
			notify();
			return currentStatus();
		}

		if (child !== null) {
			await stop();
		}
		state = "starting";
		url = null;
		error = null;
		notify();

		// Pass an explicit empty config so a user's ~/.cloudflared/config.yml named-tunnel
		// credentials/ingress rules never shadow `--url` Quick Tunnel routing!
		const emptyConfigPath = join(tmpdir(), "dazzi-cloudflared-quick-tunnel.yml");
		try {
			if (!existsSync(emptyConfigPath)) writeFileSync(emptyConfigPath, "# empty quick-tunnel config\n", "utf8");
		} catch {
			/* best effort */
		}

		const promise = new Promise<RemoteTunnelStatus>((resolve) => {
			const proc = spawnProcess(binary, [
				"tunnel",
				"--config",
				emptyConfigPath,
				"--no-autoupdate",
				"--url",
				`http://127.0.0.1:${port}`,
			]);
			child = proc;
			let settled = false;
			let logTail = "";

			const finish = (nextState: RemoteTunnelStatus["state"], nextUrl: string | null, nextError: string | null): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (child === proc || nextState === "online") {
					state = nextState;
					url = nextUrl;
					error = nextError;
					notify();
				}
				inFlightStart = null;
				resolve(currentStatus());
			};

			const timer = setTimeout(() => {
				if (child === proc) {
					try {
						proc.kill();
					} catch {
						/* ignore */
					}
					child = null;
				}
				finish("error", null, "Timed out waiting for Quick Tunnel URL");
			}, START_TIMEOUT_MS);
			timer.unref();

			const onChunk = (chunk: Buffer | string): void => {
				const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
				logTail = (logTail + text).slice(-2048);
				const found = extractTryCloudflareUrl(logTail);
				if (found !== null) {
					finish("online", found, null);
				}
			};

			proc.stdout?.on("data", onChunk);
			proc.stderr?.on("data", onChunk);
			proc.once("error", (err) => {
				if (child === proc) child = null;
				finish("error", null, err.message);
			});
			proc.once("exit", (code) => {
				const wasCurrent = child === proc;
				if (wasCurrent) child = null;
				if (!settled) {
					finish("error", null, `cloudflared exited with code ${code ?? "unknown"}`);
				} else if (wasCurrent && state === "online") {
					state = "error";
					url = null;
					error = `Quick Tunnel disconnected (code ${code ?? "unknown"})`;
					notify();
				}
			});
		});

		inFlightStart = promise;
		return promise;
	};

	return {
		status: currentStatus,
		start,
		stop,
	};
}
