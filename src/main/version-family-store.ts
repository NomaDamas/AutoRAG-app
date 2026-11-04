/**
 * Persisted dupey scan results — the app's single source of truth for version
 * stacks. Lives under Electron's userData directory so a restart serves the
 * last scan from disk instead of re-running the dupey CLI.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FsVersionFamily } from "../shared/fs-contract";
import type { FileStamp } from "./version-family-verify";

/**
 * Snapshot format. 2: family entries carry `mtimeMs` / `flags` (FS roadmap #100);
 * an older snapshot reads as missing, so the service rescans and rewrites it.
 *
 * Fields added since are optional and an older snapshot lacks them (`splitLocations`, `timedOutScopes`), so they did not
 * raise the version: a bump would make every existing snapshot read as missing, and the rescan that follows is the
 * 120 s per folder these fields exist to avoid. A build that does not know a field ignores it and drops it on its next write.
 */
export const VERSION_FAMILY_STORE_VERSION = 2;

/** One folder whose dupey scan hit its time limit, kept so a restart does not run the same scan again. */
export interface StoredTimedOutScope {
	/** Display name of the folder, as the scan failure shows it. */
	readonly name: string;
	/** The folder dupey was asked to scan. */
	readonly path: string;
	/** Immediate subfolders of `path` that scan skipped. */
	readonly excludeDirs: readonly string[];
	/** dupey's message for the time-out. */
	readonly message: string;
	/** ISO time the scan hit its limit. */
	readonly at: string;
}

export interface StoredVersionFamilies {
	readonly version: typeof VERSION_FAMILY_STORE_VERSION;
	/**
	 * ISO timestamp of the scan that produced this snapshot. Null when no scan has read anything yet and the snapshot
	 * exists only to remember what the scans that failed learned (a time-out, a split).
	 */
	readonly scannedAt: string | null;
	/** Location roots the snapshot covers. */
	readonly locations: readonly string[];
	readonly families: readonly FsVersionFamily[];
	readonly stamps?: Readonly<Record<string, FileStamp>>;
	/**
	 * Cloud drives whose whole-root scan hit the time limit. They are scanned folder by folder from then on, so a restart
	 * does not start another whole-root scan that is bound to time out the same way (and ask the drive to download files
	 * for it). Checking again reads the drive whole once more and removes it from here if that finishes.
	 */
	readonly splitLocations?: readonly string[];
	/**
	 * Folders whose scan hit the time limit. Scheduled scans skip them, also after a restart; only the person asking to
	 * check again scans them once more.
	 */
	readonly timedOutScopes?: readonly StoredTimedOutScope[];
}

export interface VersionFamilyStore {
	read(): Promise<StoredVersionFamilies | null>;
	write(value: StoredVersionFamilies): Promise<void>;
}

function isStored(value: unknown): value is StoredVersionFamilies {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<StoredVersionFamilies>;
	return (
		candidate.version === VERSION_FAMILY_STORE_VERSION &&
		(typeof candidate.scannedAt === "string" || candidate.scannedAt === null) &&
		Array.isArray(candidate.locations) &&
		Array.isArray(candidate.families)
	);
}

function isTimedOutScope(value: unknown): value is StoredTimedOutScope {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<StoredTimedOutScope>;
	return (
		typeof candidate.name === "string" &&
		typeof candidate.path === "string" &&
		Array.isArray(candidate.excludeDirs) &&
		candidate.excludeDirs.every((name) => typeof name === "string") &&
		typeof candidate.message === "string" &&
		typeof candidate.at === "string"
	);
}

/** A hand-edited or half-written entry costs that folder its memory, not the snapshot. */
function withValidTimedOutScopes(stored: StoredVersionFamilies): StoredVersionFamilies {
	const raw: unknown = stored.timedOutScopes;
	if (raw === undefined) return stored;
	const { timedOutScopes: _dropped, ...rest } = stored;
	const kept = Array.isArray(raw) ? raw.filter(isTimedOutScope) : [];
	return kept.length === 0 ? rest : { ...rest, timedOutScopes: kept };
}

export function createFileVersionFamilyStore(directory: string): VersionFamilyStore {
	const path = join(directory, "version-families.json");
	const tempPath = `${path}.tmp`;
	return {
		async read(): Promise<StoredVersionFamilies | null> {
			try {
				const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
				return isStored(parsed) ? withValidTimedOutScopes(parsed) : null;
			} catch {
				// Missing or unreadable snapshot: the service scans and rewrites it.
				return null;
			}
		},
		async write(value: StoredVersionFamilies): Promise<void> {
			await mkdir(directory, { recursive: true });
			await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
			await rename(tempPath, path);
		},
	};
}
