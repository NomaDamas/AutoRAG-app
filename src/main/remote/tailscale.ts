/**
 * Read-only Tailscale discovery and `tailscale serve` owner header verification,
 * adapted from Ovis (`devswha/ovis`, MIT).
 *
 * Only runs `tailscale status --json` and `tailscale serve status --json` (2.5s timeout),
 * never mutating the user's tailnet.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { delimiter, join } from "node:path";
import type { RemoteTailscaleStatus } from "../../shared/remote-contract";
import { isLoopbackAddress } from "./auth";

const TIMEOUT_MS = 2500;
const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const WIN_PROGRAM_FILES_CLI = "C:\\Program Files\\Tailscale\\tailscale.exe";
export const HTTPS_PORTS: readonly number[] = [443, 8443, 47833, 17317];
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const tailnetIpv4 = new BlockList();
tailnetIpv4.addSubnet("100.64.0.0", 10, "ipv4");
const tailnetIpv6 = new BlockList();
tailnetIpv6.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

export function isTailnetIp(address: string | null | undefined): boolean {
	if (!address) return false;
	const trimmed = address.trim();
	const family = isIP(trimmed);
	return family === 4 ? tailnetIpv4.check(trimmed, "ipv4") : family === 6 && tailnetIpv6.check(trimmed, "ipv6");
}

export interface TailscaleCommandOutput {
	readonly status: string | null;
	readonly serve: string | null;
}

interface NodeJson {
	readonly DNSName?: string;
	readonly UserID?: number | string;
	readonly TailscaleIPs?: readonly string[];
	readonly Tags?: readonly string[];
}

interface StatusJson {
	readonly BackendState?: string;
	readonly Self?: NodeJson;
	readonly User?: Readonly<Record<string, { readonly LoginName?: string }>>;
}

interface ServeJson {
	readonly TCP?: Readonly<Record<string, { readonly HTTPS?: boolean; readonly HTTP?: boolean }>>;
	readonly Web?: Readonly<Record<string, { readonly Handlers?: Readonly<Record<string, { readonly Proxy?: string }>> }>>;
}

const MISSING_STATUS: RemoteTailscaleStatus = {
	state: "missing",
	dnsName: null,
	tailnetIp: null,
	owner: null,
	servingUrl: null,
	serveCommand: null,
	serveUrl: null,
};

function parseJson<T>(text: string | null): T | null {
	if (text === null) return null;
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

/** Preserve >2^53 UserID precision before JSON.parse so `User[String(UserID)]` matches. */
function parseStatusJson(status: string | null): StatusJson | null {
	return parseJson<StatusJson>(status === null ? null : status.replace(/("UserID"\s*:\s*)(\d+)/g, '$1"$2"'));
}

function proxiesToPort(target: string | undefined, port: number): boolean {
	if (!target || port <= 0) return false;
	try {
		const url = new URL(target);
		const targetPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
		return LOOPBACK_HOSTS.has(url.hostname) && targetPort === port && (url.pathname === "" || url.pathname === "/");
	} catch {
		return false;
	}
}

function httpsUrl(host: string, port: number): string {
	return `https://${host}${port === 443 ? "" : `:${port}`}`;
}

export function parseTailscale(
	output: TailscaleCommandOutput | null,
	port: number,
	candidates: readonly number[] = HTTPS_PORTS,
): RemoteTailscaleStatus {
	if (output === null) return MISSING_STATUS;
	const status = parseStatusJson(output.status);
	if (status === null || status.BackendState !== "Running") {
		return { ...MISSING_STATUS, state: "stopped" };
	}
	const self = status.Self;
	const dnsName = self?.DNSName?.replace(/\.$/, "") || null;
	const tailnetIp = self?.TailscaleIPs?.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) ?? null;
	const tagged = (self?.Tags?.length ?? 0) > 0;
	const userId = self?.UserID;
	const owner = !tagged && userId !== undefined && userId !== null ? (status.User?.[String(userId)]?.LoginName || null) : null;

	const serve = parseJson<ServeJson>(output.serve);
	const taken = new Set(Object.keys(serve?.TCP ?? {}).map(Number).filter(Number.isFinite));
	let servingUrl: string | null = null;
	for (const [hostPort, site] of Object.entries(serve?.Web ?? {})) {
		const separator = hostPort.lastIndexOf(":");
		if (separator <= 0) continue;
		const host = hostPort.slice(0, separator);
		const webPort = Number(hostPort.slice(separator + 1));
		if (!serve?.TCP?.[String(webPort)]?.HTTPS) continue;
		if (proxiesToPort(site.Handlers?.["/"]?.Proxy, port)) {
			servingUrl = httpsUrl(host, webPort);
			break;
		}
	}
	const freePort = servingUrl === null && port > 0 ? (candidates.find((candidate) => !taken.has(candidate)) ?? null) : null;
	return {
		state: "running",
		dnsName,
		tailnetIp,
		owner,
		servingUrl,
		serveCommand: freePort === null ? null : `tailscale serve --bg --https=${freePort} http://127.0.0.1:${port}`,
		serveUrl: freePort === null || dnsName === null ? null : httpsUrl(dnsName, freePort),
	};
}

export function findTailscaleBinary(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
	const exts = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
	const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
	for (const dir of dirs) {
		for (const ext of exts) {
			const full = join(dir, `tailscale${ext}`);
			if (existsSync(full)) return full;
		}
	}
	if (platform === "darwin" && existsSync(MAC_APP_CLI)) return MAC_APP_CLI;
	if (platform === "win32" && existsSync(WIN_PROGRAM_FILES_CLI)) return WIN_PROGRAM_FILES_CLI;
	return null;
}

function runCommand(binary: string, args: readonly string[]): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(binary, [...args], { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
			resolve(error === null ? stdout : null);
		});
	});
}

export async function readTailscaleStatus(port: number): Promise<RemoteTailscaleStatus> {
	const binary = findTailscaleBinary();
	if (binary === null) return MISSING_STATUS;
	const [status, serve] = await Promise.all([
		runCommand(binary, ["status", "--json"]),
		runCommand(binary, ["serve", "status", "--json"]),
	]);
	if (status === null && serve === null) return { ...MISSING_STATUS, state: "stopped" };
	return parseTailscale({ status, serve }, port);
}

/**
 * Verifies whether an incoming request came from the host's own Tailscale account
 * through local `tailscale serve`.
 *
 * Security invariants (from Ovis `server/access.ts`):
 * - Socket peer MUST be loopback (`tailscaled` runs locally).
 * - `Tailscale-Funnel-Request` MUST NOT be present (public internet is never auto-trusted).
 * - `X-Forwarded-For` MUST be a single tailnet address (`100.64.0.0/10` or `fd7a:115c:a1e0::/48`),
 *   filtering out nginx/Cloudflare/tunnels that might forward a visitor-supplied `Tailscale-User-Login`.
 */
export function verifyTailscaleOwnerHeader(input: {
	readonly remoteAddress: string | null | undefined;
	readonly tailscaleUserLogin: string | null | undefined;
	readonly forwardedFor: string | null | undefined;
	readonly funnelRequest: string | null | undefined;
	readonly owner: string | null;
}): { readonly kind: "owner"; readonly login: string } | { readonly kind: "other_user" } | { readonly kind: "none" } {
	if (!input.remoteAddress || !isLoopbackAddress(input.remoteAddress)) return { kind: "none" };
	if (input.funnelRequest) return { kind: "none" };
	if (!input.tailscaleUserLogin || !input.owner) return { kind: "none" };
	const forwarded = input.forwardedFor?.trim() ?? "";
	if (!forwarded || forwarded.includes(",") || !isTailnetIp(forwarded)) return { kind: "none" };
	if (input.tailscaleUserLogin.toLowerCase() === input.owner.toLowerCase()) {
		return { kind: "owner", login: input.tailscaleUserLogin };
	}
	return { kind: "other_user" };
}
