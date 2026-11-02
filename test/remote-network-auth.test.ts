import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { parseTailscale, verifyTailscaleOwnerHeader } from "../src/main/remote/tailscale";
import { discoverLanOrigins } from "../src/main/remote/lan";
import { createTunnelManager, extractTryCloudflareUrl } from "../src/main/remote/tunnel";
import {
	createAuthRateLimiter,
	isLoopbackAddress,
	isSameOriginMutation,
	isSecureIncomingRequest,
	parseCookieHeader,
} from "../src/main/remote/auth";

describe("Tailscale read-only integration & Serve owner verification", () => {
	it("parses missing, stopped, and running tailscale status with >2^53 UserID precision", () => {
		expect(parseTailscale(null, 47833)).toEqual({
			state: "missing",
			dnsName: null,
			tailnetIp: null,
			owner: null,
			servingUrl: null,
			serveCommand: null,
			serveUrl: null,
		});

		expect(parseTailscale({ status: JSON.stringify({ BackendState: "Stopped" }), serve: null }, 47833).state).toBe("stopped");

		// 64-bit integer UserID exceeding Number.MAX_SAFE_INTEGER
		const statusJson = `{
			"BackendState": "Running",
			"Self": {
				"DNSName": "macbook.tailnet-abc.ts.net.",
				"UserID": 90071992547409931,
				"TailscaleIPs": ["100.101.102.103", "fd7a:115c:a1e0::1"]
			},
			"User": {
				"90071992547409931": { "LoginName": "owner@example.com" }
			}
		}`;
		const serveOccupied443 = JSON.stringify({
			TCP: { "443": { HTTPS: true } },
			Web: {
				"macbook.tailnet-abc.ts.net:443": {
					Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
				},
			},
		});
		const parsed = parseTailscale({ status: statusJson, serve: serveOccupied443 }, 47833);
		expect(parsed).toEqual({
			state: "running",
			dnsName: "macbook.tailnet-abc.ts.net",
			tailnetIp: "100.101.102.103",
			owner: "owner@example.com",
			servingUrl: null,
			serveCommand: "tailscale serve --bg --https=8443 http://127.0.0.1:47833",
			serveUrl: "https://macbook.tailnet-abc.ts.net:8443",
		});

		// When tailscale serve already proxies "/" to Dazzi's port over HTTPS:
		const serveActive = JSON.stringify({
			TCP: { "443": { HTTPS: true } },
			Web: {
				"macbook.tailnet-abc.ts.net:443": {
					Handlers: { "/": { Proxy: "http://127.0.0.1:47833" } },
				},
			},
		});
		const served = parseTailscale({ status: statusJson, serve: serveActive }, 47833);
		expect(served.servingUrl).toBe("https://macbook.tailnet-abc.ts.net");
		expect(served.serveCommand).toBeNull();
	});

	it("trusts Tailscale-User-Login only from loopback peer with a CGNAT/ULA tailnet X-Forwarded-For", () => {
		// Valid owner login via local tailscaled
		expect(
			verifyTailscaleOwnerHeader({
				remoteAddress: "127.0.0.1",
				tailscaleUserLogin: "Owner@example.com",
				forwardedFor: "100.88.1.4",
				funnelRequest: null,
				owner: "owner@example.com",
			}),
		).toEqual({ kind: "owner", login: "Owner@example.com" });

		// Different tailnet user -> explicit other_user refusal
		expect(
			verifyTailscaleOwnerHeader({
				remoteAddress: "::ffff:127.0.0.1",
				tailscaleUserLogin: "friend@example.com",
				forwardedFor: "100.88.1.5",
				funnelRequest: null,
				owner: "owner@example.com",
			}),
		).toEqual({ kind: "other_user" });

		// Forged header from LAN peer -> ignored (none)
		expect(
			verifyTailscaleOwnerHeader({
				remoteAddress: "192.168.1.55",
				tailscaleUserLogin: "owner@example.com",
				forwardedFor: "100.88.1.4",
				funnelRequest: null,
				owner: "owner@example.com",
			}),
		).toEqual({ kind: "none" });

		// Reverse proxy (e.g. Cloudflare/nginx) passing public X-Forwarded-For -> ignored
		expect(
			verifyTailscaleOwnerHeader({
				remoteAddress: "127.0.0.1",
				tailscaleUserLogin: "owner@example.com",
				forwardedFor: "203.0.113.10",
				funnelRequest: null,
				owner: "owner@example.com",
			}),
		).toEqual({ kind: "none" });

		// Funnel request -> never auto-trusted without pairing/token
		expect(
			verifyTailscaleOwnerHeader({
				remoteAddress: "127.0.0.1",
				tailscaleUserLogin: "owner@example.com",
				forwardedFor: "100.88.1.4",
				funnelRequest: "?1",
				owner: "owner@example.com",
			}),
		).toEqual({ kind: "none" });
	});
});

describe("LAN IPv4 origin discovery", () => {
	it("collects private LAN IPv4 addresses and excludes loopback, link-local, and Tailscale CGNAT", () => {
		const interfaces: Record<string, NetworkInterfaceInfo[]> = {
			lo0: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
			en0: [
				{ address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "aa:bb:cc:dd:ee:01", internal: false, cidr: "fe80::1/64", scopeid: 4 },
				{ address: "192.168.0.42", netmask: "255.255.255.0", family: "IPv4", mac: "aa:bb:cc:dd:ee:01", internal: false, cidr: "192.168.0.42/24" },
				{ address: "169.254.10.20", netmask: "255.255.0.0", family: "IPv4", mac: "aa:bb:cc:dd:ee:01", internal: false, cidr: "169.254.10.20/16" },
			],
			utun4: [{ address: "100.90.12.34", netmask: "255.192.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "100.90.12.34/10" }],
			bridge0: [{ address: "10.0.1.7", netmask: "255.255.255.0", family: "IPv4", mac: "aa:bb:cc:dd:ee:02", internal: false, cidr: "10.0.1.7/24" }],
		};
		expect(discoverLanOrigins(47833, interfaces)).toEqual([
			"http://192.168.0.42:47833",
			"http://10.0.1.7:47833",
		]);
	});
});

describe("Cloudflare Quick Tunnel manager (non-Tailscale public HTTPS)", () => {
	it("extracts trycloudflare URLs and manages child process start/stop lifecycle", async () => {
		expect(
			extractTryCloudflareUrl("2026-11-02T12:00:00Z INF |  https://bright-sunflower-42.trycloudflare.com  |"),
		).toBe("https://bright-sunflower-42.trycloudflare.com");

		let killed = false;
		const changes: string[] = [];
		const fakeProc = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: () => {
				killed = true;
				fakeProc.emit("exit", 0, null);
				return true;
			},
		});

		const manager = createTunnelManager({
			findBinary: () => "/opt/homebrew/bin/cloudflared",
			spawnProcess: () => fakeProc as never,
			onChange: () => changes.push(manager.status().state),
		});

		expect(manager.status()).toEqual({ available: true, state: "off", url: null, error: null });

		const starting = manager.start(47833);
		expect(manager.status().state).toBe("starting");

		fakeProc.stderr.write("INF +------------------------------------------------------------+\n");
		fakeProc.stderr.write("INF |  https://dazzi-finder-demo.trycloudflare.com               |\n");

		const started = await starting;
		expect(started).toEqual({
			available: true,
			state: "online",
			url: "https://dazzi-finder-demo.trycloudflare.com",
			error: null,
		});

		await manager.stop();
		expect(killed).toBe(true);
		expect(manager.status()).toEqual({ available: true, state: "off", url: null, error: null });
		expect(changes).toContain("online");
	});
});

describe("Auth rate limiter, proxy budget, cookies, and CSRF origin guard", () => {
	it("applies exponential backoff after 5 failures and isolates XFF per loopback proxy while capping shared proxy budget", () => {
		const limiter = createAuthRateLimiter();
		let now = 1_700_000_000_000;
		const client = limiter.clientKey("127.0.0.1", "203.0.113.9");
		expect(client).toBe("203.0.113.9 via 127.0.0.1");

		// Non-loopback peer cannot spoof X-Forwarded-For
		expect(limiter.clientKey("192.168.1.9", "1.2.3.4")).toBe("192.168.1.9");

		for (let i = 0; i < 4; i++) {
			limiter.recordFailure("sign-in", client, now);
			expect(limiter.waitSeconds("sign-in", client, now)).toBe(0);
		}
		// 5th failure triggers 1s wait, 6th -> 2s, 7th -> 4s
		limiter.recordFailure("sign-in", client, now);
		expect(limiter.waitSeconds("sign-in", client, now)).toBe(1);
		limiter.recordFailure("sign-in", client, now + 1100);
		expect(limiter.waitSeconds("sign-in", client, now + 1100)).toBe(2);

		// Admitting the client clears its backoff immediately
		limiter.admit(client, now + 1200);
		expect(limiter.waitSeconds("sign-in", client, now + 1200)).toBe(0);
	});

	it("validates cookies, loopback addresses, HTTPS forwarding, and same-origin mutations", () => {
		expect(isLoopbackAddress("127.0.0.1")).toBe(true);
		expect(isLoopbackAddress("::1")).toBe(true);
		expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
		expect(isLoopbackAddress("192.168.1.2")).toBe(false);

		const cookies = parseCookieHeader("foo=bar; dazzi_device=tok%2B1; broken=%E0%A4%A");
		expect(cookies.get("dazzi_device")).toBe("tok+1");

		expect(isSecureIncomingRequest({ "x-forwarded-proto": "https" }, false)).toBe(true);
		expect(isSecureIncomingRequest({}, false)).toBe(false);

		// Cross-site POST with cookies is blocked
		expect(
			isSameOriginMutation({
				method: "POST",
				headers: {
					host: "localhost:47833",
					origin: "https://evil.example",
					cookie: "dazzi_device=abc",
				},
			}),
		).toBe(false);

		// Same-origin POST behind HTTPS proxy (`x-forwarded-proto: https`) is allowed
		expect(
			isSameOriginMutation({
				method: "POST",
				headers: {
					host: "demo.trycloudflare.com",
					origin: "https://demo.trycloudflare.com",
					"x-forwarded-proto": "https",
					cookie: "dazzi_device=abc",
				},
			}),
		).toBe(true);
	});
});
