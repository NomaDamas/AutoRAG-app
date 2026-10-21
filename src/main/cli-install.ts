import { access, lstat, mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Makes the `dazzi` command usable from a terminal once the app is installed.
 *
 * The launcher itself ships inside the app (`<resources>/bin/dazzi`, `dazzi.cmd` on Windows; see
 * `build/cli/`). This module only puts it where a shell finds it, per user and without elevation:
 *
 * - macOS: a symlink `dazzi` → the bundled launcher in the first of Homebrew's bin, `/usr/local/bin`, or
 *   `~/.local/bin` that takes it. A directory the user does not already have on `PATH` (`~/.local/bin`)
 *   is added through the login-shell profile, in one marked block.
 * - Windows: the bundled `bin` folder is appended to the user's `Path` (`HKCU\Environment`).
 * - Linux: nothing; the app is not shipped there.
 *
 * It runs on every start, so a moved or updated app repairs its own link. It never replaces a `dazzi` it
 * did not create.
 */

export interface LinkDir {
	readonly dir: string;
	/** May be created when missing: only user directories; a system directory that is absent is not ours to make. */
	readonly create: boolean;
	/** Whether login shells already have it on `PATH`. */
	readonly onPath: boolean;
}

export interface CliInstallDeps {
	readonly platform: NodeJS.Platform;
	readonly homeDir: string;
	/** `<resources>/bin`: where the packaged app keeps its launcher. */
	readonly bundledBinDir: string;
	/** Candidate link directories, most preferred first (macOS). */
	readonly linkDirs?: readonly LinkDir[];
	/** The user's login shell (`$SHELL`); picks the profile file. */
	readonly shell?: string | undefined;
	/** Whether a file exists; defaults to the real disk. A seam for Windows paths that cannot exist on the test host. */
	readonly exists?: (path: string) => Promise<boolean>;
	/** Runs one native command with an argv (never a shell) and returns its stdout. */
	readonly run: (command: string, args: readonly string[]) => Promise<string>;
}

export type CliInstallResult =
	| { readonly kind: "linked"; readonly link: string; readonly changed: boolean; readonly profile: string | null }
	| { readonly kind: "path-registered"; readonly dir: string; readonly changed: boolean }
	| { readonly kind: "unavailable"; readonly reason: string };

const COMMAND = "dazzi";
/** What a link of ours points at, wherever the app lives and whatever the bundle is called. */
const OURS = /\.app\/Contents\/Resources\/bin\/dazzi$/u;
const PROFILE_BEGIN = "# >>> dazzi CLI >>>";
const PROFILE_END = "# <<< dazzi CLI <<<";

export function defaultLinkDirs(homeDir: string): readonly LinkDir[] {
	return [
		{ dir: "/opt/homebrew/bin", create: false, onPath: true },
		{ dir: "/usr/local/bin", create: false, onPath: true },
		{ dir: join(homeDir, ".local", "bin"), create: true, onPath: false },
	];
}

async function onDisk(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

/** What stands at `link`: nothing, a link of ours (with its target), or something else. */
async function inspectLink(link: string): Promise<{ readonly state: "free" } | { readonly state: "ours"; readonly target: string } | { readonly state: "foreign" }> {
	let stats;
	try {
		stats = await lstat(link);
	} catch {
		return { state: "free" };
	}
	if (!stats.isSymbolicLink()) return { state: "foreign" };
	const target = await readlink(link);
	return OURS.test(target) ? { state: "ours", target } : { state: "foreign" };
}

/** The login-shell profile that puts a directory on PATH for a terminal. */
export function profileFor(shell: string | undefined, homeDir: string): string {
	const name = basename(shell ?? "");
	if (name === "zsh") return join(homeDir, ".zprofile");
	if (name === "bash") return join(homeDir, ".bash_profile");
	return join(homeDir, ".profile");
}

async function ensureOnPath(profile: string, dir: string): Promise<void> {
	const current = await readFile(profile, "utf8").catch(() => "");
	if (current.includes(PROFILE_BEGIN)) return;
	const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
	const block = `${PROFILE_BEGIN}\nexport PATH="${dir}:$PATH"\n${PROFILE_END}\n`;
	await mkdir(dirname(profile), { recursive: true });
	await writeFile(profile, `${current}${separator}${block}`, "utf8");
}

async function installMac(deps: CliInstallDeps): Promise<CliInstallResult> {
	const launcher = join(deps.bundledBinDir, COMMAND);
	if (!(await onDisk(launcher))) return { kind: "unavailable", reason: `no launcher at ${launcher}` };
	const candidates = deps.linkDirs ?? defaultLinkDirs(deps.homeDir);
	const states = await Promise.all(candidates.map(async (candidate) => ({ candidate, found: await inspectLink(join(candidate.dir, COMMAND)) })));
	// A link we made earlier wins wherever it is, so a refresh never leaves a second one behind.
	const own = states.find((entry) => entry.found.state === "ours");
	const free = states.filter((entry) => entry.found.state === "free");
	for (const { candidate, found } of own === undefined ? free : [own]) {
		const link = join(candidate.dir, COMMAND);
		try {
			if (found.state === "ours" && found.target === launcher) return { kind: "linked", link, changed: false, profile: await profileAfter(deps, candidate) };
			if (!(await onDisk(candidate.dir))) {
				if (!candidate.create) continue;
				await mkdir(candidate.dir, { recursive: true });
			}
			// Replaced atomically: a terminal running `dazzi` meanwhile never finds the link missing.
			const staging = `${link}.${process.pid}.tmp`;
			await unlink(staging).catch(() => undefined);
			await symlink(launcher, staging);
			await rename(staging, link);
			return { kind: "linked", link, changed: true, profile: await profileAfter(deps, candidate) };
		} catch {
			// A read-only or root-owned directory: try the next one.
		}
	}
	return { kind: "unavailable", reason: "no directory on the command search path accepts the link" };
}

async function profileAfter(deps: CliInstallDeps, candidate: LinkDir): Promise<string | null> {
	if (candidate.onPath) return null;
	const profile = profileFor(deps.shell, deps.homeDir);
	await ensureOnPath(profile, candidate.dir);
	return profile;
}

const WIN_ENV_KEY = "HKCU\\Environment";

/** The user `Path` value `reg query` printed, or "" when the output holds none. */
export function parseWinUserPath(output: string): string {
	return /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/imu.exec(output)?.[1]?.trimEnd() ?? "";
}

const normalizeWinEntry = (entry: string): string => entry.trim().replace(/\\+$/u, "").toLowerCase();

/** `current` with `dir` appended, or null when it is already listed (case and a trailing backslash do not matter). */
export function addToWinPath(current: string, dir: string): string | null {
	const entries = current.split(";").filter((entry) => entry.trim().length > 0);
	if (entries.some((entry) => normalizeWinEntry(entry) === normalizeWinEntry(dir))) return null;
	return [...entries, dir].join(";");
}

/** Tells running Explorer windows to re-read the environment, so new terminals see the change without a sign-out. */
const BROADCAST_ENVIRONMENT_CHANGE = [
	"Add-Type -Namespace Dazzi -Name Native -MemberDefinition '[DllImport(\"user32.dll\", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);';",
	"$r = [UIntPtr]::Zero;",
	"[Dazzi.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r) | Out-Null",
].join(" ");

async function installWindows(deps: CliInstallDeps): Promise<CliInstallResult> {
	if (!(await (deps.exists ?? onDisk)(join(deps.bundledBinDir, `${COMMAND}.cmd`)))) return { kind: "unavailable", reason: `no launcher in ${deps.bundledBinDir}` };
	// A missing value is normal for a profile that never set a user Path: `reg query` exits non-zero then.
	const current = parseWinUserPath(await deps.run("reg.exe", ["query", WIN_ENV_KEY, "/v", "Path"]).catch(() => ""));
	const next = addToWinPath(current, deps.bundledBinDir);
	if (next === null) return { kind: "path-registered", dir: deps.bundledBinDir, changed: false };
	// REG_EXPAND_SZ: a `%USERPROFILE%` entry the user already had must stay a variable, not become a literal.
	await deps.run("reg.exe", ["add", WIN_ENV_KEY, "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", next, "/f"]);
	await deps.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", BROADCAST_ENVIRONMENT_CHANGE]).catch((error: unknown) => {
		console.warn("[cli] could not announce the PATH change; new terminals see it after the next sign-in:", error);
	});
	return { kind: "path-registered", dir: deps.bundledBinDir, changed: true };
}

export async function installCli(deps: CliInstallDeps): Promise<CliInstallResult> {
	if (deps.platform === "darwin") return installMac(deps);
	if (deps.platform === "win32") return installWindows(deps);
	return { kind: "unavailable", reason: `the dazzi command is not shipped for ${deps.platform}` };
}
