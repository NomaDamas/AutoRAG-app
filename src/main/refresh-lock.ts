import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** A lock without a heartbeat (an older build wrote it) older than this is treated as abandoned even if its pid was reused. */
export const REFRESH_LOCK_STALE_MS = 2 * 60 * 60_000;
/** How often a holder proves it is still working. */
export const REFRESH_LOCK_HEARTBEAT_MS = 30_000;
/**
 * A holder that has not beaten for this long is gone or wedged, even if its pid
 * is alive (pid reuse, a stopped process). A first index of a big corpus runs for
 * hours, so age since the start cannot be the test: the heartbeat is.
 */
export const REFRESH_LOCK_HEARTBEAT_STALE_MS = 10 * 60_000;

export interface RefreshLockHolder {
	readonly pid: number;
	readonly startedAt: string;
	readonly owner: string;
	/** Last time the holder wrote; absent in locks an older build wrote. */
	readonly heartbeatAt?: string;
}

export interface RefreshLock {
	release(): void;
	/** Record that the holder is alive. The lock does this on its own timer; tests call it directly. */
	beat(): void;
}

export interface RefreshLockOptions {
	readonly owner: string;
	readonly now?: () => number;
	readonly pid?: number;
	readonly isAlive?: (pid: number) => boolean;
	readonly staleMs?: number;
	readonly heartbeatMs?: number;
	readonly heartbeatStaleMs?: number;
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
				const heartbeatAt = typeof record.heartbeatAt === "string" ? { heartbeatAt: record.heartbeatAt } : {};
				return { raw, holder: { pid: record.pid, startedAt: record.startedAt, owner: record.owner, ...heartbeatAt } };
			}
		}
	} catch {
		// fall through: an unreadable lock file counts as abandoned
	}
	return { raw, holder: null };
}

/** Whether `holder` still counts as working: a live pid that beat recently (or, for an older build's lock, started recently). */
function holderIsFresh(holder: RefreshLockHolder, at: number, staleMs: number, heartbeatStaleMs: number): boolean {
	const lastSeen = Date.parse(holder.heartbeatAt ?? holder.startedAt);
	const window = holder.heartbeatAt === undefined ? staleMs : heartbeatStaleMs;
	return !Number.isNaN(lastSeen) && at - lastSeen < window;
}

/**
 * Take the single refresh lock. Returns the lock, or the live holder when
 * another refresh (the scheduled job or the Settings button) already owns it.
 * A lock whose process is gone, or that has stopped beating, is taken over.
 */
export function acquireRefreshLock(path: string, options: RefreshLockOptions): RefreshLock | { readonly heldBy: RefreshLockHolder } {
	const now = options.now ?? Date.now;
	const pid = options.pid ?? process.pid;
	const isAlive = options.isAlive ?? processAlive;
	const staleMs = options.staleMs ?? REFRESH_LOCK_STALE_MS;
	const heartbeatStaleMs = options.heartbeatStaleMs ?? REFRESH_LOCK_HEARTBEAT_STALE_MS;
	const startedAt = new Date(now()).toISOString();
	const body = JSON.stringify({ pid, startedAt, owner: options.owner, heartbeatAt: startedAt });
	mkdirSync(dirname(path), { recursive: true });

	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			writeFileSync(path, body, { flag: "wx" });
			let timer: NodeJS.Timeout | undefined;
			const stop = (): void => clearInterval(timer);
			const beat = (): void => {
				// Prepare first, then check ownership immediately before the rename, so the window in which a
				// takeover could be overwritten is two synchronous calls, not a file write.
				const temporary = `${path}.${pid}.tmp`;
				try {
					writeFileSync(temporary, JSON.stringify({ pid, startedAt, owner: options.owner, heartbeatAt: new Date(now()).toISOString() }));
					const current = readHolder(path)?.holder;
					if (current?.pid !== pid || current.startedAt !== startedAt) {
						// Someone else took the lock after we stopped beating; never write over it.
						stop();
						unlinkSync(temporary);
						return;
					}
					// Rename, not rewrite: a reader must never see a half-written file, which reads as abandoned.
					renameSync(temporary, path);
				} catch {
					// A missed beat only brings the stale window closer.
				}
			};
			const heartbeatMs = options.heartbeatMs ?? REFRESH_LOCK_HEARTBEAT_MS;
			if (heartbeatMs > 0) {
				timer = setInterval(beat, heartbeatMs);
				timer.unref();
			}
			return {
				beat,
				release: () => {
					stop();
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
		if (holder !== null && holderIsFresh(holder, now(), staleMs, heartbeatStaleMs) && isAlive(holder.pid)) return { heldBy: holder };
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
