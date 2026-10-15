/**
 * Worker entry that runs kordoc's `parse` off the main thread.
 *
 * A file that sends the parser into a CPU-bound loop, or into a heap the size of
 * the machine, cannot be interrupted from the thread it runs on: a timer never
 * fires while the loop spins, and an out-of-memory abort takes the whole process
 * down. Here the host can `terminate()` the thread at any point and cap its heap
 * (`resourceLimits`), so the damage stays one skipped file.
 *
 * It is plain JavaScript on purpose, like `archive-worker.mjs`: it is a separate
 * build entry loaded by URL, so it cannot import app TypeScript. The call below
 * matches the librarian's own default parse (`plain: true`, the indexing/RAG
 * profile); keep the two in step.
 *
 * Protocol (main -> worker): `{ id, bytes, ocr }`.
 * Reply (worker -> main): `{ id, result }` with the kordoc outcome, or
 * `{ id, thrown }` when kordoc threw. Only `markdown`, `warnings`, and the
 * failure fields cross the thread boundary, never the document tree.
 */

import { parentPort } from "node:worker_threads";
import { parse } from "kordoc";

parentPort.on("message", async ({ id, bytes, ocr }) => {
	try {
		const result = await parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { plain: true, ...(ocr === undefined ? {} : { ocr }) });
		parentPort.postMessage({
			id,
			result: result.success
				? { success: true, fileType: result.fileType, markdown: result.markdown, warnings: result.warnings }
				: { success: false, fileType: result.fileType, error: result.error, code: result.code },
		});
	} catch (error) {
		parentPort.postMessage({ id, thrown: error instanceof Error ? error.message : String(error) });
	}
});

parentPort.postMessage({ ready: true });
