// Stands in for parse-worker.mjs: the document's text picks the behavior.
import { parentPort } from "node:worker_threads";

parentPort.on("message", ({ id, bytes }) => {
	const mode = new TextDecoder().decode(bytes);
	if (mode === "spin") for (;;) {}
	if (mode === "oom") {
		const hoard = [];
		for (;;) hoard.push(new Array(1_000_000).fill("x"));
	}
	if (mode === "throw") {
		parentPort.postMessage({ id, thrown: "kaboom" });
		return;
	}
	parentPort.postMessage({ id, result: { success: true, markdown: `parsed ${mode}` } });
});
parentPort.postMessage({ ready: true });
