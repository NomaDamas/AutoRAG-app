import { readFileSync, statSync } from "node:fs";

/**
 * Reads of files the librarian replaces by rename (`refresh-progress.json`, `parsed/index.json`).
 *
 * It writes them as `<file>.<uuid>.tmp` + `rename(tmp, file)`. On Windows that rename fails with `EPERM` when
 * anything holds the destination open without delete sharing, and a Node *async* read does: `fs.promises.readFile`
 * opens a handle and keeps it across event-loop turns, so a poller in this process turns a refresh into
 * `EPERM: operation not permitted, rename ... refresh-progress.json` at the first progress write (measured on
 * Windows 11 with the pinned librarian: 12/12 async-read runs failed within 0.2-1 s, 0/12 with these sync reads, all
 * 3000-poll variants included).
 *
 * `readFileSync` opens, reads and closes inside one call, so the handle never outlives the call. These files are
 * a few hundred bytes to a few KB and read once a second, so the blocking read costs microseconds.
 */

export interface LibrarianFileStat {
	readonly mtimeMs: number;
	readonly size: number;
}

/** The file's text, or `null` when it is missing or unreadable. */
export function readLibrarianFile(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** The file's mtime and size, or `null` when it is missing or unreadable. */
export function statLibrarianFile(path: string): LibrarianFileStat | null {
	try {
		const { mtimeMs, size } = statSync(path);
		return { mtimeMs, size };
	} catch {
		return null;
	}
}
