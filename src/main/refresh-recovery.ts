import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

/**
 * The librarian maps only a few errno codes to a per-file skip (ENOENT, ENOTDIR,
 * EISDIR, EACCES, EPERM); any other error from reading a source file aborts the
 * whole refresh (Marker-Inc-Korea/AutoRAG#1890). Parsing is incremental, so
 * running it again only redoes what is left, which makes a retry cheap. A file
 * that keeps failing is left out of the rest of this run so it cannot block every
 * other document; the next refresh tries it again.
 */

/** Errors that come and go: descriptor pressure, a file another program holds, a flaky disk or share. */
const TRANSIENT: Record<string, true> = { EMFILE: true, ENFILE: true, EBUSY: true, EAGAIN: true, EIO: true, ETIMEDOUT: true, ECONNRESET: true, EINTR: true };
/** Of those, the ones that belong to one file rather than to the process. */
const PER_FILE: Record<string, true> = { EBUSY: true, EIO: true, ETIMEDOUT: true, EAGAIN: true };

export const RECOVERY_BACKOFF_MS: readonly number[] = [2_000, 6_000];
/** At most this many files are left out of one run; beyond it something is wrong with more than a file. */
export const MAX_QUARANTINED = 10;

export interface RecoveryDeps {
	/** Only files under these roots may be left out; an error in the workspace is not a document. */
	readonly searchPaths: readonly string[];
	readonly sleep?: (ms: number) => Promise<void>;
	readonly backoffMs?: readonly number[];
}

export interface RecoveryOutcome<T> {
	readonly value: T;
	readonly retries: number;
	readonly quarantined: readonly string[];
	/** The errno that was retried or worked around; null when the first attempt succeeded. */
	readonly code: string | null;
}

function errnoOf(error: unknown): { readonly code: string; readonly path: string | undefined } | null {
	if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string") return null;
	return { code: error.code, path: "path" in error && typeof error.path === "string" ? error.path : undefined };
}

/**
 * Run `attempt` (given the files to leave out) until it succeeds or fails for a
 * reason that is not transient. Each file gets its own retry budget before it is
 * left out; every other error, and an exhausted budget, is thrown as it was.
 */
export async function runWithRecovery<T>(attempt: (excluded: readonly string[]) => Promise<T>, deps: RecoveryDeps): Promise<RecoveryOutcome<T>> {
	const sleep =
		deps.sleep ??
		((ms: number) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, ms);
			return promise;
		});
	const backoff = deps.backoffMs ?? RECOVERY_BACKOFF_MS;
	// The librarian pins search roots to their real path, so a failing file's path is canonical;
	// a root configured through a symlink only matches through that form (see search-roots.ts).
	const roots = await Promise.all(
		deps.searchPaths.map(async (root) => {
			const resolved = resolve(root);
			return [resolved, await realpath(resolved).catch(() => resolved)] as const;
		}),
	);
	const quarantined: string[] = [];
	let retries = 0;
	// Failures counted per file, not per error code: a file that alternates EBUSY and EIO still runs out of budget.
	const failures = new Map<string, number>();
	let lastCode: string | null = null;
	for (;;) {
		try {
			return { value: await attempt(quarantined), retries, quarantined, code: lastCode };
		} catch (error) {
			const errno = errnoOf(error);
			if (errno === null || TRANSIENT[errno.code] !== true) throw error;
			const key = errno.path ?? "";
			const streak = (failures.get(key) ?? 0) + 1;
			failures.set(key, streak);
			lastCode = errno.code;
			if (streak <= backoff.length) {
				retries += 1;
				await sleep(backoff[streak - 1] ?? 0);
				continue;
			}
			const file = errno.path === undefined ? undefined : resolve(errno.path);
			const leavable =
				file !== undefined &&
				PER_FILE[errno.code] === true &&
				roots.some((prefixes) => prefixes.some((prefix) => file.startsWith(prefix.endsWith(sep) ? prefix : `${prefix}${sep}`))) &&
				!quarantined.includes(file) &&
				quarantined.length < MAX_QUARANTINED;
			if (!leavable) throw error;
			quarantined.push(file);
			failures.delete(key);
		}
	}
}
