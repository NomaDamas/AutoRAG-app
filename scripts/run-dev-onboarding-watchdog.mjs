// The SIGKILL safety net behind `make onboarding` (scripts/run-dev-onboarding.mjs).
// The wrapper spawns this detached: when the wrapper dies in a way it cannot
// handle — SIGKILL — this process notices, kills the run's processes (matched
// by the unique sandbox path on their command line), and removes the sandbox.
//
// It exits on its own once the wrapper removes the sandbox (the marker file
// disappears) or when the wrapper is alive and healthy again, so a normal
// `make onboarding` leaves nothing extra running.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const wrapperPid = Number(process.argv[2]);
const sandbox = process.argv[3];
const POLL_MS = 1000;

if (!Number.isInteger(wrapperPid) || wrapperPid <= 0 || typeof sandbox !== "string" || !sandbox.startsWith(join(tmpdir(), "autorag-onboarding-"))) {
	console.error("[onboarding-watchdog] invalid arguments; refusing to run");
	process.exit(1);
}

const markerPath = join(sandbox, ".onboarding-sandbox.json");
console.error(`[onboarding-watchdog] started (pid ${String(process.pid)}), watching wrapper ${String(wrapperPid)}`);

function alive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

function killSandboxProcesses() {
	// Processes can carry either spelling of the sandbox path (`/var` →
	// `/private/var` on macOS), so match the realpath too.
	const paths = new Set([sandbox, realpathSyncSafe(sandbox)]);
	for (const row of listProcessRows()) {
		if (row.pid === process.pid) continue;
		if (![...paths].some((path) => row.args.includes(path))) continue;
		try {
			process.kill(row.pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
}

function realpathSyncSafe(path) {
	try {
		return require("node:fs").realpathSync(path);
	} catch {
		return path;
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

function removeSandbox() {
	if (!existsSync(markerPath)) return; // the wrapper already cleaned up
	for (let attempt = 0; attempt < 10; attempt += 1) {
		try {
			rmSync(sandbox, { recursive: true, force: true });
			console.log(`[onboarding-watchdog] wrapper died; removed ${sandbox}`);
			return;
		} catch {
			// A file may still be unwinding from a killed process; retry.
		}
	}
	console.warn(`[onboarding-watchdog] could not remove ${sandbox}; the next make onboarding sweeps it`);
}

function tick() {
	if (!existsSync(markerPath)) {
		// The wrapper finished its own teardown; nothing left to guard.
		process.exit(0);
	}
	if (alive(wrapperPid)) {
		setTimeout(tick, POLL_MS);
		return;
	}
	// The wrapper is gone without cleaning up (SIGKILL). Take over: kill this
	// run's processes, then remove the sandbox.
	try {
		const marker = JSON.parse(readFileSync(markerPath, "utf8"));
		if (marker.sandbox !== sandbox) process.exit(1); // never touch anything else
	} catch {
		// Unreadable marker: the directory still carries the sandbox name and
		// this watchdog's own invocation, so removal stays sandbox-scoped.
	}
	killSandboxProcesses();
	removeSandbox();
	process.exit(0);
}

tick();
