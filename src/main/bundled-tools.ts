import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, posix, win32 } from "node:path";

/**
 * The installer carries the dependency programs the app drives (minsync, jikji,
 * discrawl, rclone, mailcrawl, ...) under `<resources>/tools/bin`. The librarian
 * and the datasource skills find every one of them by name on `PATH`, so making
 * the bundled directory the first `PATH` entry is the whole integration: no
 * per-tool configuration, and a tool the user already has never shadows the
 * tested version that shipped with the app.
 *
 * Kiwi is the exception: MinSync's `multilingual` BM25 tokenizer loads the native library and model by
 * path, not by name, so the bundle's `kiwi/` directory is announced through `KIWI_LIBRARY_PATH` and
 * `KIWI_MODEL_PATH` (see {@link applyBundledKiwi}).
 */

/**
 * `<resources>/tools`, or null when this run has no bundled tools (development). A run without a resources path
 * (plain Node, as an agent starts the MCP server) has no `<resources>/tools` either: an empty path must not turn
 * into `tools/` under whatever directory the process happens to be in.
 */
function bundledToolsRoot(input: { readonly resourcesPath: string; readonly env: NodeJS.ProcessEnv }): string | null {
	const override = input.env.AUTORAG_TOOLS_DIR?.trim() ?? "";
	const root = override.length > 0 ? override : input.resourcesPath.length > 0 ? join(input.resourcesPath, "tools") : "";
	return root.length > 0 && existsSync(join(root, "bin")) ? root : null;
}

const ASCII_ONLY = /^[\x20-\x7e]*$/;

/**
 * Windows loads `kiwi.dll` through the ANSI API (GetLastError=126 for a path with characters outside the ANSI
 * code page, e.g. a Korean user name), so a bundle under a non-ASCII profile cannot be loaded in place. The
 * library and model are copied once into `<ProgramData|Public>\Dazzi\kiwi-<fingerprint>` and reused until the
 * bundled library changes. Returns the ASCII `kiwi` directory, or null when no ASCII location is writable.
 */
function mirrorKiwiToAscii(source: string, env: NodeJS.ProcessEnv): string | null {
	const library = join(source, "lib", "kiwi.dll");
	const { size, mtimeMs } = statSync(library);
	const name = `kiwi-${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}`;
	for (const base of [env.PROGRAMDATA, env.PUBLIC]) {
		if (base === undefined || base.trim() === "") continue;
		const parent = join(base, "Dazzi");
		const target = join(parent, name);
		if (!ASCII_ONLY.test(target)) continue;
		try {
			if (!existsSync(join(target, "lib", "kiwi.dll")) || !existsSync(join(target, "models", "cong", "base"))) {
				mkdirSync(parent, { recursive: true });
				const staging = join(parent, `${name}.tmp-${process.pid}`);
				rmSync(staging, { recursive: true, force: true });
				cpSync(source, staging, { recursive: true });
				rmSync(target, { recursive: true, force: true });
				renameSync(staging, target);
			}
			for (const stale of readdirSync(parent)) {
				if (stale.startsWith("kiwi-") && stale !== name) rmSync(join(parent, stale), { recursive: true, force: true });
			}
			return target;
		} catch {
			// Not writable or a concurrent start won the rename: try the next location.
		}
	}
	return null;
}

/**
 * Point `KIWI_LIBRARY_PATH` / `KIWI_MODEL_PATH` at the bundled Kiwi (`<tools>/kiwi`), in place. A variable the
 * user already set is left alone, and so are both when only one of them is bundled: kiwi-rs treats an
 * explicit path as authoritative, so overwriting would second-guess a deliberate choice, and a library
 * paired with another install's model is not a configuration anyone tested.
 * On Windows a non-ASCII bundle path is mirrored to an ASCII directory first ({@link mirrorKiwiToAscii}); with
 * none available nothing is set, so the librarian's probe falls back to whitespace tokenization.
 * Returns whether the bundled Kiwi was applied.
 */
export function applyBundledKiwi(root: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): boolean {
	let kiwi = join(root, "kiwi");
	const libraryFile = platform === "win32" ? "kiwi.dll" : platform === "darwin" ? "libkiwi.dylib" : "libkiwi.so";
	const library = join(kiwi, "lib", libraryFile);
	const model = join(kiwi, "models", "cong", "base");
	if (!existsSync(library) || !existsSync(model)) return false;
	if ((env.KIWI_LIBRARY_PATH?.trim() ?? "") !== "" || (env.KIWI_MODEL_PATH?.trim() ?? "") !== "") return false;
	if (platform === "win32" && !ASCII_ONLY.test(kiwi)) {
		const mirrored = mirrorKiwiToAscii(kiwi, env);
		if (mirrored === null) return false;
		kiwi = mirrored;
	}
	env.KIWI_LIBRARY_PATH = join(kiwi, "lib", libraryFile);
	env.KIWI_MODEL_PATH = join(kiwi, "models", "cong", "base");
	return true;
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
	applyBundledKiwi(root, input.env, platform);
	return root;
}
