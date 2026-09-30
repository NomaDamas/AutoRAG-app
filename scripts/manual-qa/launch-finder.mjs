import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { _electron } from "playwright";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Launch the built Finder app for QA. Requires `bun run build` from the repo
 * root first; userDataDir and env pass through to the Electron process.
 */
export async function launchFinder({ userDataDir, env } = {}) {
	if (!existsSync(join(ROOT, "out/main/index.js"))) {
		throw new Error("out/main/index.js is missing — run `bun run build` first");
	}
	const args = userDataDir === undefined ? ["."] : [".", `--user-data-dir=${userDataDir}`];
	return _electron.launch({
		args,
		cwd: ROOT,
		env: env === undefined ? undefined : { ...process.env, ...env },
	});
}
