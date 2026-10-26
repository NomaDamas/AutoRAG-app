import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PARENT = fileURLToPath(new URL("./fixtures/tied-launch-parent.mjs", import.meta.url));

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function until(probe: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (probe()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return probe();
}

// Windows only: that is where a force-killed app leaves a detached child behind (Everything's daemon pinned the profile
// folder and piled up, one per profile). macOS and Linux keep the child either way, and no app code launches it that way there.
describe.skipIf(process.platform !== "win32")("a daemon launched through launchTiedToParent", () => {
	it("dies with its parent even when the parent is killed without a chance to clean up", async () => {
		const parent = spawn(process.execPath, [PARENT], { stdio: ["ignore", "pipe", "inherit"] });
		const daemon = await new Promise<number>((resolve, reject) => {
			parent.once("exit", () => reject(new Error("the parent exited before reporting the daemon")));
			parent.stdout.on("data", (chunk: Buffer) => {
				const match = /DAEMON (\d+)/.exec(String(chunk));
				if (match !== null) resolve(Number(match[1]));
			});
		});
		try {
			expect(alive(daemon)).toBe(true);

			process.kill(parent.pid ?? 0, "SIGKILL");

			expect(await until(() => !alive(daemon), 5000)).toBe(true);
		} finally {
			if (alive(daemon)) process.kill(daemon, "SIGKILL");
		}
	});
});
