import { stat, writeFile, mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DeviceStore,
	PairingRateLimitedError,
	deviceLabelFromUserAgent,
} from "../src/main/remote/devices";
import { writePrivateState } from "../src/main/remote/private-state";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "remote-devices-test-"));
	directories.push(dir);
	return dir;
}

describe("private-state atomic 0600 writer", () => {
	it("writes whole JSON atomically with owner-only permissions on POSIX", async () => {
		const dir = await tempDir();
		const target = join(dir, "nested", "remote-devices.json");
		writePrivateState(target, { devices: [] });
		const raw = await readFile(target, "utf8");
		expect(JSON.parse(raw)).toEqual({ devices: [] });
		if (process.platform !== "win32") {
			const info = await stat(target);
			expect(info.mode & 0o777).toBe(0o600);
		}
	});
});

describe("remote DeviceStore (Ovis pairing & device credentials)", () => {
	it("mints a 6-digit pairing code with 10-minute TTL and exchanges it for a hashed persistent device token", async () => {
		const dir = await tempDir();
		const store = new DeviceStore(dir);
		const now = 1_700_000_000_000;

		const pairing = store.startPairing(now);
		expect(pairing.code).toMatch(/^\d{6}$/);
		expect(Date.parse(pairing.expiresAt)).toBe(now + 10 * 60_000);
		expect(store.activePairing(now)).toEqual(pairing);

		const enrolledEvents: string[] = [];
		store.onChanged(() => enrolledEvents.push("changed"));

		//Formatted with spaces ("123 456") also matches after digit normalization.
		const spaced = `${pairing.code.slice(0, 3)} ${pairing.code.slice(3)}`;
		const result = store.pair(spaced, "iPhone · Safari", now + 1000);
		expect(result).not.toBeNull();
		expect(result?.token).toMatch(/^[0-9a-f]{64}$/);
		expect(result?.device.label).toBe("iPhone · Safari");
		expect(store.activePairing(now + 1000)).toBeNull();
		expect(enrolledEvents.length).toBeGreaterThan(0);

		// Raw token is never stored on disk; only its SHA-256 digest is persisted.
		const onDisk = await readFile(join(dir, "remote-devices.json"), "utf8");
		expect(onDisk).not.toContain(result!.token);
		expect(JSON.parse(onDisk).devices).toHaveLength(1);

		// Re-loading from disk recognizes the same token and updates lastSeenAt.
		const reloaded = new DeviceStore(dir);
		const matched = reloaded.match(result!.token, now + 120_000);
		expect(matched).toMatchObject({ id: result!.device.id, label: "iPhone · Safari" });
		expect(reloaded.list(matched!.id)[0]).toMatchObject({
			id: result!.device.id,
			current: true,
			lastSeenAt: new Date(now + 120_000).toISOString(),
		});
	});

	it("burns the pending pairing code after 5 wrong guesses and rejects expired codes", async () => {
		const dir = await tempDir();
		const store = new DeviceStore(dir);
		const now = 1_700_000_000_000;
		const pairing = store.startPairing(now);
		const wrong = pairing.code === "000000" ? "999999" : "000000";

		for (let attempt = 0; attempt < 5; attempt++) {
			expect(store.pair(wrong, "Attacker", now + 1000)).toBeNull();
		}
		// 6th attempt with the RIGHT code fails because the 5 wrong guesses burned it.
		expect(store.pair(pairing.code, "Owner", now + 1000)).toBeNull();
		expect(store.activePairing(now + 1000)).toBeNull();

		// Fresh code expires after 10 minutes.
		const second = store.startPairing(now + 2000);
		expect(store.pair(second.code, "Owner", now + 2000 + 10 * 60_000 + 1)).toBeNull();
	});

	it("rate-limits pairing code issuance to 10 codes per 10-minute window", async () => {
		const dir = await tempDir();
		const store = new DeviceStore(dir);
		const now = 1_700_000_000_000;

		for (let i = 0; i < 10; i++) {
			store.startPairing(now + i * 100);
		}
		expect(() => store.startPairing(now + 5_000)).toThrow(PairingRateLimitedError);
		// After 10 minutes pass, issuance succeeds again.
		expect(store.startPairing(now + 10 * 60_000 + 1000).code).toMatch(/^\d{6}$/);
	});

	it("renames, revokes individual devices with live listener callbacks, and revokes all devices", async () => {
		const dir = await tempDir();
		const store = new DeviceStore(dir);
		const now = 1_700_000_000_000;

		const c1 = store.startPairing(now);
		const d1 = store.pair(c1.code, "iPad · Safari", now)!;
		const c2 = store.startPairing(now + 100);
		const d2 = store.pair(c2.code, "Windows · Chrome", now + 100)!;

		let d1Revoked = false;
		let d2Revoked = false;
		store.onRevoke(d1.device.id, () => {
			d1Revoked = true;
		});
		store.onRevoke(d2.device.id, () => {
			d2Revoked = true;
		});

		// Rename does NOT revoke active sessions.
		const renamed = store.rename(d1.device.id, "  My   Work iPad  ");
		expect(renamed?.label).toBe("My Work iPad");
		expect(d1Revoked).toBe(false);

		// Individual revoke drops d1 and fires its revocation listener.
		expect(store.revoke(d1.device.id)).toBe(true);
		expect(d1Revoked).toBe(true);
		expect(d2Revoked).toBe(false);
		expect(store.match(d1.token, now + 500)).toBeNull();
		expect(store.match(d2.token, now + 500)).not.toBeNull();

		// Pending pairing code is also cleared on revokeAll.
		store.startPairing(now + 600);
		expect(store.revokeAll()).toEqual([d2.device.id]);
		expect(d2Revoked).toBe(true);
		expect(store.activePairing(now + 600)).toBeNull();
		expect(store.list(null)).toEqual([]);
	});

	it("fails closed when remote-devices.json is corrupted on disk", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "remote-devices.json"), "{broken json", "utf8");
		const store = new DeviceStore(dir);
		expect(store.error).not.toBeNull();
		expect(() => store.startPairing()).toThrow();
		expect(store.match("anything")).toBeNull();
	});

	it("derives readable device labels from User-Agent strings", () => {
		expect(deviceLabelFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1")).toBe("iPhone · Safari");
		expect(deviceLabelFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36")).toBe("Windows · Chrome");
		expect(deviceLabelFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15", 5)).toBe("iPad · Safari");
	});
});
