import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { KordocParseFn } from "@autorag/librarian";

/**
 * Runs kordoc's `parse` on a worker thread that the host can kill.
 *
 * `withFileTimeout` (file-timeout.ts) races the parse against a timer on the same
 * thread, which cannot interrupt a parser that is spinning: measured, a 3000 ms
 * busy loop returned after 3001 ms under a 200 ms timeout. A worker is
 * terminated mid-loop, and `resourceLimits` turns a runaway heap into a
 * rejection instead of an out-of-memory abort of the whole app.
 *
 * What it does not contain: a native crash (segfault) inside the worker still
 * takes the process down, because a worker is a thread. kordoc's OCR engines are
 * the native parts, and the app keeps OCR off.
 */

export const PARSE_HEAP_LIMIT_MB = 2048;
/** Importing kordoc (pdf.js and friends) takes ~100 ms warm; this only bounds a worker that never comes up. */
export const PARSE_STARTUP_TIMEOUT_MS = 30_000;
/** A worker idle this long is terminated, so a finished refresh does not keep kordoc's heap resident. */
export const PARSE_IDLE_MS = 30_000;
/** pdf.js and wasm engines grow over many documents; a fresh worker every so often bounds it. */
export const PARSE_RECYCLE_AFTER = 500;

/** What kordoc answers for one document: markdown on success, its own error code on failure. */
export type ParseOutcome =
	| { readonly success: true; readonly fileType?: string; readonly markdown: string; readonly warnings?: readonly { readonly code?: string; readonly message: string }[] }
	| { readonly success: false; readonly fileType?: string; readonly error: string; readonly code?: string };

export interface ParsePoolOptions {
	readonly workerUrl: URL;
	readonly timeoutMs: number;
	readonly maxHeapMb?: number;
	readonly startupTimeoutMs?: number;
	readonly idleMs?: number;
	readonly recycleAfter?: number;
	/** Handles what cannot cross a thread boundary (an OCR provider function). */
	readonly inProcess: KordocParseFn;
}

/** How many parses ended without an answer; read and reset by the caller after a refresh. */
export interface ParseFailureCounts {
	timedOut: number;
	crashed: number;
}

export interface ParsePool {
	readonly parse: KordocParseFn;
	/** Counts since the last call, then reset. */
	takeFailures(): ParseFailureCounts;
	dispose(): Promise<void>;
}

interface Pending {
	readonly id: number;
	readonly worker: Worker;
	readonly resolve: (outcome: ParseOutcome) => void;
	readonly reject: (error: Error) => void;
}

interface WorkerReply {
	readonly ready?: true;
	readonly id?: number;
	readonly result?: ParseOutcome;
	readonly thrown?: string;
}

export function createParsePool(options: ParsePoolOptions): ParsePool {
	const startupTimeoutMs = options.startupTimeoutMs ?? PARSE_STARTUP_TIMEOUT_MS;
	const idleMs = options.idleMs ?? PARSE_IDLE_MS;
	const recycleAfter = options.recycleAfter ?? PARSE_RECYCLE_AFTER;
	let worker: Worker | null = null;
	let ready: Promise<void> = Promise.resolve();
	let pending: Pending | null = null;
	let nextId = 0;
	let parsed = 0;
	let idleTimer: NodeJS.Timeout | undefined;
	let queue: Promise<unknown> = Promise.resolve();
	let failures: ParseFailureCounts = { timedOut: 0, crashed: 0 };

	/** The worker is gone or must go; whoever waits on it hears why. */
	function drop(target: Worker, reason: Error | null): void {
		if (worker === target) worker = null;
		void target.terminate().catch(() => undefined);
		if (reason !== null && pending?.worker === target) {
			const waiting = pending;
			pending = null;
			failures.crashed += 1;
			waiting.reject(reason);
		}
	}

	function spawn(): Worker {
		const created = new Worker(options.workerUrl, { resourceLimits: { maxOldGenerationSizeMb: options.maxHeapMb ?? PARSE_HEAP_LIMIT_MB } });
		created.unref();
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		promise.catch(() => undefined);
		ready = promise;
		created.on("message", (reply: WorkerReply) => {
			if (reply.ready === true) {
				resolve();
				return;
			}
			if (pending === null || pending.worker !== created || pending.id !== reply.id) return;
			const waiting = pending;
			pending = null;
			if (reply.thrown !== undefined) waiting.reject(new Error(reply.thrown));
			else if (reply.result !== undefined) waiting.resolve(reply.result);
		});
		created.on("error", (error: unknown) => {
			const reason = error instanceof Error ? error : new Error(String(error));
			reject(reason);
			drop(created, reason);
		});
		created.on("exit", (code) => {
			const reason = new Error(`parse worker exited with code ${code}`);
			reject(reason);
			drop(created, reason);
		});
		return created;
	}

	async function run(bytes: Uint8Array, ocr: boolean | "force" | undefined, timeoutMs: number): Promise<ParseOutcome> {
		clearTimeout(idleTimer);
		if (worker !== null && parsed >= recycleAfter) drop(worker, null);
		if (worker === null) {
			parsed = 0;
			worker = spawn();
		}
		const active = worker;
		const startup = Promise.withResolvers<never>();
		const startupTimer = setTimeout(() => startup.reject(new Error(`parse worker did not start within ${startupTimeoutMs}ms`)), startupTimeoutMs);
		try {
			await Promise.race([ready, startup.promise]);
		} catch (error) {
			drop(active, null);
			throw error;
		} finally {
			clearTimeout(startupTimer);
		}
		const id = nextId;
		nextId += 1;
		const { promise, resolve, reject } = Promise.withResolvers<ParseOutcome>();
		pending = { id, worker: active, resolve, reject };
		const timer = setTimeout(() => {
			failures.timedOut += 1;
			pending = null;
			drop(active, null);
			reject(new Error(`parsing timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		// A copy, so detaching it cannot disturb a pooled Buffer slab the caller still holds.
		const copy = Uint8Array.from(bytes);
		active.postMessage({ id, bytes: copy, ocr }, [copy.buffer]);
		parsed += 1;
		try {
			return await promise;
		} finally {
			clearTimeout(timer);
			idleTimer = setTimeout(() => {
				if (worker !== null && pending === null) drop(worker, null);
			}, idleMs);
			idleTimer.unref();
		}
	}

	const parse: KordocParseFn = (bytes, parseOptions) => {
		const ocr = parseOptions.ocr;
		// A provider function cannot be cloned into a thread; only the app-pinned boolean path is isolated.
		if (typeof ocr === "function") return options.inProcess(bytes, parseOptions);
		const answer = queue.then(() => run(bytes, ocr, options.timeoutMs));
		queue = answer.catch(() => undefined);
		return answer;
	};

	return {
		parse,
		takeFailures: () => {
			const taken = failures;
			failures = { timedOut: 0, crashed: 0 };
			return taken;
		},
		dispose: async () => {
			clearTimeout(idleTimer);
			if (worker !== null) drop(worker, new Error("parse pool disposed"));
		},
	};
}

const WORKER_FILE = "parse-worker.mjs";

/**
 * Where the worker file is. In a build this module lives in a shared chunk
 * (`out/main/chunks/`) while the worker is an entry (`out/main/`); under tests
 * and in dev it sits beside this file. The name is kept out of a literal
 * `new URL("./...", import.meta.url)` so the bundler does not rewrite it.
 */
export function findParseWorker(moduleUrl: string, exists: (path: string) => boolean = existsSync): URL | null {
	for (const base of ["./", "../"]) {
		const candidate = new URL(WORKER_FILE, new URL(base, moduleUrl));
		if (exists(fileURLToPath(candidate))) return candidate;
	}
	return null;
}

let shared: { readonly timeoutMs: number; readonly pool: ParsePool } | null = null;

/**
 * The parse every local file goes through. One worker per process, shared by the
 * callers that build an indexing config (refresh, status, search); a different
 * budget replaces it. Without a worker file the in-process parse stands in, and
 * says so once: a packaging mistake must not skip every document.
 */
export function sharedParsePool(timeoutMs: number, inProcess: KordocParseFn): ParsePool {
	if (shared !== null && shared.timeoutMs === timeoutMs) return shared.pool;
	void shared?.pool.dispose();
	const workerUrl = findParseWorker(import.meta.url);
	if (workerUrl === null) console.error("[parse-isolation] parse-worker.mjs not found; parsing in-process without a hard kill");
	const pool =
		workerUrl === null
			? { parse: inProcess, takeFailures: () => ({ timedOut: 0, crashed: 0 }), dispose: async () => undefined }
			: createParsePool({ workerUrl, timeoutMs, inProcess });
	shared = { timeoutMs, pool };
	return pool;
}

/** Timeouts and crashes of the shared pool since the last call; zero when no pool was used. */
export function takeSharedParseFailures(): ParseFailureCounts {
	return shared?.pool.takeFailures() ?? { timedOut: 0, crashed: 0 };
}
