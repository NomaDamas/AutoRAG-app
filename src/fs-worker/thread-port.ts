import type { MessagePort, Worker } from "node:worker_threads";
import type { WorkerPort } from "../shared/fs-worker-protocol";

/** A `worker_threads` `MessagePort` (the thread's end of the channel) as the request/response protocol's {@link WorkerPort}. */
export function adaptNodePort(port: MessagePort): WorkerPort {
	return {
		postMessage: (message) => port.postMessage(message),
		onMessage: (listener) => {
			port.on("message", listener);
		},
		onClose: (listener) => {
			port.on("close", listener);
		},
		close: () => port.close(),
	};
}

/**
 * A `Worker` (the parent's end of a thread) as a {@link WorkerPort}. A `Worker` has no `close` event and no `close()`:
 * it is gone when it exits, and ending it is `terminate()`.
 */
export function adaptWorker(worker: Worker): WorkerPort {
	return {
		postMessage: (message) => worker.postMessage(message),
		onMessage: (listener) => {
			worker.on("message", listener);
		},
		onClose: (listener) => {
			worker.once("exit", () => listener());
		},
		close: () => {
			void worker.terminate();
		},
	};
}
