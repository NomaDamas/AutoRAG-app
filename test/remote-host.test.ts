import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRemoteHost } from "../src/main/remote/host";
import { DEFAULT_SETTINGS } from "../src/shared/settings-contract";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

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
	it("serves on a nearby port when the configured one is taken, and the status says where", async () => {
		const taken = await occupyPort();
		const remote = await host(() => taken);
		await remote.start();

		const status = await remote.status();
		expect(status.serving).toBe(true);
		expect(status.serverError ?? null).toBeNull();
		expect(status.port).not.toBe(taken);
		expect(status.origin).toContain(`:${status.port}/`);
	});

	it("reports a listen failure as not serving and starts once it is fixed, instead of staying stuck", async () => {
		let host_ = "203.0.113.7"; // TEST-NET-3: not an address of this machine, so listen fails (EADDRNOTAVAIL)
		const stateDir = await mkdtemp(join(tmpdir(), "dazzi-remote-host-"));
		const remote = createRemoteHost({
			rendererRoot: stateDir,
			stateDir,
			get host() {
				return host_;
			},
			port: async () => 0,
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

		await expect(remote.start()).rejects.toThrow();
		const failed = await remote.status();
		expect(failed.serving).toBe(false);
		expect(failed.origin).toBeNull();
		expect(failed.serverError?.message).toMatch(/EADDRNOTAVAIL|address/iu);

		host_ = "127.0.0.1";
		await remote.start();
		const status = await remote.status();
		expect(status.serving).toBe(true);
		expect(status.serverError ?? null).toBeNull();
		expect((await fetch(`http://127.0.0.1:${status.port}/remote/health`)).status).toBe(200);
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
