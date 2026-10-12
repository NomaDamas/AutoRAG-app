/**
 * Worker entry for LZMA compression (the 7z writer's coder).
 *
 * The encoder is WebAssembly and synchronous: a few MB/s, so one block can
 * take seconds. It runs here, in a worker thread, so the Electron main thread
 * never blocks. One worker serves one archive; requests are answered in order.
 *
 * Plain JavaScript for the same reason as `archive-worker.mjs`: the source and
 * the build share one spawn URL.
 */

import { parentPort } from "node:worker_threads";
import { compress, initWasm } from "lzma-wasm";

await initWasm();

parentPort.on("message", ({ id, level, data }) => {
	try {
		// "lzma" is the LZMA-Alone layout: 5 property bytes, 8 size bytes, then the raw stream.
		parentPort.postMessage({ id, ok: true, data: compress(data, { format: "lzma", level }) });
	} catch (error) {
		parentPort.postMessage({ id, ok: false, message: error instanceof Error ? error.message : String(error) });
	}
});
