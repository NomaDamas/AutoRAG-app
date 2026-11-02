/**
 * The fs worker's handle on the librarian thread: the services that need `@autorag/librarian` (the file-name index,
 * the dupey scan, the AutoRAG index status) behind the same calls the worker made when it imported them directly.
 *
 * Loading the librarian takes ~2 s and every millisecond of it is on the event loop of the thread that loads it, so a
 * worker that imported it could not answer a folder listing until it was done: the first row came 3.5 s after the
 * window on Windows. The thread loads it instead, lazily (the first call starts it), and the worker keeps listing.
 *
 * A thread that dies fails the calls waiting on it with its own reason, and the next call starts a fresh one. The
 * interface language is remembered and re-sent, since a fresh thread starts in the fallback language.
 */

import type { DupeyScanResult } from "@autorag/librarian";
import { createWorkerClient, serveWorkerPort, type WorkerClient } from "../shared/fs-worker-protocol";
import { t } from "../shared/i18n/core";
import type { AppLanguage } from "../shared/i18n/core";
import type { FsLocation } from "../shared/fs-contract";
import type { IndexStatus } from "../shared/index-contract";
import type { ErrorReport } from "../main/error-report-core";
import type { FileNameSearchBackend } from "../main/file-name-search";
import { LIBRARIAN_OP, LIBRARIAN_PUSH, LIBRARIAN_REQUEST, type LibrarianThread } from "./librarian-contract";

export interface LibrarianClientDeps {
	/** Starts one thread. Called at most once per live thread, and never before a call needs it. */
	readonly spawn: () => LibrarianThread;
	/** The sidebar locations, for the thread's Everything index. */
	readonly locations: () => Promise<readonly FsLocation[]>;
	/** An index refresh a toggle started settled; the payload is its error, or null. */
	readonly onIndexRefreshed: (error: string | null) => void;
	/** A report the thread raised; the worker owns the error reporter. */
	readonly onReport: (report: ErrorReport) => void;
	/**
	 * Longest `dispose` waits for the thread to wind down before ending it anyway. Defaults to 1800 ms: main gives the whole
	 * worker dispose 2000 ms (`QUIT_DISPOSE_MS`) and kills the worker at the limit. The index daemon's stop queues behind an
	 * index run still in flight and can take most of that, so a shorter bound ends the thread before the daemon is told to exit.
	 */
	readonly shutdownMs?: number;
}

export interface LibrarianClient {
	readonly fileNameSearch: FileNameSearchBackend;
	scanDuplicates(dir: string): Promise<DupeyScanResult>;
	readonly indexStatus: {
		indexStatus(paths: readonly string[]): Promise<readonly IndexStatus[]>;
		setIndexExcluded(path: string, excluded: boolean): Promise<IndexStatus>;
	};
	/** Remembered for every thread, and sent to the running one. */
	setLanguage(language: AppLanguage): Promise<void>;
	/**
	 * Stops the file-name index and the child processes the librarian started, then ends the thread; later calls reject.
	 * Starts nothing when no thread is running.
	 */
	dispose(): Promise<void>;
}

interface Running {
	readonly thread: LibrarianThread;
	readonly client: WorkerClient;
	/** The language is set before the first call goes out. */
	readonly ready: Promise<unknown>;
	readonly inFlight: Set<(error: Error) => void>;
}

export function createLibrarianClient(deps: LibrarianClientDeps): LibrarianClient {
	let running: Running | null = null;
	let disposed = false;
	let language: AppLanguage | null = null;

	function start(): Running {
		const thread = deps.spawn();
		const client = createWorkerClient();
		const inFlight = new Set<(error: Error) => void>();
		// Requests the thread makes of the worker, answered on the same port.
		serveWorkerPort(thread.port, { [LIBRARIAN_REQUEST.locations]: () => deps.locations() });
		client.attach(thread.port);
		client.onPush(LIBRARIAN_PUSH.indexRefreshed, (payload) => deps.onIndexRefreshed(typeof payload === "string" ? payload : null));
		client.onPush(LIBRARIAN_PUSH.report, (payload) => deps.onReport(payload as ErrorReport));
		const started: Running = {
			thread,
			client,
			ready: language === null ? Promise.resolve() : client.call(LIBRARIAN_OP.setLanguage, [language]),
			inFlight,
		};
		// Nothing awaits `ready` when no call follows, and a failure of it reaches every call that does.
		started.ready.catch(() => undefined);
		thread.onExit((code, error) => {
			if (running === started) running = null;
			const reason = new Error(error === null ? t("main.worker.librarianExited", { code: code ?? "?" }) : t("main.worker.librarianFailed", { message: error.message }));
			for (const reject of [...inFlight]) reject(reason);
			inFlight.clear();
		});
		return started;
	}

	async function call<T>(op: string, args: readonly unknown[] = []): Promise<T> {
		if (disposed) throw new Error(t("main.worker.librarianStopped"));
		running ??= start();
		const current = running;
		const failed = Promise.withResolvers<never>();
		current.inFlight.add(failed.reject);
		try {
			return await Promise.race([current.ready.then(() => current.client.call<T>(op, args)), failed.promise]);
		} finally {
			current.inFlight.delete(failed.reject);
		}
	}

	/** Stopping goes to a thread that already runs; one that does not run has nothing to stop. */
	async function callIfRunning(op: string): Promise<void> {
		if (running !== null) await call(op);
	}

	return {
		fileNameSearch: {
			search: (query, scope) => call(LIBRARIAN_OP.fileNameSearch, scope === undefined ? [query] : [query, scope]),
			ensureDaemon: async () => {
				try {
					await call(LIBRARIAN_OP.fileNameEnsureDaemon);
				} catch (error) {
					console.warn(`[librarian] file-name index did not start: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
			stop: async () => {
				try {
					await callIfRunning(LIBRARIAN_OP.fileNameStop);
				} catch (error) {
					console.warn(`[librarian] file-name index did not stop: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		},
		scanDuplicates: (dir) => call(LIBRARIAN_OP.scanDuplicates, [dir]),
		indexStatus: {
			indexStatus: (paths) => call(LIBRARIAN_OP.indexStatus, [paths]),
			setIndexExcluded: (path, excluded) => call(LIBRARIAN_OP.setIndexExcluded, [path, excluded]),
		},
		async setLanguage(next) {
			language = next;
			if (running !== null && !disposed) await call(LIBRARIAN_OP.setLanguage, [next]);
		},
		async dispose() {
			disposed = true;
			const ending = running;
			running = null;
			if (ending === null) return;
			const bound = Promise.withResolvers<void>();
			const timer = setTimeout(bound.resolve, deps.shutdownMs ?? 1800);
			timer.unref();
			try {
				// The librarian ends its MinSync children on the process `exit` event, which a terminated thread never gets.
				await Promise.race([ending.ready.then(() => ending.client.call(LIBRARIAN_OP.shutdown)), bound.promise]);
			} catch (error) {
				console.warn(`[librarian] shutdown did not complete: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				clearTimeout(timer);
				await ending.thread.terminate();
			}
		},
	};
}
