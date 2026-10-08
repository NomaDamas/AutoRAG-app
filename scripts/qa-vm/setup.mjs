/**
 * Build the golden QA image from Cirrus Labs' vanilla macOS image.
 *
 *   bun scripts/qa-vm.mjs setup [--rebuild]
 *
 * The image is built as `autorag-qa-golden-build` and renamed to
 * `autorag-qa-golden` only after verification, so a failed build never leaves
 * a half-provisioned image that runs would clone. Steps, in order:
 *
 *  1. Recovery boot, driven over VNC: `csrutil disable`. SIP must be off to
 *     write the system TCC database; without a Screen Recording grant,
 *     `screencapture` fails with "could not create image from display".
 *  2. Normal boot, password SSH: install our public key, then provision
 *     (see provision-guest.sh). Everything after this uses the key.
 *  3. Verify screen capture, Rosetta, and tools; stop; rename.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	BUILD,
	GOLDEN,
	GUEST_BOOTSTRAP_PASSWORD,
	GUEST_USER,
	KEY_FILE,
	QA_HOME,
	VANILLA_IMAGE,
	VENV_DIR,
	VM_CPU,
	VM_DISPLAY,
	VM_MEMORY_MB,
} from "./config.mjs";
import { pushFile, sshOk, sshRun, waitForSsh } from "./guest.mjs";
import {
	cloneVm,
	configureVm,
	destroyVm,
	listVms,
	pullImage,
	renameVm,
	sleep,
	startRecovery,
	startVm,
	stopVm,
	vmExists,
	waitForIp,
	waitUntilStopped,
} from "./tart.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const log = (message) => process.stdout.write(`[qa:vm setup] ${message}\n`);

/** A fresh Python venv with vncdotool, the only dependency of the Recovery step. */
function ensureVncdo() {
	const vncdo = join(VENV_DIR, "bin", "vncdo");
	if (existsSync(vncdo)) return vncdo;
	log("installing vncdotool into a private venv (Recovery is driven over VNC)");
	execFileSync("python3", ["-m", "venv", VENV_DIR], { stdio: "inherit" });
	execFileSync(join(VENV_DIR, "bin", "pip"), ["install", "--quiet", "vncdotool"], { stdio: "inherit" });
	return vncdo;
}

function ensureKey() {
	mkdirSync(QA_HOME, { recursive: true, mode: 0o700 });
	if (!existsSync(KEY_FILE)) {
		execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "autorag-qa", "-f", KEY_FILE]);
		chmodSync(KEY_FILE, 0o600);
	}
	return readFileSync(`${KEY_FILE}.pub`, "utf8").trim();
}

/** Password SSH, used only until the key is installed. */
function passwordSsh(ip, command, input) {
	return execFileSync(
		"sshpass",
		[
			"-e", "ssh",
			"-o", "PubkeyAuthentication=no",
			"-o", "PreferredAuthentications=password",
			"-o", "StrictHostKeyChecking=no",
			"-o", "UserKnownHostsFile=/dev/null",
			"-o", "LogLevel=ERROR",
			`${GUEST_USER}@${ip}`,
			command,
		],
		{ encoding: "utf8", env: { ...process.env, SSHPASS: GUEST_BOOTSTRAP_PASSWORD }, input },
	);
}

/** Drive Recovery's Terminal over VNC. Coordinates are for a 1440x900 display. */
async function disableSip(name) {
	const vncdo = ensureVncdo();
	const { child, endpoint } = startRecovery(name);
	try {
		const { password, port } = await endpoint;
		const vnc = (...steps) => execFileSync(vncdo, ["-s", `127.0.0.1::${port}`, "--password", password, ...steps], { stdio: "ignore" });
		log("Recovery booting");
		await sleep(30_000);
		// Boot picker: select "Options", then Continue.
		vnc("move", "831", "403", "pause", "0.5", "click", "1", "pause", "1", "click", "1");
		await sleep(3000);
		vnc("move", "831", "531", "pause", "0.3", "click", "1");
		await sleep(35_000);
		// Utilities menu, Terminal.
		vnc("move", "244", "15", "pause", "0.3", "click", "1");
		await sleep(2000);
		vnc("move", "250", "97", "pause", "0.3", "click", "1");
		await sleep(5000);
		vnc("type", "csrutil disable", "pause", "0.5", "key", "enter");
		await sleep(5000);
		vnc("type", "y", "key", "enter");
		await sleep(5000);
		vnc("type", GUEST_USER, "key", "enter", "pause", "2", "type", GUEST_BOOTSTRAP_PASSWORD, "key", "enter");
		await sleep(10_000);
		vnc("type", "csrutil status", "key", "enter");
		await sleep(3000);
	} finally {
		stopVm(name);
		child.kill("SIGTERM");
	}
	await waitUntilStopped(name);
}

export async function setup({ rebuild }) {
	if (vmExists(GOLDEN) && !rebuild) {
		log(`${GOLDEN} already exists (use --rebuild to replace it)`);
		return;
	}
	for (const vm of listVms()) {
		if (vm.Running) throw new Error(`${vm.Name} is running; stop it first (setup needs both VM slots)`);
	}
	const publicKey = ensureKey();
	await destroyVm(BUILD);

	if (!vmExists(VANILLA_IMAGE)) {
		log(`pulling ${VANILLA_IMAGE} (about 25 GB, once)`);
		pullImage(VANILLA_IMAGE);
	}
	cloneVm(VANILLA_IMAGE, BUILD);
	configureVm(BUILD, { cpu: VM_CPU, memoryMb: VM_MEMORY_MB, display: VM_DISPLAY });

	try {
		log("step 1/3: disabling SIP in Recovery");
		await disableSip(BUILD);

		log("step 2/3: provisioning");
		const logFile = join(QA_HOME, "setup-vm.log");
		rmSync(logFile, { force: true });
		startVm(BUILD, { logFile });
		const ip = await waitForIp(BUILD);
		for (let attempt = 0; ; attempt++) {
			try {
				passwordSsh(ip, "true");
				break;
			} catch (error) {
				if (attempt > 60) throw error;
				await sleep(3000);
			}
		}
		passwordSsh(ip, "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys", `${publicKey}\n`);
		await waitForSsh(ip);
		// A file, not `bash -s`: brew reads stdin, which would swallow the rest of a piped script.
		await pushFile(ip, join(HERE, "provision-guest.sh"), "provision-guest.sh");
		await sshOk(ip, "bash ~/provision-guest.sh < /dev/null && rm -f ~/provision-guest.sh", { onData: (text) => process.stdout.write(text) });

		// dupey is a Rust CLI the app shells out to; the host's arm64 build is
		// copied rather than compiling Rust in the guest.
		const dupey = execFileSync("which", ["dupey"], { encoding: "utf8" }).trim();
		await pushFile(ip, dupey, "bin/dupey");
		await sshOk(ip, "chmod 755 ~/bin/dupey && ~/bin/dupey --version");

		log("step 3/3: verifying");
		const verify = await sshRun(
			ip,
			`${"export PATH=/opt/homebrew/bin:$HOME/bin:$HOME/tools/node/bin:$PATH"}; csrutil status; screencapture -x /tmp/verify.png && test -s /tmp/verify.png && echo capture-ok; test -d /Library/Apple/usr/share/rosetta && echo rosetta-ok; node --version; bun --version; dupey --version; ffmpeg -version | head -1; git --version`,
		);
		log(`\n${verify.output}`);
		for (const needle of ["System Integrity Protection status: disabled", "capture-ok", "rosetta-ok"]) {
			if (!verify.output.includes(needle)) throw new Error(`verification failed: "${needle}" missing`);
		}
		await sshRun(ip, "sudo shutdown -h now");
		await waitUntilStopped(BUILD, 120_000);
	} catch (error) {
		stopVm(BUILD);
		log(`failed; ${BUILD} is kept for inspection (tart run ${BUILD}). Remove it with: tart delete ${BUILD}`);
		throw error;
	}

	if (vmExists(GOLDEN)) await destroyVm(GOLDEN);
	renameVm(BUILD, GOLDEN);
	log(`${GOLDEN} is ready`);
}
