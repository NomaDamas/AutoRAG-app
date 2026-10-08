/** Thin wrappers over the `tart` CLI. Storage follows `TART_HOME`, which `applyConfig()` sets. */

import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

const tart = (args) => execFileSync("tart", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function tartAvailable() {
	try {
		tart(["--version"]);
		return true;
	} catch {
		return false;
	}
}

/** `tart list` entries: `{ Name, Running, Source, ... }`. */
export function listVms() {
	return JSON.parse(tart(["list", "--format", "json"]));
}

export const vmExists = (name) => listVms().some((vm) => vm.Name === name && vm.Source === "local");
export const vmRunning = (name) => listVms().some((vm) => vm.Name === name && vm.Running);

export const pullImage = (image) => execFileSync("tart", ["pull", image], { stdio: "inherit" });
export const cloneVm = (from, to) => tart(["clone", from, to]);
export const renameVm = (from, to) => tart(["rename", from, to]);

export function configureVm(name, { cpu, memoryMb, display }) {
	const args = ["set", name, "--cpu", String(cpu), "--memory", String(memoryMb)];
	if (display !== undefined) args.push("--display", display);
	tart(args);
}

/**
 * Boot a VM as a detached process, headless, logging to `logFile`. The
 * returned child outlives this process only if `unref()` is honoured; callers
 * stop the VM through `stopVm`, never by killing the child.
 */
export function startVm(name, { logFile, args = ["--no-graphics"] }) {
	const log = openSync(logFile, "a");
	const child = spawn("tart", ["run", name, ...args], { detached: true, stdio: ["ignore", log, log] });
	closeSync(log);
	child.unref();
	return child;
}

/** Boot into macOS Recovery with the VNC server on; resolves with the endpoint tart prints. */
export function startRecovery(name) {
	const child = spawn("tart", ["run", name, "--recovery", "--vnc-experimental", "--no-clipboard"], { stdio: ["ignore", "pipe", "pipe"] });
	const endpoint = new Promise((resolve, reject) => {
		let seen = "";
		const onData = (chunk) => {
			seen += String(chunk);
			const match = /vnc:\/\/:(\S+)@127\.0\.0\.1:(\d+)/.exec(seen);
			if (match !== null) resolve({ password: match[1], port: match[2] });
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.once("close", () => reject(new Error("tart exited before printing a VNC endpoint")));
	});
	return { child, endpoint };
}

/** The guest's IP once it has DHCP-leased one. */
export function waitForIp(name, seconds = 120) {
	return tart(["ip", name, "--wait", String(seconds)]).trim();
}

export function stopVm(name) {
	try {
		tart(["stop", name]);
	} catch {
		// Already stopped.
	}
}

export async function waitUntilStopped(name, timeoutMs = 90_000) {
	const deadline = Date.now() + timeoutMs;
	while (vmRunning(name)) {
		if (Date.now() > deadline) throw new Error(`${name} did not stop within ${timeoutMs / 1000}s`);
		await sleep(1000);
	}
}

/** Stop and delete a VM. Safe on one that is missing, half-created, or already stopped. */
export async function destroyVm(name) {
	if (!listVms().some((vm) => vm.Name === name)) return;
	stopVm(name);
	try {
		await waitUntilStopped(name);
		tart(["delete", name]);
	} catch (error) {
		// A concurrent destroy of the same VM may have won; that is success.
		if (listVms().some((vm) => vm.Name === name)) process.stderr.write(`[qa:vm] could not delete ${name}: ${error.message}\n`);
	}
}
