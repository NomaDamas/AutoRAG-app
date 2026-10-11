import { existsSync } from "node:fs";
import { join, posix, win32 } from "node:path";

/**
 * The installer carries the dependency programs the app drives (minsync, jikji,
 * discrawl, rclone, mailcrawl, ...) under `<resources>/tools/bin`. The librarian
 * and the datasource skills find every one of them by name on `PATH`, so making
 * the bundled directory the first `PATH` entry is the whole integration: no
 * per-tool configuration, and a tool the user already has never shadows the
 * tested version that shipped with the app.
 */

/** `<resources>/tools`, or null when this run has no bundled tools (development). */
function bundledToolsRoot(input: { readonly resourcesPath: string; readonly env: NodeJS.ProcessEnv }): string | null {
	const override = input.env.AUTORAG_TOOLS_DIR?.trim() ?? "";
	const root = override.length > 0 ? override : join(input.resourcesPath, "tools");
	return existsSync(join(root, "bin")) ? root : null;
}

/** The name PATH has in `env`: Windows environments are case-insensitive and the OS spells it `Path`. */
export function pathKey(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
	if (platform !== "win32") return "PATH";
	return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "Path";
}

/** `current` with `directory` first; an existing occurrence is moved up, never duplicated. */
export function prependPath(current: string | undefined, directory: string, platform: NodeJS.Platform = process.platform): string {
	const separator = platform === "win32" ? win32.delimiter : posix.delimiter;
	const same = (entry: string): boolean => (platform === "win32" ? entry.toLowerCase() === directory.toLowerCase() : entry === directory);
	const rest = (current ?? "").split(separator).filter((entry) => entry.length > 0 && !same(entry));
	return [directory, ...rest].join(separator);
}

/**
 * Put the bundled tools first on `env.PATH`, in place. Returns the tools root
 * when something was applied. Both entry points call it before anything reads
 * `process.env`: the app at startup, and the OS-scheduled refresh job (which
 * runs the same executable, so `process.resourcesPath` is the same and the OS
 * job definition never has to carry the directory). Every child process
 * either of them starts inherits it.
 */
export function applyBundledTools(input: {
	readonly resourcesPath: string;
	readonly env: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
}): string | null {
	const platform = input.platform ?? process.platform;
	const root = bundledToolsRoot(input);
	if (root === null) return null;
	const key = pathKey(input.env, platform);
	input.env[key] = prependPath(input.env[key], join(root, "bin"), platform);
	return root;
}
