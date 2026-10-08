// `make onboarding` entry point: launch the dev app on a disposable profile so
// the first-run onboarding can be walked without touching the machine's real
// AutoRAG state.
//
// Isolation per run:
// - userData (onboarding draft, credentials, caches): tmp sandbox via
//   `--user-data-dir` (the app's own support dir is left alone);
// - AUTORAG_CONFIG + AUTORAG_HOME + AUTORAG_WORKSPACE: tmp sandbox (the real
//   `~/.autorag/config.json`, index, and memory are never read or written);
// - the embedding model and llama runtime are COPIED into the sandbox so the
//   first index runs offline; the real cache is never written through.
//
// Teardown, ordered from graceful to brutal:
// - wrapper exit (any cause, including Ctrl+C): kill the run's processes
//   (SIGTERM, then SIGKILL) and remove the sandbox;
// - SIGKILL of the wrapper: a detached watchdog notices the wrapper died and
//   does the same;
// - SIGKILL of both: the next `make onboarding` sweeps sandboxes whose owner
//   and watchdog are gone.
//
// Nothing outside the sandbox is removed, written, or killed: the sandbox
// directory always lives in the OS tmpdir under a fixed prefix and carries a
// marker file, so cleanup can never match anything else.

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// This script lives in <repo>/scripts/, so the repo root is the parent.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PREFIX = "autorag-onboarding-";

function fail(message) {
	console.error(`[onboarding] ${message}`);
	process.exit(1);
}

// Kill and remove every sandbox whose owner and watchdog are both gone: a
// SIGKILLed wrapper leaves the sandbox (and its processes) behind otherwise.
// Owner and watchdog pids are checked alive, so an ACTIVE sandbox (this run,
// or a live pair) is never touched.
function sweepStaleSandboxes() {
	let dir;
	try {
		dir = readdirSync(tmpdir());
	} catch {
		return;
	}
	for (const name of dir) {
		if (!name.startsWith(PREFIX)) continue;
		const sandbox = join(tmpdir(), name);
		if (!isManagedSandbox(sandbox)) continue;
		const { owner, watchdog } = readOwner(join(sandbox, ".onboarding-sandbox.json"));
		// Someone still owns it (this run, or a still-alive pair) — leave it alone.
		if (alive(owner) || alive(watchdog)) continue;
		console.log(`[onboarding] sweeping stale sandbox ${sandbox}`);
		killPathProcesses(sandbox);
		rmManaged(sandbox);
	}
}

// A leaked daemon (llama-server, fsearch-cli) carries its DEAD sandbox's path
// on its command line, so no dir-based sweep can find it once the dir is gone.
// Scan the process table and kill only rows whose sandbox no longer exists;
// live runs (dirs present) are never touched. Not on Windows: no `ps`, and the
// `make` target is a macOS/Linux path anyway.
function reapOrphanSandboxProcesses() {
	if (process.platform === "win32") return;
	for (const row of listProcessRows()) {
		if (row.pid === process.pid) continue;
		for (const match of row.args.matchAll(/\S*autorag-onboarding-[A-Za-z0-9]+/g)) {
			const sandbox = match[0];
			if (existsSync(sandbox)) continue; // a live run (this one, or a concurrent one)
			try {
				process.kill(row.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
			break;
		}
	}
}

function isManagedSandbox(sandbox) {
	try {
		return existsSync(join(sandbox, ".onboarding-sandbox.json"));
	} catch {
		return false;
	}
}

function readOwner(markerPath) {
	try {
		const marker = JSON.parse(readFileSync(markerPath, "utf8"));
		return { owner: marker.owner, watchdog: marker.watchdog };
	} catch {
		return { owner: null, watchdog: null };
	}
}

function alive(pid) {
	if (typeof pid !== "number" || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

function killPathProcesses(sandbox, signal) {
	if (process.platform === "win32") return; // not a `make` target platform
	// Match both spellings (`/var` → `/private/var`); a plain array, not a Set:
	// `.some` is an array method.
	const paths = [sandbox, realpathSyncSafe(sandbox)];
	for (const row of listProcessRows()) {
		if (row.pid === process.pid) continue;
		if (!paths.some((path) => row.args.includes(path))) continue;
		try {
			process.kill(row.pid, signal);
		} catch {
			// Already gone.
		}
	}
}

function listProcessRows() {
	let stdout;
	try {
		stdout = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout ?? "";
	} catch {
		return [];
	}
	const rows = [];
	for (const line of stdout.split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(.*)$/);
		if (match) rows.push({ pid: Number(match[1]), args: match[2] });
	}
	return rows;
}


function realpathSyncSafe(path) {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function rmManaged(sandbox) {
	if (!isManagedSandbox(sandbox)) return;
	for (let attempt = 0; attempt < 10; attempt += 1) {
		try {
			rmSync(sandbox, { recursive: true, force: true });
			return;
		} catch {
			// A file may still be unwinding from a killed process; retry.
		}
	}
	console.warn(`[onboarding] could not remove ${sandbox}; the next run sweeps it again`);
}

// A deep copy (not a symlink) of the cached model and llama runtime, so the
// sandbox never writes through into the real cache. macOS clones it in APFS
// copy-on-write when source and destination share the volume.
function copyDirInto(source, destination) {
	cpSync(source, destination, { recursive: true, preserveTimestamps: true, force: true });
}

async function main() {
	sweepStaleSandboxes();
	reapOrphanSandboxProcesses();

	const realHome = process.env.AUTORAG_HOME?.trim() || join(homedir(), ".autorag");
	const sandbox = mkdtempSync(join(tmpdir(), PREFIX));
	const autoragHome = join(sandbox, "autorag-home");
	const configPath = join(sandbox, "config.json");
	const userDataDir = join(sandbox, "user-data");
	mkdirSync(autoragHome, { recursive: true });
	mkdirSync(userDataDir, { recursive: true });
	for (const cache of ["models", "runtime"]) {
		const source = join(realHome, cache);
		if (!existsSync(source)) continue; // the first index then downloads it into the sandbox
		try {
			copyDirInto(source, join(autoragHome, cache));
		} catch (error) {
			fail(`could not copy the real ${cache} cache into the sandbox: ${error}`);
		}
	}
	const marker = { owner: process.pid, watchdog: null, sandbox };
	writeFileSync(join(sandbox, ".onboarding-sandbox.json"), `${JSON.stringify(marker, null, "\t")}\n`);

	// Everything else passes through, so the dev preflight runs the same dupey
	// check `make run` does.
	const env = {
		...process.env,
		AUTORAG_HOME: autoragHome,
		AUTORAG_CONFIG: configPath,
		AUTORAG_WORKSPACE: join(autoragHome, "workspace"),
	};

	// Same dev entry point as `make run`: predev hooks sync the librarian and
	// electron-vite starts the renderer dev server and Electron. `--` twice:
	// bun forwards one, electron-vite needs the second to pass the rest to
	// Electron (`Unknown option --userDataDir` otherwise).
	const dev = spawn("bun", ["run", "dev", "--", "--", `--user-data-dir=${userDataDir}`], {
		cwd: ROOT,
		env,
		stdio: ["ignore", "inherit", "inherit"],
	});
	console.log(`[onboarding] sandbox ${sandbox}`);
	console.log("[onboarding] the real ~/.autorag and the app's support dir are untouched");
	console.log("[onboarding] press Ctrl+C or quit the app; everything is removed afterwards");

	const watchdog = spawn(process.execPath, [join(ROOT, "scripts", "run-dev-onboarding-watchdog.mjs"), String(process.pid), sandbox], {
		// stderr is inherited so a crash trace lands in this wrapper's console
		// instead of vanishing; stdin is ignored (never wait on it).
		stdio: ["ignore", "ignore", "inherit"],
		detached: true,
	});
	// The watchdog must outlive this wrapper (it is the SIGKILL safety net), so
	// it owns its own session and this wrapper never waits on it. Its own
	// stderr is discarded (nothing to see while it ticks), so surface any exit
	// here: a dead watchdog means SIGKILL of this wrapper would leak the
	// sandbox until the next run's sweep.
	watchdog.on("exit", (code, signal) => {
		if (!finished) console.error(`[onboarding] watchdog exited unexpectedly (code ${String(code)}, signal ${String(signal)})`);
	});
	watchdog.on("error", (error) => console.error(`[onboarding] watchdog could not start: ${error}`));
	watchdog.unref();
	writeFileSync(join(sandbox, ".onboarding-sandbox.json"), `${JSON.stringify({ ...marker, watchdog: watchdog.pid }, null, "\t")}\n`);

	let finished = false;
	async function teardown(summary) {
		if (finished) return;
		finished = true;
		killPathProcesses(sandbox, "SIGTERM");
		await delayMs(1200);
		killPathProcesses(sandbox, "SIGKILL"); // anything that ignored SIGTERM
		rmManaged(sandbox);
		// The watchdog dies LAST: if this wrapper itself is SIGKILLed during the
		// 1200ms settle above (exactly what a 300s tool timeout does), a live
		// watchdog still sees this wrapper gone and finishes the cleanup itself.
		killWatchdog();
		console.log(`[onboarding] ${summary}`);
	}

	function killWatchdog() {
		try {
			process.kill(watchdog.pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}

	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		process.on(signal, () => {
			// `finished` makes this idempotent: whichever fires first — the child's
			// exit or this signal — tears the sandbox down exactly once. Without
			// this, a signal arriving after the child died would leave nothing to
			// run the teardown.
			dev.kill(signal);
			void teardown(`received ${signal}; sandbox removed`);
		});
	}
	dev.on("exit", () => {
		void teardown("dev exited; sandbox removed");
	});
	process.on("exit", () => {
		// Best effort only: `exit` cannot await. The synchronous steps here are
		// the important ones (kill + unlink); the wait for graceful death
		// happened in the async path above.
		if (!finished) {
			finished = true;
			killWatchdog();
			killPathProcesses(sandbox, "SIGKILL");
			rmManaged(sandbox);
		}
	});
}

function delayMs(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
