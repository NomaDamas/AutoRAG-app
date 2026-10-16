/**
 * One QA run: pick the VM path or the host path, then run the lanes.
 *
 * VM path: take a slot, clone the golden image, boot it headless, mirror this
 * checkout into it, run `run-all.mjs` there over ssh, pull the evidence back,
 * and destroy the VM, whatever happened. The VM has its own display, input
 * session, home, and Trash, so the developer's mouse and keyboard stay theirs
 * and several checkouts can run side by side.
 *
 * Host path: `run-all.mjs` on this machine, exactly as before. It drives the
 * real desktop, so a window will take focus. Nothing falls back to it silently
 * except when the pool is full: that is announced, then it runs.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { GOLDEN, GUEST_REPO, MAX_VMS, RUNS_DIR, RUN_PREFIX, SLOTS_DIR, VM_CPU, VM_DISPLAY, VM_MEMORY_MB } from "./config.mjs";
import { GUEST_ENV, pullTree, pushTree, shellQuote, sshOk, sshRun, waitForReady, waitForSsh } from "./guest.mjs";
import { guestScriptPath, needsEmbeddingAssets, orphanVmNames, runVmName, vmCapacity, vmExitCode } from "./plan.mjs";
import { createSlotPool } from "./slots.mjs";
import { cloneVm, configureVm, destroyVm, listVms, startVm, tartAvailable, vmExists, waitForIp } from "./tart.mjs";

const log = (message) => process.stdout.write(`[qa:vm] ${message}\n`);

function git(root, ...args) {
	try {
		return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

/**
 * The slot pool. A reclaimed slot's VM name is collected, and `destroyReaped`
 * (always awaited by the caller) deletes those VMs, so none outlives the
 * command that found it.
 */
function openPool() {
	const reaped = [];
	const pool = createSlotPool({
		dir: SLOTS_DIR,
		onReap: (owner) => {
			if (owner?.vm) reaped.push(owner.vm);
		},
	});
	async function destroyReaped() {
		for (let name = reaped.shift(); name !== undefined; name = reaped.shift()) {
			log(`reclaimed the slot of a dead run; destroying ${name}`);
			await destroyVm(name);
		}
	}
	return { pool, destroyReaped };
}

/** Why the VM path cannot run on this machine at all, or null when it can. */
export function vmUnavailableReason() {
	if (process.platform !== "darwin" || process.arch !== "arm64") return "macOS VMs need an Apple Silicon Mac";
	if (!tartAvailable()) return "tart is not installed";
	if (!vmExists(GOLDEN)) return `${GOLDEN} does not exist (run: bun scripts/qa-vm.mjs setup)`;
	return null;
}

/** Take a VM slot, or null when the machine already runs the most VMs macOS allows. */
async function takeSlot({ pool, destroyReaped }, vmName) {
	pool.reapStale();
	await destroyReaped();
	const capacity = vmCapacity(listVms(), { max: MAX_VMS, runPrefix: RUN_PREFIX });
	const slot = pool.acquire({ capacity, owner: { vm: vmName } });
	await destroyReaped();
	return slot;
}

function buildApp(root) {
	log("bun run build");
	execFileSync("bun", ["run", "build"], { cwd: root, stdio: "inherit" });
}

/** Fail loudly if the build is older than the sources the VM would test. */
function assertBuildFresh(root) {
	const stale = execFileSync("find", ["src", "-newer", "out/main/index.js", "-type", "f", "-print", "-quit"], { cwd: root, encoding: "utf8" }).trim();
	if (stale !== "") throw new Error(`out/ is older than ${stale}; run \`bun run build\` (or drop --skip-build)`);
}

/** Run a job on this machine: the sweep, or one agent-written script with `QA_OUT` as its artifact directory. */
export function runOnHost({ root, job, artifactDir }) {
	const { command, args } = hostCommand(job);
	mkdirSync(artifactDir, { recursive: true });
	return new Promise((resolve) => {
		const child = spawn(command, args, { cwd: root, stdio: "inherit", env: { ...process.env, QA_OUT: artifactDir } });
		child.once("close", (code) => resolve(code ?? 1));
	});
}

const hostCommand = (job) =>
	job.kind === "script"
		? { command: "bun", args: [job.file, ...job.args] }
		: { command: "bun", args: [join("scripts", "manual-qa", "run-all.mjs"), ...job.lanes] };

/**
 * Copy the host's embedding model and runtime into the guest's `~/.autorag`.
 * Without them a real first index fails ("Embedding runtime assets are
 * unavailable"). Absent on the host, nothing is copied and the lane reports it.
 */
async function pushEmbeddingAssets(ip, signal) {
	const home = process.env.AUTORAG_HOME?.trim() || join(homedir(), ".autorag");
	const present = ["models", "runtime"].filter((name) => existsSync(join(home, name)));
	if (present.length === 0) {
		log(`no embedding assets under ${home}; a lane that indexes for real will fail in the guest`);
		return;
	}
	log(`copying embedding assets (${present.join(", ")}) into the guest`);
	await sshOk(ip, "mkdir -p \"$HOME/.autorag\"");
	for (const name of present) await pushTree(ip, join(home, name), `.autorag/${name}`, { signal });
}

/**
 * Run a job in a fresh VM. Resolves with its exit code. The sweep's evidence
 * lives under `.omo/evidence`; a script's artifacts land in `QA_OUT` (`~/qa-out`
 * in the guest), and either way they are pulled to `<runDir>/evidence`.
 */
export async function runInVm({ root, job, slot, vmName, runDir }) {
	const abort = new AbortController();
	const onSignal = (signal) => abort.abort(new Error(`interrupted by ${signal}`));
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	const interrupted = () => {
		if (abort.signal.aborted) throw abort.signal.reason;
	};
	try {
		mkdirSync(runDir, { recursive: true });
		log(`slot ${slot.index}: cloning ${GOLDEN} -> ${vmName}`);
		cloneVm(GOLDEN, vmName);
		configureVm(vmName, { cpu: VM_CPU, memoryMb: VM_MEMORY_MB, display: VM_DISPLAY });
		startVm(vmName, { logFile: join(runDir, "tart.log") });
		const ip = await waitForIp(vmName);
		await waitForSsh(ip, 180_000, { signal: abort.signal });
		log(`${vmName} is up at ${ip}`);
		interrupted();
		log("syncing the checkout (node_modules and out/ included; .upstream, release artifacts, and evidence excluded)");
		await pushTree(ip, root, GUEST_REPO, { excludes: ["/.upstream", "/.omo/evidence", "/.autorag", "/build/stage", "/build/.cache", "/dist", ".DS_Store"], signal: abort.signal });
		await waitForReady(ip, log, abort.signal);
		interrupted();
		if (needsEmbeddingAssets(job)) await pushEmbeddingAssets(ip, abort.signal);
		interrupted();

		log(job.kind === "script" ? `running ${job.file}` : `running lanes${job.lanes.length > 0 ? `: ${job.lanes.join(", ")}` : " (all)"}`);
		const command =
			job.kind === "script"
				? `mkdir -p "$HOME/qa-out" && cd ${GUEST_REPO} && QA_OUT="$HOME/qa-out" bun ${[job.file, ...job.args].map(shellQuote).join(" ")}`
				: `cd ${GUEST_REPO} && bun scripts/manual-qa/run-all.mjs ${job.lanes.map(shellQuote).join(" ")}`;
		const result = await sshRun(ip, `${GUEST_ENV}; ${command}`, {
			onData: (text) => process.stdout.write(text),
			signal: abort.signal,
		});
		interrupted();
		if (result.code === 255) throw new Error("lost the ssh connection to the VM mid-run");

		const evidence = join(runDir, "evidence");
		mkdirSync(evidence, { recursive: true });
		const remote = job.kind === "script" ? "qa-out" : `${GUEST_REPO}/.omo/evidence`;
		const pulled = await pullTree(ip, remote, evidence).then(
			() => true,
			(error) => {
				log(`could not pull artifacts: ${error.message}`);
				return false;
			},
		);
		log(`artifacts: ${evidence}${pulled ? "" : " (INCOMPLETE)"}`);
		// The VM is destroyed in the finally below, so a pull that failed must
		// not be reported as success: the evidence is otherwise gone for good.
		return vmExitCode(result.code, pulled);
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		// The slot is released even when the VM could not be destroyed, so the
		// failure surfaces instead of an orphan that later runs oversubscribe.
		try {
			await destroyVm(vmName);
		} finally {
			slot.release();
		}
	}
}

/**
 * Decide the path and run. Exit codes: the job's own; 2 when `--vm` was
 * demanded and cannot be served; 75 when a VM job passed but its artifacts
 * could not be pulled back before the VM was destroyed.
 */
export async function run({ root, options }) {
	if (options.command === "script") assertScriptExists(root, options.script);
	const job =
		options.command === "script"
			? { kind: "script", file: guestScriptPath(root, options.script), args: options.scriptArgs }
			: { kind: "sweep", lanes: options.lanes };
	const reason = options.mode === "host" ? "--host" : vmUnavailableReason();
	// `--vm` promises that nothing runs on this machine, so refuse before the
	// build instead of spending minutes building for an exit code.
	if (reason !== null && options.mode === "vm") {
		process.stderr.write(`[qa:vm] cannot use a VM: ${reason}\n`);
		return 2;
	}
	const branch = git(root, "rev-parse", "--abbrev-ref", "HEAD");
	if (!options.skipBuild) buildApp(root);
	else assertBuildFresh(root);

	const vmName = runVmName({ prefix: RUN_PREFIX, branch, suffix: `${Date.now().toString(36)}-${process.pid}` });
	const runDir = join(RUNS_DIR, vmName);
	const onHost = () => runOnHost({ root, job, artifactDir: join(runDir, "evidence") });

	if (reason !== null) {
		log(reason === "--host" ? "running on this machine (--host); a window will take focus" : `running on this machine: ${reason}`);
		return onHost();
	}

	const handle = openPool();
	const { pool } = handle;
	const slot = await takeSlot(handle, vmName);
	if (slot === null) {
		const holders = pool
			.holders()
			.map((holder) => holder.owner?.vm ?? "(starting)")
			.join(", ");
		if (options.mode === "vm") {
			process.stderr.write(`[qa:vm] all ${MAX_VMS} VM slots are busy (${holders}); not falling back because --vm was given\n`);
			return 2;
		}
		log(`all ${MAX_VMS} VM slots are busy (${holders}); running on this machine instead. A window will take focus; avoid the keyboard and mouse until it finishes, or retry later for a VM.`);
		return onHost();
	}

	return runInVm({ root, job, slot, vmName, runDir });
}

/** A script path must exist and sit inside the checkout, since only the checkout is synced to the VM. */
function assertScriptExists(root, file) {
	const absolute = resolve(root, file);
	if (!absolute.startsWith(`${root}${sep}`)) throw new Error(`${file} is outside the checkout; the VM only receives the checkout`);
	if (!existsSync(absolute)) throw new Error(`${file} does not exist`);
}

/** Print the golden image, the VMs, and who holds each slot. */
export function status() {
	const reason = vmUnavailableReason();
	log(reason === null ? `${GOLDEN}: ready` : `VM path unavailable: ${reason}`);
	const vms = listVms();
	log(`macOS VMs running: ${vms.filter((vm) => vm.Running).length}/${MAX_VMS}`);
	for (const vm of vms.filter((candidate) => candidate.Source === "local")) log(`  ${vm.Name}  ${vm.Running ? "running" : "stopped"}`);
	const { pool } = openPool();
	const holders = pool.holders();
	if (holders.length === 0) log("slots: none held");
	for (const holder of holders) log(`slot ${holder.index}: ${holder.owner === null ? "(starting)" : `${holder.owner.vm} (pid ${holder.owner.pid})`}`);
}

/** Destroy pool VMs that no live slot names (leftovers of a crashed run). */
export async function gc() {
	const { pool, destroyReaped } = openPool();
	pool.reapStale();
	await destroyReaped();
	const orphans = orphanVmNames(listVms(), pool.holders(), RUN_PREFIX);
	for (const name of orphans) {
		log(`destroying leftover ${name}`);
		await destroyVm(name);
	}
	if (orphans.length === 0) log("no leftover VMs");
}
