import type { IpcRenderer, IpcRendererEvent } from "electron";
import { FS_WORKER_CHANNELS } from "../shared/fs-worker-contract";
import { createWorkerClient, type WorkerClient } from "../shared/fs-worker-protocol";

/**
 * The page's link to the filesystem worker. The preload asks main for a port
 * once; main sends a new one whenever the worker restarts, and the client
 * re-sends what was in flight on it. The port is consumed here and never
 * reaches the page's world.
 */
export function connectFsWorker(ipcRenderer: IpcRenderer): WorkerClient {
	const client = createWorkerClient();
	ipcRenderer.on(FS_WORKER_CHANNELS.port, (event: IpcRendererEvent) => {
		const [port] = event.ports;
		if (port === undefined) return;
		client.attach({
			postMessage: (message) => port.postMessage(message),
			onMessage: (listener) => {
				port.onmessage = (message) => listener(message.data);
				port.start();
			},
			close: () => port.close(),
		});
	});
	ipcRenderer.send(FS_WORKER_CHANNELS.connect);
	return client;
}
