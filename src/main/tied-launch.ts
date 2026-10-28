import { spawn } from "node:child_process";

/**
 * Starts a background program that the OS ends together with this process, however this process ends.
 *
 * On Windows, libuv puts every child that is not `detached` into a job object that kills its members when the
 * owning process dies, including a force-kill (`taskkill /F`, a crash, a test harness) that runs none of our quit
 * code. A `detached` child is outside that job and outlives us, which is what left one Everything daemon per profile
 * running, each pinning its profile folder. macOS and Linux have no such job (a plain child there is simply orphaned),
 * so this is for the Windows-only Everything daemon; the fsearch daemon stays detached on purpose.
 *
 * Returns the child's pid when it started.
 */
export function launchTiedToParent(command: string, args: readonly string[]): number | undefined {
	const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
	child.on("error", () => {
		// A program that cannot start is reported where the caller waits for it to answer.
	});
	// The daemon never holds this process's event loop open.
	child.unref();
	return child.pid;
}
