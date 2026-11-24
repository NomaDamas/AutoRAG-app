import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The anonymous device identity the app presents to the hosted service before
 * anyone signs in.
 *
 * The value is never a raw hardware identifier: it is the SHA-256 of a stable
 * seed under the `dazzi-device-v1:` namespace, so the server only ever sees 64
 * lowercase hex characters it can group a free trial by. The seed is the OS's
 * own install identity where one exists (macOS IOPlatformUUID, Windows
 * MachineGuid, Linux machine-id); where no probe works, a random seed is
 * generated once and kept in `<home>/.autorag/device-seed` with owner-only
 * permissions. Unpackaged builds may override the seed through
 * `AUTORAG_DEV_DEVICE_SEED` so onboarding and QA always look like a fresh
 * machine; a packaged build ignores the variable.
 */

const PROBE_TIMEOUT_MS = 5_000;
const DEVICE_NAMESPACE = "dazzi-device-v1:";
const FALLBACK_SEED_FILE = join(".autorag", "device-seed");

/** The hash prefix the server expects on `device_id`; the same on every platform and build. */
export function hashDeviceSeed(seed: string): string {
	return createHash("sha256").update(`${DEVICE_NAMESPACE}${seed.trim().toLowerCase()}`).digest("hex");
}

export interface ResolveAnonymousDeviceIdOptions {
	readonly platform: NodeJS.Platform;
	/** The user's home directory; the fallback seed lives under it. */
	readonly home: string;
	readonly env: NodeJS.ProcessEnv;
	/** When true, `AUTORAG_DEV_DEVICE_SEED` is ignored (release builds are never dev-overridable). */
	readonly packaged: boolean;
	/** Injectable command runner; defaults to `execFile` with a 5 s timeout and `windowsHide`. */
	readonly runCommand?: (cmd: string, args: readonly string[]) => Promise<string>;
}

function defaultRunCommand(cmd: string, args: readonly string[]): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	execFile(cmd, [...args], { timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
		if (error !== null) reject(error);
		else resolve(stdout);
	});
	return promise;
}

async function probeDarwin(run: (cmd: string, args: readonly string[]) => Promise<string>): Promise<string | null> {
	try {
		const output = await run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
		return output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] ?? null;
	} catch {
		return null;
	}
}

async function probeWin32(run: (cmd: string, args: readonly string[]) => Promise<string>): Promise<string | null> {
	try {
		const output = await run("reg", ["query", "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]);
		return output.match(/MachineGuid\s+REG_SZ\s+(\S+)/i)?.[1] ?? null;
	} catch {
		return null;
	}
}

async function probeLinux(): Promise<string | null> {
	for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
		try {
			const value = (await readFile(path, "utf8")).trim();
			if (value.length > 0) return value;
		} catch {
			// Try the next well-known path.
		}
	}
	return null;
}

/** The random seed kept between runs when no OS probe works; created once, owner-only. */
async function readOrCreateFallbackSeed(home: string): Promise<string> {
	const file = join(home, FALLBACK_SEED_FILE);
	if (existsSync(file)) {
		try {
			const value = (await readFile(file, "utf8")).trim();
			if (value.length > 0) return value;
		} catch {
			// Unreadable: regenerate below; the write fails loudly if it is truly stuck.
		}
	}
	await mkdir(join(home, ".autorag"), { recursive: true });
	const seed = randomUUID();
	try {
		await writeFile(file, seed, { encoding: "utf8", mode: 0o600, flag: "wx" });
	} catch {
		const value = (await readFile(file, "utf8")).trim();
		if (value.length > 0) return value;
	}
	return seed;
}

/** The `device_id` the app sends to the hosted service for anonymous access. */
export async function resolveAnonymousDeviceId(options: ResolveAnonymousDeviceIdOptions): Promise<string> {
	if (!options.packaged) {
		const override = options.env.AUTORAG_DEV_DEVICE_SEED?.trim();
		if (override !== undefined && override.length > 0) return hashDeviceSeed(override);
	}
	const run = options.runCommand ?? defaultRunCommand;
	const probe =
		options.platform === "darwin"
			? await probeDarwin(run)
			: options.platform === "win32"
				? await probeWin32(run)
				: options.platform === "linux"
					? await probeLinux()
					: null;
	const trimmed = probe?.trim();
	if (trimmed !== undefined && trimmed.length > 0) return hashDeviceSeed(trimmed);
	return hashDeviceSeed(await readOrCreateFallbackSeed(options.home));
}
