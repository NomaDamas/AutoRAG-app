/** SSH, rsync, and readiness probes against a QA VM. Authenticates with the key baked into the golden image. */

import { spawn } from "node:child_process";
import { GUEST_USER, KEY_FILE } from "./config.mjs";
import { sleep } from "./tart.mjs";

const SSH_OPTIONS = [
	"-i", KEY_FILE,
	"-o", "IdentitiesOnly=yes",
	"-o", "PreferredAuthentications=publickey",
	"-o", "StrictHostKeyChecking=no",
	"-o", "UserKnownHostsFile=/dev/null",
	"-o", "LogLevel=ERROR",
	"-o", "ConnectTimeout=10",
	"-o", "ServerAliveInterval=30",
	"-o", "ServerAliveCountMax=6",
];

/** Non-interactive ssh shells skip the login profile, so commands put the toolchain on PATH themselves. */
export const GUEST_ENV = "export PATH=/opt/homebrew/bin:$HOME/bin:$HOME/tools/node/bin:$PATH";

export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const target = (ip) => `${GUEST_USER}@${ip}`;

/**
 * Run a command in the guest. `onData` receives output as it arrives; `input`
 * is written to the command's stdin. Resolves with the exit code (255 means
 * the connection itself failed) and the combined output.
 */
export function sshRun(ip, command, { onData, input, signal } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", [...SSH_OPTIONS, target(ip), command], { stdio: ["pipe", "pipe", "pipe"], signal });
		let output = "";
		const collect = (chunk) => {
			const text = String(chunk);
			output += text;
			onData?.(text);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.once("error", (error) => (error.name === "AbortError" ? resolve({ code: null, output, aborted: true }) : reject(error)));
		child.once("close", (code) => resolve({ code, output }));
		child.stdin.end(input ?? "");
	});
}

export async function sshOk(ip, command, options) {
	const result = await sshRun(ip, command, options);
	if (result.code !== 0) throw new Error(`guest command failed (exit ${result.code}): ${command}\n${result.output}`);
	return result.output;
}

export async function waitForSsh(ip, timeoutMs = 180_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const { code } = await sshRun(ip, "true");
		if (code === 0) return;
		if (Date.now() > deadline) throw new Error(`ssh to ${ip} did not come up within ${timeoutMs / 1000}s`);
		await sleep(2000);
	}
}

function rsync(args) {
	return new Promise((resolve, reject) => {
		const rsh = `ssh ${SSH_OPTIONS.map(shellQuote).join(" ")}`;
		const child = spawn("rsync", ["-a", "-e", rsh, ...args], { stdio: ["ignore", "inherit", "inherit"] });
		child.once("error", reject);
		child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`rsync exited with ${code}`))));
	});
}

/** Mirror a local directory into the guest (relative paths are under the guest home). */
export function pushTree(ip, source, destination, { excludes = [] } = {}) {
	return rsync(["--delete", ...excludes.flatMap((pattern) => ["--exclude", pattern]), `${source}/`, `${target(ip)}:${destination}/`]);
}

export function pushFile(ip, source, destination) {
	return rsync([source, `${target(ip)}:${destination}`]);
}

/** Copy a guest directory's contents to the host. */
export function pullTree(ip, source, destination) {
	return rsync([`${target(ip)}:${source}/`, `${destination}/`]);
}

/**
 * Block until the guest can run a lane: the GUI session is up, the display can
 * be captured, and Spotlight answers for a fresh file in `~/Documents` (the
 * Kind lane reads it, and `mds` is busy for a while after a boot or a sync).
 * Spotlight is reported but never fatal: its answer is slow, not wrong.
 */
export async function waitForReady(ip, log) {
	const script = `
		for i in $(seq 1 90); do pgrep -x Finder >/dev/null && pgrep -x Dock >/dev/null && break; sleep 1; done
		pgrep -x Finder >/dev/null || { echo "GUI session never came up (no Finder)"; exit 10; }
		screencapture -x -R0,0,16,16 /tmp/qa-ready.png 2>/dev/null && [ -s /tmp/qa-ready.png ] || { echo "screencapture cannot read the display (TCC grant missing?)"; exit 11; }
		rm -f /tmp/qa-ready.png
		probe="$HOME/Documents/.qa-ready-$$.mp4"; echo x > "$probe"
		for i in $(seq 1 240); do
			kind=$(/usr/bin/mdls -name kMDItemKind -raw "$probe" 2>/dev/null)
			[ -n "$kind" ] && [ "$kind" != "(null)" ] && { rm -f "$probe"; exit 0; }
			sleep 0.5
		done
		rm -f "$probe"; echo "Spotlight did not answer within 120s"; exit 12`;
	const { code, output } = await sshRun(ip, script);
	if (code === 12) log(`warning: ${output.trim()}; the Kind lane may flake`);
	else if (code !== 0) throw new Error(`guest is not ready: ${output.trim() || `exit ${code}`}`);
}
