import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** A lock older than this is treated as abandoned even if its pid was reused. */
export const REFRESH_LOCK_STALE_MS = 2 * 60 * 60_000;

export interface RefreshLockHolder {
	readonly pid: number;
	readonly startedAt: string;
	readonly owner: string;
}

export interface RefreshLock {
	release(): void;
}

export interface RefreshLockOptions {
	readonly owner: string;
	readonly now?: () => number;
	readonly pid?: number;
	readonly isAlive?: (pid: number) => boolean;
	readonly staleMs?: number;
}

/** The `code` of a thrown fs/process error, or `undefined` when the value carries none. */
function errorCode(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
	return undefined;
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to someone else.
		return errorCode(error) === "EPERM";
	}
}

function readHolder(path: string): { readonly raw: string; readonly holder: RefreshLockHolder | null } | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null) {
			const record = parsed as Record<string, unknown>;
			if (typeof record.pid === "number" && typeof record.startedAt === "string" && typeof record.owner === "string") {
				return { raw, holder: { pid: record.pid, startedAt: record.startedAt, owner: record.owner } };
			}
		}
	} catch {
		// fall through: an unreadable lock file counts as abandoned
	}
	return { raw, holder: null };
}

/**
 * Take the single refresh lock. Returns the lock, or the live holder when
 * another refresh (the scheduled job or the Settings button) already owns it.
 * A lock whose process is gone, or that is older than `staleMs`, is taken over.
 */
export function acquireRefreshLock(path: string, options: RefreshLockOptions): RefreshLock | { readonly heldBy: RefreshLockHolder } {
	const now = options.now ?? Date.now;
	const pid = options.pid ?? process.pid;
	const isAlive = options.isAlive ?? processAlive;
	const staleMs = options.staleMs ?? REFRESH_LOCK_STALE_MS;
	const body = JSON.stringify({ pid, startedAt: new Date(now()).toISOString(), owner: options.owner });
	mkdirSync(dirname(path), { recursive: true });

	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			writeFileSync(path, body, { flag: "wx" });
			return {
				release: () => {
					// Only remove our own lock; a takeover after a stale timeout must survive.
					const current = readHolder(path);
					if (current?.holder?.pid === pid) {
						try {
							unlinkSync(path);
						} catch {
							// already gone
						}
					}
				},
			};
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
		const existing = readHolder(path);
		if (existing === null) continue;
		const { holder, raw } = existing;
		if (holder !== null) {
			const age = now() - Date.parse(holder.startedAt);
			const fresh = !Number.isNaN(age) && age < staleMs;
			if (fresh && isAlive(holder.pid)) return { heldBy: holder };
		}
		// Abandoned: remove it only if nobody replaced it since we read it.
		if (readHolder(path)?.raw === raw) {
			try {
				unlinkSync(path);
			} catch {
				// someone else removed it first
			}
		}
	}
	const holder = readHolder(path)?.holder;
	return { heldBy: holder ?? { pid: -1, startedAt: new Date(now()).toISOString(), owner: "unknown" } };
}

export function isLockHeld(result: RefreshLock | { readonly heldBy: RefreshLockHolder }): result is { readonly heldBy: RefreshLockHolder } {
	return "heldBy" in result;
}
