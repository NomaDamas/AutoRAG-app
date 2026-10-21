/**
 * Pure decisions for the QA runner: command-line parsing, VM naming, and how
 * many VM slots the machine has left. No process, disk, or tart access, so the
 * rules that choose between the VM path and the host path are unit-testable.
 */

import { relative, resolve } from "node:path";

const COMMANDS = new Set(["setup", "status", "gc", "script"]);

/**
 * `qa script <file> [args...]` runs one agent-written script; everything after
 * the file belongs to that script, so its own flags are never read as qa options.
 * Options for qa itself (`--vm`, `--host`, `--skip-build`) go before the file.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {{ command: "run" | "setup" | "status" | "gc" | "script", mode: "auto" | "vm" | "host", skipBuild: boolean, rebuild: boolean, lanes: string[], script: string | null, scriptArgs: string[] }}
 */
export function parseArgs(argv) {
	const rest = [...argv];
	const options = { command: "run", mode: "auto", skipBuild: false, rebuild: false, lanes: [], script: null, scriptArgs: [] };
	if (rest[0] !== undefined && COMMANDS.has(rest[0])) options.command = rest.shift();
	while (rest.length > 0) {
		const arg = rest.shift();
		if (options.command === "script" && !arg.startsWith("--")) {
			options.script = arg;
			options.scriptArgs = rest.splice(0);
			break;
		}
		if (arg === "--vm" || arg === "--host") {
			const mode = arg.slice(2);
			if (options.mode !== "auto" && options.mode !== mode) throw new Error("--vm and --host are mutually exclusive");
			options.mode = mode;
		} else if (arg === "--skip-build") options.skipBuild = true;
		else if (arg === "--rebuild") options.rebuild = true;
		else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
		else options.lanes.push(arg);
	}
	if (options.command === "script" && options.script === null) throw new Error("usage: qa script [--vm|--host] [--skip-build] <file> [script args...]");
	return options;
}

/**
 * The script path as the guest runs it. Only the checkout is synced (to
 * `~/<repo>` in the guest's home), so a host-absolute path would not exist
 * there; the path the user typed becomes one relative to the checkout root.
 * `assertScriptExists` has already rejected paths outside the checkout.
 */
export function guestScriptPath(root, file) {
	return relative(root, resolve(root, file));
}

/**
 * A VM job's exit code: the job's own, except 75 when the job passed but its
 * artifacts could not be pulled back before the VM was destroyed (they are
 * unrecoverable then, so success must not be reported).
 */
export function vmExitCode(code, pulled) {
	if (code === 0 && !pulled) return 75;
	return code ?? 1;
}

/** A VM name for one run: the branch is in the name so `tart list` shows whose VM it is. */
export function runVmName({ prefix, branch, suffix }) {
	const slug =
		branch
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 32)
			.replace(/-+$/, "") || "detached";
	return `${prefix}${slug}-${suffix}`;
}

/**
 * How many more pool VMs may start. macOS allows `max` VMs on one host, and a
 * running VM that is not a pool VM (the golden image being built, or one the
 * developer started by hand) uses up part of that allowance.
 *
 * @param {{ Name: string, Running: boolean }[]} vms `tart list` entries.
 */
export function vmCapacity(vms, { max, runPrefix }) {
	const outside = vms.filter((vm) => vm.Running && !vm.Name.startsWith(runPrefix)).length;
	return Math.max(0, max - outside);
}

/** The pool VMs on disk that no live slot names, i.e. leftovers of a crashed run. */
export function orphanVmNames(vms, holders, runPrefix) {
	if (holders.some((holder) => holder.owner === null)) return [];
	const named = new Set(holders.map((holder) => holder.owner.vm));
	return vms.filter((vm) => vm.Name.startsWith(runPrefix) && !named.has(vm.Name)).map((vm) => vm.Name);
}

/**
 * Whether a job indexes for real and so needs the host's MinSync embedding model
 * cache (`~/.cache/minsync/models`) in the guest. A fresh VM has none, so a real
 * first index would download ~1.2 GB from Hugging Face inside the VM. Only the
 * onboarding lane (and a sweep that runs every lane) performs a real first index;
 * a script may, so it gets the cache too.
 */
export function needsEmbeddingAssets(job) {
	if (job.kind === "script") return true;
	return job.lanes.length === 0 || job.lanes.includes("onboarding");
}
