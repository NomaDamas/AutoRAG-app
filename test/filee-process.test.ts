import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFileeProcess } from "../src/main/filee-process";

const posix = process.platform !== "win32";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "dazzi-filee-process-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function script(body: string): Promise<string> {
	const path = join(root, "fake-filee");
	await writeFile(path, `#!/bin/sh\n${body}\n`);
	await chmod(path, 0o755);
	return path;
}

// These tests drive real child processes (a shell script and its descendants). The conditions awaited —
// "the script wrote its pid", "the pid is gone" — happen in another OS process, so no fake clock or
// in-process promise can observe them; they poll with a bounded deadline instead.
async function waitForFile(path: string): Promise<string> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const text = await readFile(path, "utf8").catch(() => "");
		if (text.trim() !== "") return text.trim();
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for ${path}`);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitDead(pid: number): Promise<boolean> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (!alive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return false;
}

describe.runIf(posix)("runFileeProcess", () => {
	it("returns stdout, stderr and the exit code, and hands Filee its data folder", async () => {
		const exe = await script('echo "out:$1"; echo "err" >&2; echo "dir:$FILEE_DATA_DIR"; exit 1');
		const run = await runFileeProcess(exe, ["x"], { dataDir: join(root, "data") });
		expect(run.exitCode).toBe(1);
		expect(run.stdout).toBe(`out:x\ndir:${join(root, "data")}\n`);
		expect(run.stderr).toBe("err\n");
	});

	it("cancel stops the whole process tree, not just the program it started", async () => {
		const pidFile = join(root, "grandchild.pid");
		// Filee starts ffmpeg/LibreOffice as children; they must die with it.
		const exe = await script(`sleep 60 &\necho $! > "${pidFile}"\nwait`);
		const controller = new AbortController();
		const running = runFileeProcess(exe, [], { signal: controller.signal });
		const settled = running.then(
			() => "resolved",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		const grandchild = Number(await waitForFile(pidFile));
		expect(alive(grandchild)).toBe(true);

		controller.abort();

		expect(await settled).toMatch(/abort/i);
		expect(await waitDead(grandchild)).toBe(true);
	});

	it("settles only once the process is gone, so nothing writes after the caller cleans up", async () => {
		const pidFile = join(root, "self.pid");
		const exe = await script(`echo $$ > "${pidFile}"\nsleep 60 &\nwait`);
		const controller = new AbortController();
		const running = runFileeProcess(exe, [], { signal: controller.signal });
		const outcome = running.catch(() => undefined);
		const pid = Number(await waitForFile(pidFile));
		controller.abort();
		await outcome;
		expect(alive(pid)).toBe(false);
	});

	it("kills a tree that ignores the polite request after the grace period", async () => {
		const pidFile = join(root, "stubborn.pid");
		const exe = await script(`trap '' TERM\necho $$ > "${pidFile}"\nwhile true; do sleep 1; done`);
		const controller = new AbortController();
		const running = runFileeProcess(exe, [], { signal: controller.signal, killGraceMs: 100 });
		const outcome = running.catch(() => undefined);
		const pid = Number(await waitForFile(pidFile));
		controller.abort();
		await outcome;
		expect(await waitDead(pid)).toBe(true);
	});

	it("rejects at once when the signal is already aborted, without starting anything", async () => {
		const marker = join(root, "started");
		const exe = await script(`echo hi > "${marker}"`);
		const controller = new AbortController();
		controller.abort();
		await expect(runFileeProcess(exe, [], { signal: controller.signal })).rejects.toThrow(/abort/i);
		expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
	});

	it("times out and stops the tree", async () => {
		const pidFile = join(root, "slow.pid");
		const exe = await script(`sleep 60 &\necho $! > "${pidFile}"\nwait`);
		await expect(runFileeProcess(exe, [], { timeoutMs: 1500 })).rejects.toThrow(/timed out/i);
		expect(await waitDead(Number(await waitForFile(pidFile)))).toBe(true);
	});

	it("rejects when the program cannot be started", async () => {
		await expect(runFileeProcess(join(root, "missing"), [])).rejects.toThrow(/missing|ENOENT|unable/i);
	});
});
