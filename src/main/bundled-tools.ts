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
	const rest = (current ?? "").split(separator).filter((entry) => {
		if (entry.length === 0) return false;
		return platform === "win32" ? entry.toLowerCase() !== directory.toLowerCase() : entry !== directory;
	});
	return [directory, ...rest].join(separator);
}

/** Standard POSIX user/system tool directories launchd's minimal Finder PATH omits (`~/.cargo/bin`, `/opt/homebrew/bin`, ...). */
function appendStandardToolDirs(current: string | undefined, home: string | undefined, platform: NodeJS.Platform): string | undefined {
	if (platform === "win32") return current;
	const separator = posix.delimiter;
	const existing = (current ?? "").split(separator).filter((entry) => entry.length > 0);
	const homeDirs = typeof home === "string" && home.length > 0 ? [posix.join(home, ".cargo", "bin"), posix.join(home, ".local", "bin")] : [];
	const candidates = [...homeDirs, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
	for (const candidate of candidates) {
		if (!existing.includes(candidate)) existing.push(candidate);
	}
	return existing.join(separator);
}

/**
 * Put the bundled tools first on `env.PATH`, in place, and append standard user
 * tool directories after the existing entries when `augmentUserPaths` is set
 * so a Finder-launched build still resolves user-installed CLIs (`~/.cargo/bin/lazykatok`, Homebrew, ...).
 * Returns the tools root when bundled tools were applied.
 */
export function applyBundledTools(input: {
	readonly resourcesPath: string;
	readonly env: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
	readonly augmentUserPaths?: boolean;
}): string | null {
	const platform = input.platform ?? process.platform;
	const key = pathKey(input.env, platform);
	if (input.augmentUserPaths) {
		const augmented = appendStandardToolDirs(input.env[key], input.env.HOME, platform);
		if (augmented !== undefined) input.env[key] = augmented;
	}
	const root = bundledToolsRoot(input);
	if (root === null) return null;
	input.env[key] = prependPath(input.env[key], join(root, "bin"), platform);
	return root;
}
