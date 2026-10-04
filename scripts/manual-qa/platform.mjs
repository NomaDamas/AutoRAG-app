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

import { execSync } from "node:child_process";
import { copyFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
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
