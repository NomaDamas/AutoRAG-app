/**
 * Cross-platform helpers for the manual-QA scripts.
 *
 * The QA lanes were written on macOS, where `new URL(...).pathname` yields a
 * POSIX path, `$HOME` exists, `⌘` is the shortcut modifier, and `mdls`/`pgrep`/
 * `osascript` are the shell tools. On Windows each of those is wrong, and a run
 * dies at the first `EPERM: mkdir 'C:'` or reports a false failure. This module
 * encapsulates the differences so a script reads the same on both platforms:
 *
 *   - repo paths: `repoRoot(import.meta.url)` (fileURLToPath, not pathname)
 *   - home: `homeDir()` / `homeEnv()` (adds USERPROFILE for Windows launch)
 *   - keys: `chord("Shift", "H")` → `Meta+Shift+H` on macOS, `Control+Shift+H`
 *     on Windows (the app binds `meta || ctrl`)
 *   - basenames: `baseName()` handles both separators
 *   - shell: `sh()`, `qlmanageCount()`, `reapQlmanageOrphans()` degrade to a
 *     no-op where the macOS tool does not exist
 */

import { execFileSync, execSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";

/** Playwright keyboard modifier: Command on macOS, Control elsewhere. */
export const MOD = isMac ? "Meta" : "Control";

/** Playwright chord: `chord("Shift", "H")` → `Meta+Shift+H` on macOS, `Control+Shift+H` on Windows. */
export function chord(...keys) {
	return [MOD, ...keys].join("+");
}

/** The repository root, resolved from a script URL (never `new URL(...).pathname`). */
export function repoRoot(metaUrl) {
	return fileURLToPath(new URL("../..", metaUrl)).replace(/[\\/]$/, "");
}

/** The OS home directory (`os.homedir()` already honors USERPROFILE on Windows). */
export function homeDir() {
	return homedir();
}

/** Env overrides so `launchFinder` sees a throwaway home on either platform. */
export function homeEnv(home) {
	return { HOME: home, USERPROFILE: home };
}

/**
 * Escape a path for a CSS attribute value. Playwright's CSS engine eats a lone
 * backslash (`[data-path="C:\Users"]` matches nothing), so Windows separators
 * need `\\`. POSIX paths pass through unchanged.
 */
export function cssAttr(value) {
	return value.replace(/\\/g, "\\\\");
}

/** Cross-platform file/folder name: handles `/` and `\`. */
export function baseName(path) {
	return path.split(/[\\/]/).pop() ?? path;
}

/** Copy a file without shelling out (`cp` is not available in cmd.exe). */
export function copyFile(from, to) {
	copyFileSync(from, to);
}

export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The Finder list virtualizes rows, so a target sorting below the fold is not
 * in the DOM. Scrolls `.list` one page down, wrapping back to the top at the
 * end, so a caller can sweep a long listing until its locator mounts.
 */
export async function scrollFinderList(page) {
	await page
		.locator(".list")
		.first()
		.evaluate((element) => {
			if (element.scrollTop + element.clientHeight >= element.scrollHeight) element.scrollTop = 0;
			else element.scrollTop += Math.max(200, element.clientHeight - 80);
		})
		.catch(() => undefined);
}

/**
 * `rmSync` with a short retry on Windows: right after the app closes, Electron
 * can still hold userData or a fixture briefly, so a single `rm` fails with
 * EBUSY/EPERM. Retries only on Windows; elsewhere one attempt, one throw.
 */
export function rmRetry(path) {
	const attempts = isWindows ? 40 : 1;
	for (let attempt = 1; ; attempt += 1) {
		try {
			rmSync(path, { recursive: true, force: true });
			return;
		} catch (error) {
			if (!isWindows || attempt >= attempts) throw error;
			// Synchronous pause; Atomics.wait is allowed on Node/Bun's main thread.
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
		}
	}
}

/** Run a shell command, returning "" when it fails or the tool is absent. */
export function sh(cmd) {
	try {
		return execSync(cmd, { encoding: "utf8" });
	} catch {
		return "";
	}
}

/**
 * Live exact-name `qlmanage` process count. Only macOS forks that CLI for Quick
 * Look; Windows uses a different native path, so the count is always 0 there and
 * the "no qlmanage spawned" gates stay meaningful, not skipped.
 */
export function qlmanageCount() {
	if (!isMac) return 0;
	const out = sh("pgrep -x qlmanage | wc -l").trim();
	return Number.isNaN(Number(out)) ? 0 : Number(out);
}

/** SIGKILL `qlmanage` orphans (ppid=1) leaked by earlier runs; returns the reaped count. */
export function reapQlmanageOrphans() {
	if (!isMac) return 0;
	const pids = sh("ps -axo pid=,ppid=,comm= | awk '$2==1 && $3 ~ /qlmanage/ {print $1}'")
		.split(/\s+/)
		.filter((pid) => pid.length > 0);
	let reaped = 0;
	for (const pid of pids) {
		try {
			process.kill(Number(pid), "SIGKILL");
			reaped += 1;
		} catch {
			// Already gone.
		}
	}
	return reaped;
}

/**
 * Put the `dupey` CLI on a throwaway `bin` directory (a symlink; a copy on Windows, where a
 * symlink needs a privilege the runner lacks) and return a PATH that holds only that directory
 * plus the OS's own tool directories, so no host datasource CLI is reachable from the app.
 */
export function isolatedToolPath(binDir) {
	const finder = isWindows ? "where dupey" : "command -v dupey";
	const found = execSync(finder, { encoding: "utf8", shell: isWindows ? undefined : "/bin/sh" }).split(/\r?\n/u)[0].trim();
	const target = join(binDir, isWindows ? basename(found) : "dupey");
	if (isWindows) copyFileSync(found, target);
	else symlinkSync(found, target);
	const system = isWindows ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32"), process.env.SystemRoot ?? "C:\\Windows"] : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
	return [binDir, ...system].join(delimiter);
}

/**
 * Resolve the host's real `minsync` binary when installed, or null.
 */
function findRealMinsync() {
	try {
		const finder = isWindows ? "where minsync" : "command -v minsync";
		const found = execSync(finder, { encoding: "utf8", shell: isWindows ? undefined : "/bin/sh" }).split(/\r?\n/u)[0]?.trim() ?? "";
		if (found.length > 0 && existsSync(found)) return found;
	} catch {
		// Fall back to standard install locations when PATH was stripped.
	}
	const home = homedir();
	const candidates = isWindows
		? [join(home, ".cargo", "bin", "minsync.exe")]
		: [join(home, ".cargo", "bin", "minsync"), join(home, "bin", "minsync"), "/opt/homebrew/bin/minsync", "/usr/local/bin/minsync"];
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * A `minsync` stand-in in `binDir` for lanes that keep vector embedding out of the way while still
 * supporting librarian 2.13.2's `minsync stage` protocol v2 (required by `parsed`-only refreshes and
 * `loadMirrorIndex`): forwards `stage` and `--version` to the host's `minsync` when present, and exits 0
 * for `sync`/`query`/`serve`/`check`/`init`.
 */
export function writeMinsyncStub(binDir) {
	mkdirSync(binDir, { recursive: true });
	const realMinsync = findRealMinsync();
	if (!isWindows) {
		const stub = join(binDir, "minsync");
		const body =
			realMinsync === null
				? '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "minsync 0.5.1"; exit 0; fi\nexit 0\n'
				: `#!/bin/sh\ncase "$1" in\n  stage|--version)\n    exec '${realMinsync.replaceAll("'", "'\\''")}' "$@"\n    ;;\nesac\nexit 0\n`;
		writeFileSync(stub, body);
		chmodSync(stub, 0o755);
		return stub;
	}
	const cached = join(tmpdir(), "dazzi-qa-minsync-stub-v2.exe");
	if (!existsSync(cached)) {
		const source = join(tmpdir(), "dazzi-qa-minsync-stub-v2.mjs");
		writeFileSync(
			source,
			[
				'import { spawnSync } from "node:child_process";',
				'import { existsSync } from "node:fs";',
				'const args = process.argv.slice(2);',
				'const real = process.env.DAZZI_REAL_MINSYNC || "";',
				'if ((args[0] === "stage" || args[0] === "--version") && real && existsSync(real)) {',
				'  const r = spawnSync(real, args, { stdio: "inherit" });',
				'  process.exit(r.status ?? 1);',
				'}',
				'if (args[0] === "--version") console.log("minsync 0.5.1");',
				'process.exit(0);',
			].join("\n"),
		);
		execFileSync(process.execPath, ["build", "--compile", source, "--outfile", cached], { stdio: "ignore" });
	}
	if (realMinsync !== null) process.env.DAZZI_REAL_MINSYNC = realMinsync;
	const stub = join(binDir, "minsync.exe");
	copyFileSync(cached, stub);
	return stub;
}

/**
 * Re-encode (and optionally resize) an image for a fixture: `sips` on macOS, `ffmpeg` elsewhere. The output
 * format follows `to`'s extension in both.
 */
export function convertImage(from, to, size) {
	if (isMac) {
		const format = /\.jpe?g$/iu.test(to) ? ["-s", "format", "jpeg"] : [];
		execFileSync("sips", [...(size === undefined ? [] : ["-z", String(size.height), String(size.width)]), ...format, from, "--out", to], { stdio: "ignore" });
		return;
	}
	execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", from, ...(size === undefined ? [] : ["-vf", `scale=${size.width}:${size.height}`]), to], { stdio: "ignore" });
}
