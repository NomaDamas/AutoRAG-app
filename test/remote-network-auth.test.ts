import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { normalizeTunnelHostname } from "../src/shared/remote-contract";
import { parseTailscale, startTailscaleServe, stopTailscaleServe, verifyTailscaleOwnerHeader } from "../src/main/remote/tailscale";
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
			servingPort: null,
			serveCommand: null,
			serveUrl: null,
			servePort: null,
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
			servingPort: null,
			serveCommand: "tailscale serve --bg --https=8443 http://127.0.0.1:47833",
			serveUrl: "https://macbook.tailnet-abc.ts.net:8443",
			servePort: 8443,
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

describe("Tailscale serve from the app (one click instead of a terminal command)", () => {
	const recorder = (results: readonly { code: number; stdout?: string; stderr?: string }[]) => {
		const calls: string[][] = [];
		let index = 0;
		const run = async (_binary: string, args: readonly string[]) => {
			calls.push([...args]);
			const result = results[Math.min(index, results.length - 1)] ?? { code: 0 };
			index += 1;
			return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
		};
		return { calls, run };
	};

	it("publishes Dazzi's port on the suggested HTTPS port, in the background, without an interactive prompt", async () => {
		const { calls, run } = recorder([{ code: 0 }]);
		await expect(startTailscaleServe({ binary: "/usr/local/bin/tailscale", httpsPort: 8443, port: 49593, run })).resolves.toEqual({ ok: true });
		expect(calls).toEqual([["serve", "--bg", "--yes", "--https=8443", "http://127.0.0.1:49593"]]);
	});

	it("passes Tailscale's own reason through when serve is refused (HTTPS certificates off, not signed in)", async () => {
		const { run } = recorder([{ code: 1, stderr: "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n https://login.tailscale.com/f/serve?node=n1\n" }]);
		await expect(startTailscaleServe({ binary: "tailscale", httpsPort: 443, port: 47833, run })).resolves.toEqual({
			ok: false,
			reason: "Serve is not enabled on your tailnet.",
			enableUrl: "https://login.tailscale.com/f/serve?node=n1",
		});
	});

	it("removes only the route Dazzi added, never the rest of the user's serve config", async () => {
		const { calls, run } = recorder([{ code: 0 }]);
		await expect(stopTailscaleServe({ binary: "tailscale", httpsPort: 8443, run })).resolves.toEqual({ ok: true });
		expect(calls).toEqual([["serve", "--yes", "--https=8443", "off"]]);
		expect(calls.flat()).not.toContain("reset");
	});

	it("reports the HTTPS port it would publish on, skipping one another service already uses", () => {
		const status = JSON.stringify({ BackendState: "Running", Self: { DNSName: "mac.tail.ts.net.", UserID: 1, TailscaleIPs: ["100.65.93.57"] }, User: { "1": { LoginName: "me@x.com" } } });
		const serve = JSON.stringify({ TCP: { "443": { HTTPS: true } }, Web: { "mac.tail.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7317" } } } } });
		expect(parseTailscale({ status, serve }, 49593)).toMatchObject({ servingUrl: null, servePort: 8443, serveUrl: "https://mac.tail.ts.net:8443" });
		const servingDazzi = JSON.stringify({ TCP: { "8443": { HTTPS: true } }, Web: { "mac.tail.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:49593" } } } } });
		expect(parseTailscale({ status, serve: servingDazzi }, 49593)).toMatchObject({ servingUrl: "https://mac.tail.ts.net:8443", servingPort: 8443, servePort: null });
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

describe("Cloudflare tunnel manager (non-Tailscale public HTTPS)", () => {
	const fakeProcess = () => {
		const proc = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			killed: false,
			kill: () => {
				proc.killed = true;
				proc.emit("exit", 0, null);
				return true;
			},
		});
		return proc;
	};

	it("Quick Tunnel: extracts the random trycloudflare address and manages start/stop", async () => {
		expect(extractTryCloudflareUrl("2026-11-02T12:00:00Z INF |  https://bright-sunflower-42.trycloudflare.com  |")).toBe(
			"https://bright-sunflower-42.trycloudflare.com",
		);
		const proc = fakeProcess();
		const spawned: string[][] = [];
		const changes: string[] = [];
		const manager = createTunnelManager({
			findBinary: () => "/opt/homebrew/bin/cloudflared",
			spawnProcess: (_command, args) => {
				spawned.push([...args]);
				return proc as never;
			},
			hasLogin: () => false,
			onChange: () => changes.push(manager.status().state),
		});

		expect(manager.status()).toMatchObject({ available: true, mode: "quick", hostname: null, state: "off", url: null, errorCode: null });
		const starting = manager.start(47833);
		expect(manager.status().state).toBe("starting");
		proc.stderr.write("INF |  https://dazzi-finder-demo.trycloudflare.com               |\n");
		expect(await starting).toMatchObject({ state: "online", mode: "quick", url: "https://dazzi-finder-demo.trycloudflare.com" });
		// An empty --config keeps the user's own ~/.cloudflared/config.yml ingress rules out of the quick tunnel.
		expect(spawned[0]).toEqual(expect.arrayContaining(["--config", "--url", "http://127.0.0.1:47833"]));

		await manager.stop();
		expect(proc.killed).toBe(true);
		expect(manager.status()).toMatchObject({ state: "off", url: null });
		expect(changes).toContain("online");
	});

	it("own domain: refuses to start before `cloudflared tunnel login`, with a translatable error code", async () => {
		const manager = createTunnelManager({
			findBinary: () => "/opt/homebrew/bin/cloudflared",
			spawnProcess: () => fakeProcess() as never,
			runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
			hasLogin: () => false,
		});
		await manager.setHostname("dazzi.example.com");
		expect(manager.status()).toMatchObject({ mode: "custom", hostname: "dazzi.example.com", loggedIn: false });
		expect(await manager.start(47833)).toMatchObject({ state: "error", errorCode: "login_required", url: null });
	});

	it("own domain: creates the named tunnel once, routes DNS without overwriting, and serves the fixed https address", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "dazzi-named-tunnel-"));
		try {
			const commands: string[][] = [];
			const proc = fakeProcess();
			const spawned: string[][] = [];
			let markSpawned: () => void = () => {};
			const didSpawn = new Promise<void>((resolve) => {
				markSpawned = resolve;
			});
			const manager = createTunnelManager({
				findBinary: () => "/opt/homebrew/bin/cloudflared",
				stateDir,
				hasLogin: () => true,
				runCommand: async (_binary, args) => {
					commands.push([...args]);
					if (args.includes("create")) {
						const credentials = args[args.indexOf("--credentials-file") + 1]!;
						await writeFile(credentials, "{}", "utf8");
					}
					return { code: 0, stdout: "", stderr: "" };
				},
				spawnProcess: (_command, args) => {
					spawned.push([...args]);
					markSpawned();
					return proc as never;
				},
			});
			await manager.setHostname("dazzi.example.com");
			const starting = manager.start(47833);
			await didSpawn;
			proc.stderr.write("INF Registered tunnel connection connIndex=0 location=icn06 protocol=quic\n");
			expect(await starting).toMatchObject({ state: "online", mode: "custom", url: "https://dazzi.example.com", errorCode: null });

			expect(commands[0]).toEqual(expect.arrayContaining(["create", "--credentials-file", "dazzi-dazzi-example-com"]));
			// A record that already points elsewhere is the user's: never --overwrite-dns.
			expect(commands[1]).toEqual(expect.arrayContaining(["route", "dns", "dazzi-dazzi-example-com", "dazzi.example.com"]));
			expect(commands[1]).not.toContain("--overwrite-dns");
			expect(spawned[0]).toEqual(expect.arrayContaining(["run", "--credentials-file", "--url", "http://127.0.0.1:47833", "dazzi-dazzi-example-com"]));

			// The second start reuses the saved credentials: no second `create`.
			await manager.stop();
			const second = fakeProcess();
			let markSecond: () => void = () => {};
			const secondSpawned = new Promise<void>((resolve) => {
				markSecond = resolve;
			});
			const reused = createTunnelManager({
				findBinary: () => "/opt/homebrew/bin/cloudflared",
				stateDir,
				hasLogin: () => true,
				runCommand: async (_binary, args) => {
					commands.push([...args]);
					return { code: 0, stdout: "", stderr: "" };
				},
				spawnProcess: () => {
					markSecond();
					return second as never;
				},
			});
			await reused.setHostname("dazzi.example.com");
			const again = reused.start(47833);
			await secondSpawned;
			second.stderr.write("INF Registered tunnel connection connIndex=0\n");
			expect(await again).toMatchObject({ state: "online" });
			expect(commands.filter((args) => args.includes("create"))).toHaveLength(1);
			await reused.stop();
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	it("own domain: a DNS record the user already owns stops setup with cloudflared's own reason", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "dazzi-named-tunnel-"));
		try {
			const manager = createTunnelManager({
				findBinary: () => "/opt/homebrew/bin/cloudflared",
				stateDir,
				hasLogin: () => true,
				runCommand: async (_binary, args) => {
					if (args.includes("create")) {
						await writeFile(args[args.indexOf("--credentials-file") + 1]!, "{}", "utf8");
						return { code: 0, stdout: "", stderr: "" };
					}
					return { code: 1, stdout: "", stderr: "Failed to add route: code: 1003, reason: An A, AAAA, or CNAME record with that host already exists." };
				},
				spawnProcess: () => fakeProcess() as never,
			});
			await manager.setHostname("www.example.com");
			const result = await manager.start(47833);
			expect(result).toMatchObject({ state: "error", errorCode: "setup_failed" });
			expect(result.error).toContain("record with that host already exists");
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	it("changing the hostname while online stops the tunnel serving the old address", async () => {
		const proc = fakeProcess();
		const manager = createTunnelManager({
			findBinary: () => "/opt/homebrew/bin/cloudflared",
			spawnProcess: () => proc as never,
			hasLogin: () => true,
		});
		const starting = manager.start(47833);
		proc.stderr.write("INF |  https://old-quick.trycloudflare.com |\n");
		await starting;
		await manager.setHostname("dazzi.example.com");
		expect(proc.killed).toBe(true);
		expect(manager.status()).toMatchObject({ state: "off", url: null, mode: "custom" });
	});

	it("validates own-domain hostnames", () => {
		expect(normalizeTunnelHostname(" Dazzi.Example.com. ")).toBe("dazzi.example.com");
		expect(normalizeTunnelHostname("https://dazzi.example.com")).toBeNull();
		expect(normalizeTunnelHostname("dazzi.example.com/path")).toBeNull();
		expect(normalizeTunnelHostname("localhost")).toBeNull();
		expect(normalizeTunnelHostname("*.example.com")).toBeNull();
		expect(normalizeTunnelHostname("-bad.example.com")).toBeNull();
		expect(normalizeTunnelHostname("192.168.0.1")).toBeNull();
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
