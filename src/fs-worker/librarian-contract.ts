/**
 * What the fs worker and its librarian thread say to each other, over the same request/response protocol the worker
 * speaks with its clients (`src/shared/fs-worker-protocol.ts`).
 *
 * The thread exists because loading `@autorag/librarian` costs ~2 s on the event loop of whatever thread loads it
 * (1.9 s measured on Windows, 0.5 s on a Mac): in the worker itself, that is 2 s in which no folder listing is answered.
 * In a thread of its own the worker keeps listing while the librarian loads.
 */

import type { WorkerPort } from "../shared/fs-worker-protocol";

/** Worker → thread requests. */
export const LIBRARIAN_OP = {
	fileNameSearch: "fileNameSearch",
	fileNameEnsureDaemon: "fileNameEnsureDaemon",
	fileNameStop: "fileNameStop",
	scanDuplicates: "scanDuplicates",
	indexStatus: "indexStatus",
	setIndexExcluded: "setIndexExcluded",
	setLanguage: "setLanguage",
	/**
	 * Stop the file-name index and let the librarian clean up the child processes it started. The librarian does that
	 * on the process's `exit` event, which a thread never gets when it is terminated, so the thread raises it itself.
	 */
	shutdown: "shutdown",
} as const;

/** Thread → worker requests: what only the worker can answer. */
export const LIBRARIAN_REQUEST = {
	/** The sidebar locations, which the Everything index covers. */
	locations: "locations",
} as const;

/** Thread → worker pushes. */
export const LIBRARIAN_PUSH = {
	/** The index refresh a toggle started settled; payload is its error or null. */
	indexRefreshed: "indexRefreshed",
	/** An `ErrorReport` for the worker's error reporter, which the thread has none of. */
	report: "report",
} as const;

/** One running librarian thread, as the worker's client sees it. */
export interface LibrarianThread {
	readonly port: WorkerPort;
	/** Fires once when the thread ends, however it ended: its exit code, or the error that took it down. */
	onExit(listener: (code: number | null, error: Error | null) => void): void;
	terminate(): Promise<void>;
}

/** Workdata a real thread starts with. */
export interface LibrarianThreadData {
	readonly userDataDir: string;
}
