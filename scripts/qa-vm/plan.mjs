/**
 * Pure decisions for the QA runner: command-line parsing, VM naming, and how
 * many VM slots the machine has left. No process, disk, or tart access, so the
 * rules that choose between the VM path and the host path are unit-testable.
 */

const COMMANDS = new Set(["setup", "status", "gc"]);

/**
 * @param {string[]} argv Arguments after the script name.
 * @returns {{ command: "run" | "setup" | "status" | "gc", mode: "auto" | "vm" | "host", skipBuild: boolean, rebuild: boolean, lanes: string[] }}
 */
export function parseArgs(argv) {
	const rest = [...argv];
	const options = { command: "run", mode: "auto", skipBuild: false, rebuild: false, lanes: [] };
	if (rest[0] !== undefined && COMMANDS.has(rest[0])) options.command = rest.shift();
	for (const arg of rest) {
		if (arg === "--vm" || arg === "--host") {
			const mode = arg.slice(2);
			if (options.mode !== "auto" && options.mode !== mode) throw new Error("--vm and --host are mutually exclusive");
			options.mode = mode;
		} else if (arg === "--skip-build") options.skipBuild = true;
		else if (arg === "--rebuild") options.rebuild = true;
		else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
		else options.lanes.push(arg);
	}
	return options;
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
