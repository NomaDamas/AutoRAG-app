import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRemoteHost } from "../src/main/remote/host";
import { DEFAULT_SETTINGS } from "../src/shared/settings-contract";
import type * as Tailscale from "../src/main/remote/tailscale";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
// Only the CLI read is replaced; the server keeps the real tailnet-address checks.
vi.mock("../src/main/remote/tailscale", async (importOriginal) => ({
	...(await importOriginal<typeof Tailscale>()),
	readTailscaleStatus: async () => ({ state: "missing", dnsName: null, tailnetIp: null, owner: null, servingUrl: null, serveCommand: null, serveUrl: null }),
}));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Something else (another Dazzi) already listening on a port. */
async function occupyPort(): Promise<number> {
	const blocker: Server = createServer();
	await new Promise<void>((resolve) => blocker.listen(0, "0.0.0.0", () => resolve()));
	cleanups.push(() => new Promise((resolve) => blocker.close(() => resolve())));
	const address = blocker.address();
	if (address === null || typeof address === "string") throw new Error("no port");
	return address.port;
}

async function host(port: () => number) {
	const stateDir = await mkdtemp(join(tmpdir(), "dazzi-remote-host-"));
	const remote = createRemoteHost({
		rendererRoot: stateDir,
		stateDir,
		host: "0.0.0.0",
		port: async () => port(),
		icons: { read: () => null } as never,
		workerHost: { remoteClient: () => ({ client: { call: async () => null, onPush: () => undefined }, close: () => undefined }) } as never,
		targets: {},
		window: () => null,
		settings: async () => DEFAULT_SETTINGS,
		log: () => undefined,
	});
	cleanups.push(async () => {
		await remote.stop();
		await rm(stateDir, { recursive: true, force: true });
	});
	return remote;
}

describe("remote host start-up", () => {
	it("reports a taken port as not serving, with the port and a free one to use instead", async () => {
		const taken = await occupyPort();
		const remote = await host(() => taken);

		await expect(remote.start()).rejects.toThrow(/EADDRINUSE/u);

		const status = await remote.status();
		expect(status.serving).toBe(false);
		expect(status.origin).toBeNull();
		expect(status.serverError).toMatchObject({ code: "port_in_use", port: taken });
		const suggested = status.serverError?.code === "port_in_use" ? status.serverError.suggestedPort : null;
		expect(suggested).not.toBeNull();
		expect(suggested).not.toBe(taken);
	});

	it("starts once the port is free or changed, instead of staying stuck on the failed attempt", async () => {
		const taken = await occupyPort();
		let port = taken;
		const remote = await host(() => port);
		await expect(remote.start()).rejects.toThrow();

		const free = (await remote.status()).serverError;
		port = free?.code === "port_in_use" && free.suggestedPort !== null ? free.suggestedPort : 0;
		await remote.start();

		const status = await remote.status();
		expect(status.serving).toBe(true);
		expect(status.serverError ?? null).toBeNull();
		expect(status.port).toBe(port);
		const response = await fetch(`http://127.0.0.1:${status.port}/`);
		expect(response.status).not.toBe(0);
	});

	it("moves a running server to a new port when the port setting changes", async () => {
		let port = 0;
		const remote = await host(() => port);
		await remote.start();
		const first = (await remote.status()).port;

		port = await (async () => {
			const probe = createServer();
			await new Promise<void>((resolve) => probe.listen(0, "0.0.0.0", () => resolve()));
			const address = probe.address();
			await new Promise<void>((resolve) => probe.close(() => resolve()));
			return typeof address === "object" && address !== null ? address.port : 0;
		})();
		await remote.start();

		const status = await remote.status();
		expect(status.serving).toBe(true);
		expect(status.port).toBe(port);
		expect(status.port).not.toBe(first);
	});

	it("does not interleave two starts that arrive together", async () => {
		const remote = await host(() => 0);
		const [a, b] = await Promise.all([remote.start(), remote.start()]);
		expect(a).toBe(b);
		expect((await remote.status()).serving).toBe(true);
	});
});
