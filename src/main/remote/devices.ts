/**
 * Paired devices & 6-digit pairing codes for Dazzi remote access,
 * adapted from Ovis (`devswha/ovis`, MIT).
 *
 * The owner starts a pairing on the host and receives a 6-digit code (10-min TTL,
 * 5 wrong attempts burn the code, max 10 codes per 10-min window). A remote browser
 * submits the code once (manually or via `?pair=CODE` QR scan) and receives its own
 * 256-bit `dazzi_device` HttpOnly cookie. Only the SHA-256 digest of that token is
 * stored in `remote-devices.json` (0600, atomic). Revoking a device or revoking all
 * immediately closes active SSE streams bound to those device IDs.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RemotePairedDevice, RemotePairingCode } from "../../shared/remote-contract";
import { writePrivateState } from "./private-state";

const CODE_TTL_MS = 10 * 60_000;
const CODE_ATTEMPTS = 5;
const PAIRING_WINDOW_MS = 10 * 60_000;
const CODE_ISSUES_MAX = 10;
const LAST_SEEN_WRITE_MS = 60_000;
const LABEL_MAX = 48;

export class PairingRateLimitedError extends Error {
	readonly code = "pairing_rate_limited";
	constructor(readonly retryAfterSeconds: number) {
		super("Too many pairing codes requested; try again shortly");
	}
}

export interface StoredRemoteDevice {
	readonly id: string;
	readonly label: string;
	readonly tokenHash: string;
	readonly createdAt: string;
	readonly lastSeenAt: string | null;
}

export interface DeviceMatch {
	readonly id: string;
	readonly label: string;
}

function sha256Hex(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function constantTimeSame(left: string, right: string): boolean {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}

export function normalizeDeviceLabel(value: unknown, fallback = "Device"): string {
	const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX) : "";
	return text || fallback;
}

export function deviceLabelFromUserAgent(userAgent: string, maxTouchPoints = 0): string {
	const ua = userAgent ?? "";
	const device = /iPhone/.test(ua)
		? "iPhone"
		: /iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)
			? "iPad"
			: /Android/.test(ua)
				? "Android"
				: /Macintosh/.test(ua)
					? "Mac"
					: /Windows/.test(ua)
						? "Windows"
						: /CrOS/.test(ua)
							? "Chromebook"
							: /Linux/.test(ua)
								? "Linux"
								: "Device";
	const browser = /Edg\//.test(ua)
		? "Edge"
		: /Firefox\//.test(ua)
			? "Firefox"
			: /Chrome\/|Chromium\//.test(ua)
				? "Chrome"
				: /Safari\//.test(ua)
					? "Safari"
					: null;
	return browser !== null ? `${device} · ${browser}` : device;
}

type RegistryRead =
	| { readonly kind: "missing" }
	| { readonly kind: "ok"; readonly devices: StoredRemoteDevice[] }
	| { readonly kind: "bad" };

const StoredRegistrySchema = z.object({
	devices: z.array(
		z.object({
			id: z.string(),
			label: z.string(),
			tokenHash: z.string(),
			createdAt: z.string(),
			lastSeenAt: z.string().nullable(),
		}),
	),
});

function readRegistry(path: string): RegistryRead {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "bad" };
	}
	try {
		const validated = StoredRegistrySchema.safeParse(JSON.parse(raw));
		return validated.success ? { kind: "ok", devices: validated.data.devices } : { kind: "bad" };
	} catch {
		return { kind: "bad" };
	}
}

export class DeviceStore {
	private devices: StoredRemoteDevice[] = [];
	private pending: { code: string; expires: number; attempts: number } | null = null;
	private codeIssues: number[] = [];
	private readonly path: string;
	private readonly revocations = new Map<string, Set<() => void>>();
	private readonly changeListeners = new Set<() => void>();
	readonly error: string | null = null;

	constructor(stateDir: string) {
		this.path = join(stateDir, "remote-devices.json");
		const read = readRegistry(this.path);
		if (read.kind === "ok") {
			this.devices = read.devices;
		} else if (read.kind === "bad") {
			this.error = `Cannot read ${this.path}. Fix or remove remote-devices.json and restart Dazzi.`;
		}
	}

	private assertWritable(): void {
		if (this.error !== null) throw new Error(this.error);
	}

	private save(nextDevices: StoredRemoteDevice[]): void {
		writePrivateState(this.path, { devices: nextDevices });
	}

	private notifyChanged(): void {
		for (const listener of this.changeListeners) listener();
	}

	onChanged(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => {
			this.changeListeners.delete(listener);
		};
	}

	/** Registers a callback fired immediately when `id` is already absent or later revoked. */
	onRevoke(id: string, close: () => void): () => void {
		if (!this.devices.some((device) => device.id === id)) {
			close();
			return () => {};
		}
		const listeners = this.revocations.get(id) ?? new Set<() => void>();
		listeners.add(close);
		this.revocations.set(id, listeners);
		return () => {
			listeners.delete(close);
			if (listeners.size === 0) this.revocations.delete(id);
		};
	}

	list(currentId: string | null = null): RemotePairedDevice[] {
		return this.devices.map((device) => ({
			id: device.id,
			label: device.label,
			createdAt: device.createdAt,
			lastSeenAt: device.lastSeenAt,
			...(currentId !== null && device.id === currentId ? { current: true } : {}),
		}));
	}

	activePairing(now = Date.now()): RemotePairingCode | null {
		const pending = this.pending;
		if (pending === null || now > pending.expires || pending.attempts >= CODE_ATTEMPTS) return null;
		return { code: pending.code, expiresAt: new Date(pending.expires).toISOString() };
	}

	startPairing(now = Date.now()): RemotePairingCode {
		this.assertWritable();
		this.codeIssues = this.codeIssues.filter((at) => now - at < PAIRING_WINDOW_MS);
		if (this.codeIssues.length >= CODE_ISSUES_MAX) {
			const retryAfter = Math.max(1, Math.ceil(((this.codeIssues[0] ?? now) + PAIRING_WINDOW_MS - now) / 1000));
			throw new PairingRateLimitedError(retryAfter);
		}
		this.codeIssues.push(now);
		const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
		this.pending = { code, expires: now + CODE_TTL_MS, attempts: 0 };
		this.notifyChanged();
		return { code, expiresAt: new Date(this.pending.expires).toISOString() };
	}

	pair(code: string, label: unknown, now = Date.now()): { readonly token: string; readonly device: DeviceMatch } | null {
		this.assertWritable();
		const pending = this.pending;
		if (pending === null || now > pending.expires) {
			if (pending !== null) {
				this.pending = null;
				this.notifyChanged();
			}
			return null;
		}
		const digits = code.replace(/\D/g, "");
		if (!constantTimeSame(digits, pending.code)) {
			pending.attempts += 1;
			if (pending.attempts >= CODE_ATTEMPTS) {
				this.pending = null;
				this.notifyChanged();
			}
			return null;
		}
		const token = randomBytes(32).toString("hex");
		const createdAt = new Date(now).toISOString();
		const stored: StoredRemoteDevice = {
			id: randomBytes(8).toString("hex"),
			label: normalizeDeviceLabel(label),
			tokenHash: sha256Hex(token),
			createdAt,
			lastSeenAt: createdAt,
		};
		const next = [...this.devices, stored];
		this.save(next);
		this.devices = next;
		this.pending = null;
		this.notifyChanged();
		return { token, device: { id: stored.id, label: stored.label } };
	}

	match(token: string | null | undefined, now = Date.now()): DeviceMatch | null {
		if (this.error !== null || !token) return null;
		const digest = sha256Hex(token);
		for (const device of this.devices) {
			if (!constantTimeSame(digest, device.tokenHash)) continue;
			const lastSeen = device.lastSeenAt === null ? 0 : Date.parse(device.lastSeenAt);
			if (now - lastSeen >= LAST_SEEN_WRITE_MS) {
				try {
					const updatedAt = new Date(now).toISOString();
					const next = this.devices.map((item) => (item === device ? { ...item, lastSeenAt: updatedAt } : item));
					this.save(next);
					this.devices = next;
				} catch {
					/* lastSeen telemetry failure never denies a valid device credential */
				}
			}
			return { id: device.id, label: device.label };
		}
		return null;
	}

	rename(id: string, label: unknown): RemotePairedDevice | null {
		this.assertWritable();
		const existing = this.devices.find((item) => item.id === id);
		if (existing === undefined) return null;
		const updated: StoredRemoteDevice = { ...existing, label: normalizeDeviceLabel(label) };
		const next = this.devices.map((item) => (item === existing ? updated : item));
		this.save(next);
		this.devices = next;
		this.notifyChanged();
		return {
			id: updated.id,
			label: updated.label,
			createdAt: updated.createdAt,
			lastSeenAt: updated.lastSeenAt,
		};
	}

	revoke(id: string): boolean {
		this.assertWritable();
		const next = this.devices.filter((item) => item.id !== id);
		if (next.length === this.devices.length) return false;
		this.save(next);
		this.devices = next;
		const listeners = this.revocations.get(id);
		this.revocations.delete(id);
		for (const close of listeners ?? []) close();
		this.notifyChanged();
		return true;
	}

	revokeAll(): string[] {
		this.assertWritable();
		this.save([]);
		const revoked = this.devices.map((item) => item.id);
		this.devices = [];
		this.pending = null;
		const allListeners = [...this.revocations.values()];
		this.revocations.clear();
		for (const set of allListeners) {
			for (const close of set) close();
		}
		this.notifyChanged();
		return revoked;
	}
}
