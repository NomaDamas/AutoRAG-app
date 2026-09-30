/**
 * `make run` entry point: launch the Finder dev app on free ports with
 * debugging enabled.
 *
 * - `bun run dev` runs its `predev` hooks first, so `.upstream/autorag` is
 *   fast-forwarded to origin/main and rebuilt when it moved: the window always
 *   shows the latest version rather than a stale build.
 * - The renderer dev server, the main-process V8 inspector, and the renderer
 *   remote-debugging endpoint each get their own free port, so a run never
 *   collides with a port something else already holds.
 */

import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findFreePorts } from "./free-port.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [rendererPort, inspectorPort, debuggerPort] = await findFreePorts(3);

if (rendererPort === undefined || inspectorPort === undefined || debuggerPort === undefined) {
	throw new Error("[run] free-port discovery returned fewer than three ports");
}

console.log(`[run] renderer        http://localhost:${rendererPort}/`);
console.log(`[run] main inspector  chrome://inspect  ->  127.0.0.1:${inspectorPort}`);
console.log(`[run] renderer debug  http://127.0.0.1:${debuggerPort}/json/list`);

const child = spawn(
	"bun",
	["run", "dev", `--inspect=${inspectorPort}`, `--remoteDebuggingPort=${debuggerPort}`, "--watch"],
	{ cwd: root, stdio: "inherit", env: { ...process.env, PORT: String(rendererPort) } },
);

child.on("exit", (code) => {
	process.exit(typeof code === "number" ? code : 1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => child.kill(signal));
}
