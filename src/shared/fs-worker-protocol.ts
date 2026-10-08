/**
 * The wire protocol between the filesystem worker (`src/fs-worker`, an Electron
 * utility process) and its clients: the renderer's preload and the main
 * process. Both ends speak it over a MessagePort, so a folder listing never
 * passes through the main process event loop.
 *
 *   request   { id, op, args }
 *   response  { id, ok: true, value } | { id, ok: false, error }
 *   cancel    { id, cancel: true }     → the worker aborts that op's AbortSignal
 *   push      { push, payload }        → worker-initiated events (live batches…)
 *
 * The worker can die (a native watcher abort, a SIGKILL) and is restarted by
 * the main process with fresh ports. A client survives that: requests it has
 * not had an answer for are re-sent on the new port when re-running them is
 * harmless, and rejected when it is not (a copy may or may not have happened),
 * so a reader sees a short delay and a writer sees an honest error.
 *
 * No Electron imports: the preload (DOM MessagePort), the main process, and
 * the worker (MessagePortMain) adapt their port to {@link WorkerPort}.
 */

/** The narrow port both DOM `MessagePort` and Electron `MessagePortMain` adapt to. */
export interface WorkerPort {
	postMessage(message: unknown): void;
	/** Every message payload (already unwrapped from its event), in arrival order. */
	onMessage(listener: (message: unknown) => void): void;
	/** The remote end went away; not every port type can tell. */
	onClose?(listener: () => void): void;
	close(): void;
}

export interface WorkerRequest {
	readonly id: number;
	readonly op: string;
	readonly args: readonly unknown[];
}

export interface WorkerCancel {
	readonly id: number;
	readonly cancel: true;
}

export interface SerializedError {
	readonly name: string;
	readonly message: string;
	/** Node's `error.code` (ENOENT…) or a typed app error code (`name-collision`). */
	readonly code?: string;
}

export type WorkerResponse =
	| { readonly id: number; readonly ok: true; readonly value: unknown }
	| { readonly id: number; readonly ok: false; readonly error: SerializedError };

export interface WorkerPush {
	readonly push: string;
	readonly payload: unknown;
}

/** Worker → client push names. */
export const FS_WORKER_PUSH = {
	/** A `LiveMessage` from the change hub. */
	live: "live",
	/** A volume mounted/unmounted or a cloud account connected/disconnected. */
	locationsChanged: "locationsChanged",
	/** The index refresh a toggle started has settled; payload is the error or null. */
	indexRefreshed: "indexRefreshed",
} as const;

/**
 * Ops whose effect must not run twice. When the worker restarts with one of
 * these in flight, the client rejects it instead of re-sending it: the first
 * attempt may already have changed the disk.
 */
export const REPLAY_UNSAFE_OPS: Readonly<Record<string, true>> = {
	copy: true,
	move: true,
	duplicate: true,
	rename: true,
	createFolder: true,
	// Re-sent, the items that already reached the Trash would come back as failures.
	trash: true,
	createFile: true,
	undo: true,
	ejectLocation: true,
	dispose: true,
};

/** The message a replay-unsafe request rejects with when the worker restarted under it. */
export const WORKER_RESTARTED_MESSAGE = "파일 서비스가 작업 도중 다시 시작되었습니다. 결과를 확인한 뒤 다시 시도하세요";

export function serializeError(error: unknown): SerializedError {
	if (error instanceof Error) {
		const code = "code" in error ? error.code : undefined;
		return { name: error.name, message: error.message, ...(typeof code === "string" ? { code } : {}) };
	}
	return { name: "Error", message: String(error) };
}

export function reviveError(error: SerializedError): Error {
	const revived = new Error(error.message);
	revived.name = error.name;
	if (error.code !== undefined) Object.assign(revived, { code: error.code });
	return revived;
}

function isRequest(message: unknown): message is WorkerRequest {
	return typeof message === "object" && message !== null && "op" in message && typeof message.op === "string" && "args" in message && Array.isArray(message.args);
}

function isCancel(message: unknown): message is WorkerCancel {
	return typeof message === "object" && message !== null && "cancel" in message && message.cancel === true;
}

function isResponse(message: unknown): message is WorkerResponse {
	return typeof message === "object" && message !== null && "ok" in message && typeof message.ok === "boolean";
}

function isPush(message: unknown): message is WorkerPush {
	return typeof message === "object" && message !== null && "push" in message && typeof message.push === "string";
}

/** One op: the request's arguments, aborted when the client cancels or leaves. */
export type WorkerHandler = (args: readonly unknown[], signal: AbortSignal) => unknown;

export interface WorkerConnection {
	push(name: string, payload: unknown): void;
	/** Abort every op still running for this client and stop answering it. */
	close(): void;
}

/**
 * Answer one client port with `handlers`. Each request runs with its own
 * AbortSignal; a `cancel` for its id aborts it, and the answer to a cancelled
 * request is dropped. A thrown error crosses as {@link SerializedError}.
 */
export function serveWorkerPort(
	port: WorkerPort,
	handlers: Readonly<Record<string, WorkerHandler>>,
	onRequest?: (op: string, args: readonly unknown[]) => void,
): WorkerConnection {
	const running = new Map<number, AbortController>();
	let open = true;
	const reply = (response: WorkerResponse): void => {
		if (open) port.postMessage(response);
	};
	port.onMessage((message) => {
		if (!open) return;
		if (isCancel(message)) {
			running.get(message.id)?.abort();
			running.delete(message.id);
			return;
		}
		if (!isRequest(message)) return;
		const { id, op, args } = message;
		const handler = Object.hasOwn(handlers, op) ? handlers[op] : undefined;
		if (handler === undefined) {
			reply({ id, ok: false, error: { name: "Error", message: `Unknown fs-worker op: ${op}` } });
			return;
		}
		onRequest?.(op, args);
		const controller = new AbortController();
		running.set(id, controller);
		Promise.resolve()
			.then(() => handler(args, controller.signal))
			.then(
				(value) => {
					if (!controller.signal.aborted) reply({ id, ok: true, value });
				},
				(error: unknown) => {
					if (!controller.signal.aborted) reply({ id, ok: false, error: serializeError(error) });
				},
			)
			.finally(() => {
				if (running.get(id) === controller) running.delete(id);
			});
	});
	return {
		push(name, payload) {
			if (open) port.postMessage({ push: name, payload } satisfies WorkerPush);
		},
		close() {
			open = false;
			for (const controller of running.values()) controller.abort();
			running.clear();
		},
	};
}

export interface WorkerCallOptions {
	/** Aborting rejects the call at once and tells the worker to stop the op. */
	readonly signal?: AbortSignal;
}

export interface WorkerClient {
	call<T>(op: string, args?: readonly unknown[], options?: WorkerCallOptions): Promise<T>;
	/**
	 * Adopt a (new) port. Unanswered requests are re-sent on it, except
	 * replay-unsafe ones, which reject with {@link WORKER_RESTARTED_MESSAGE}.
	 * Calls made before the first port queue until it arrives.
	 */
	attach(port: WorkerPort): void;
	onPush(name: string, listener: (payload: unknown) => void): () => void;
	/** Fires on every attach after the first: the worker restarted and kept no state for this client. */
	onRestart(listener: () => void): () => void;
}

interface PendingCall {
	readonly request: WorkerRequest;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	/** The port the request was posted on; null while it waits for one. */
	sentOn: WorkerPort | null;
}

function abortError(): Error {
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	return error;
}

export function createWorkerClient(): WorkerClient {
	const pending = new Map<number, PendingCall>();
	const pushListeners = new Map<string, Set<(payload: unknown) => void>>();
	const restartListeners = new Set<() => void>();
	let port: WorkerPort | null = null;
	let attached = 0;
	let nextId = 0;

	const send = (call: PendingCall): void => {
		if (port === null) return;
		call.sentOn = port;
		port.postMessage(call.request);
	};

	const receive = (from: WorkerPort, message: unknown): void => {
		// A late answer from a port that was replaced belongs to a dead worker.
		if (from !== port) return;
		if (isPush(message)) {
			for (const listener of pushListeners.get(message.push) ?? []) listener(message.payload);
			return;
		}
		if (!isResponse(message)) return;
		const call = pending.get(message.id);
		if (call === undefined || call.sentOn !== from) return;
		pending.delete(message.id);
		if (message.ok) call.resolve(message.value);
		else call.reject(reviveError(message.error));
	};

	return {
		call<T>(op: string, args: readonly unknown[] = [], options: WorkerCallOptions = {}): Promise<T> {
			const { signal } = options;
			if (signal?.aborted === true) return Promise.reject(abortError());
			nextId += 1;
			const id = nextId;
			const { promise, resolve, reject } = Promise.withResolvers<unknown>();
			const call: PendingCall = { request: { id, op, args }, resolve, reject, sentOn: null };
			pending.set(id, call);
			signal?.addEventListener(
				"abort",
				() => {
					if (pending.get(id) !== call) return;
					pending.delete(id);
					call.sentOn?.postMessage({ id, cancel: true } satisfies WorkerCancel);
					reject(abortError());
				},
				{ once: true },
			);
			send(call);
			return promise as Promise<T>;
		},
		attach(next) {
			port = next;
			attached += 1;
			next.onMessage((message) => receive(next, message));
			for (const [id, call] of [...pending]) {
				if (call.sentOn !== null && REPLAY_UNSAFE_OPS[call.request.op] === true) {
					pending.delete(id);
					call.reject(new Error(WORKER_RESTARTED_MESSAGE));
					continue;
				}
				send(call);
			}
			if (attached > 1) for (const listener of restartListeners) listener();
		},
		onPush(name, listener) {
			let set = pushListeners.get(name);
			if (set === undefined) {
				set = new Set();
				pushListeners.set(name, set);
			}
			set.add(listener);
			return () => {
				pushListeners.get(name)?.delete(listener);
			};
		},
		onRestart(listener) {
			restartListeners.add(listener);
			return () => {
				restartListeners.delete(listener);
			};
		},
	};
}
