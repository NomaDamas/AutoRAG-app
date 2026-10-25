/**
 * Entry of Dazzi's own MCP server, the one other agents (Claude Code, Codex, Gemini CLI, Cursor, ...) start over
 * stdio (see `mcp-connect-info.ts`). They launch it on a plain Node, not on the app, so this file and everything it
 * imports must stay free of `electron`.
 *
 * It puts the bundled tools on `PATH` as the app does (the install names them through `AUTORAG_TOOLS_DIR`; a plain
 * Node has no resources path) and then runs the librarian's MCP server. Standard output belongs to the protocol:
 * nothing here may print to it.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { applyBundledTools } from "./bundled-tools";

applyBundledTools({ resourcesPath: "", env: process.env, augmentUserPaths: true });

/**
 * The package's exports map only lists ".", "./core" and "./profiles", so no static specifier reaches the server:
 * it is found by path next to the package entry and imported by file URL. That is also why the module has no
 * types here, and the `main` it exports is typed by hand below.
 */
const entry = join(dirname(createRequire(import.meta.url).resolve("@autorag/librarian")), "mcp", "index.js");

try {
	const { main } = (await import(pathToFileURL(entry).href)) as { readonly main: () => Promise<void> };
	await main();
} catch (error) {
	process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exitCode = 1;
}
