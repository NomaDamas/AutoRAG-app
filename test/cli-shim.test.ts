import { execFileSync, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseOsRequestArgv } from "../src/shared/os-request-contract";

const SHIM = fileURLToPath(new URL("../build/cli/dazzi", import.meta.url));
const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** One recorded launch: who was started (`app` or `open`), the argv it got, and the env it saw. */
interface Launch {
	readonly program: "app" | "open";
	readonly args: readonly string[];
	readonly electronRunAsNode: string;
}

interface Fixture {
	readonly root: string;
	/** The shim as the bundle ships it: `<root>/Dazzi.app/Contents/Resources/bin/dazzi`. */
	readonly shim: string;
	/** The next launch the shim made. Blocks on the FIFO until a stand-in program writes it: no timer, no guess. */
	readonly nextLaunch: () => Promise<Launch>;
}

/**
 * A bundle whose `Contents/MacOS/Dazzi` records its argv (the real one is Electron) and a PATH-first `open`
 * that does the same, so the shim is exercised end to end without starting an app. Both report through a
 * FIFO because the shim backgrounds the launch: reading the FIFO is what waits for it.
 */
async function fixture(): Promise<Fixture> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "cli-shim-")));
	dirs.push(root);
	const contents = join(root, "Dazzi.app", "Contents");
	await mkdir(join(contents, "Resources", "bin"), { recursive: true });
	await mkdir(join(contents, "MacOS"), { recursive: true });
	const shim = join(contents, "Resources", "bin", "dazzi");
	await copyFile(SHIM, shim);
	await chmod(shim, 0o755);
	const fifo = join(root, "launches.fifo");
	execFileSync("/usr/bin/mkfifo", [fifo]);
	// One record per launch: label, every argv entry, the env marker; NUL-separated, newline-terminated.
	// The real `open` returns at once, so the write runs in the background. Its stdio is detached BEFORE the
	// FIFO opens (which blocks until the test reads): otherwise it would hold the shim's stdout pipe and the
	// caller would never see EOF.
	const recorder = (label: string): string =>
		`#!/bin/sh\n{ printf '%s\\0' "${label}" >&3; for a in "$@"; do printf '%s\\0' "$a" >&3; done; printf '%s\\0\\n' "\${ELECTRON_RUN_AS_NODE-unset}" >&3; } </dev/null >/dev/null 2>&1 3>"${fifo}" &\n`;
	await writeFile(join(contents, "MacOS", "Dazzi"), recorder("app"));
	await chmod(join(contents, "MacOS", "Dazzi"), 0o755);
	await mkdir(join(root, "fakebin"));
	await writeFile(join(root, "fakebin", "open"), recorder("open"));
	await chmod(join(root, "fakebin", "open"), 0o755);
	return {
		root,
		shim,
		nextLaunch: async () => {
			const fields = (await readFile(fifo, "utf8")).replace(/\n$/u, "").split("\0").slice(0, -1);
			const [program, ...rest] = fields;
			const electronRunAsNode = rest.pop() ?? "";
			return { program: program as Launch["program"], args: rest, electronRunAsNode };
		},
	};
}

function run(f: Fixture, args: readonly string[], options: { cwd?: string; shim?: string; env?: Record<string, string> } = {}): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(options.shim ?? f.shim, [...args], {
		cwd: options.cwd ?? f.root,
		encoding: "utf8",
		env: { PATH: `${join(f.root, "fakebin")}:/usr/bin:/bin`, HOME: f.root, ...options.env },
		timeout: 15_000,
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Proves a run launched nothing: a sentinel launch made afterwards must be the FIRST record in the FIFO.
 * (Had the earlier run launched, its record would be read here instead.)
 */
async function expectNothingLaunched(f: Fixture): Promise<void> {
	const sentinel = join(f.root, "sentinel");
	await mkdir(sentinel, { recursive: true });
	run(f, [sentinel]);
	expect(parseOsRequestArgv((await f.nextLaunch()).args)?.paths).toEqual([sentinel]);
}

describe.skipIf(process.platform === "win32")("the dazzi launcher script", () => {
	it("opens a folder given by an absolute path, as one request the app parses back", async () => {
		const f = await fixture();
		const folder = join(f.root, "work");
		await mkdir(folder);
		expect(run(f, [folder]).status).toBe(0);
		const launch = await f.nextLaunch();
		expect(launch.program).toBe("app");
		expect(parseOsRequestArgv(launch.args)).toEqual({ action: "open", paths: [folder] });
	});

	it("turns relative paths, `.` and `..` into absolute ones from the caller's directory", async () => {
		const f = await fixture();
		await mkdir(join(f.root, "work", "sub"), { recursive: true });
		await writeFile(join(f.root, "work", "note.md"), "x");
		expect(run(f, [".", "sub", "../work/note.md"], { cwd: join(f.root, "work") }).status).toBe(0);
		expect(parseOsRequestArgv((await f.nextLaunch()).args)?.paths).toEqual([join(f.root, "work"), join(f.root, "work", "sub"), join(f.root, "work", "note.md")]);
	});

	it("keeps spaces, quotes and Hangul in a name intact", async () => {
		const f = await fixture();
		const folder = join(f.root, "한글 폴더 it's");
		await mkdir(folder);
		run(f, ["한글 폴더 it's"]);
		expect(parseOsRequestArgv((await f.nextLaunch()).args)?.paths).toEqual([folder]);
	});

	it("follows the way it was reached: through a symlink on PATH, as `brew` and the app install it", async () => {
		const f = await fixture();
		const folder = join(f.root, "work");
		await mkdir(folder);
		const link = join(f.root, "fakebin", "dazzi");
		await symlink(f.shim, link);
		expect(run(f, [folder], { shim: link }).status).toBe(0);
		expect((await f.nextLaunch()).program).toBe("app");
	});

	it("never leaks ELECTRON_RUN_AS_NODE into the app, which would turn Electron into plain Node", async () => {
		const f = await fixture();
		await mkdir(join(f.root, "work"));
		run(f, ["work"], { env: { ELECTRON_RUN_AS_NODE: "1" } });
		expect((await f.nextLaunch()).electronRunAsNode).toBe("unset");
	});

	it("passes a profile through, so a second profile is reachable", async () => {
		const f = await fixture();
		await mkdir(join(f.root, "work"));
		run(f, ["work"], { env: { DAZZI_USER_DATA_DIR: "/tmp/other profile" } });
		expect((await f.nextLaunch()).args).toContain("--user-data-dir=/tmp/other profile");
	});

	it("reports a missing path like `open`, still opens the ones that exist, and exits non-zero", async () => {
		const f = await fixture();
		await mkdir(join(f.root, "real"));
		const result = run(f, ["nope", "real"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("dazzi: nope: No such file or directory");
		expect(parseOsRequestArgv((await f.nextLaunch()).args)?.paths).toEqual([join(f.root, "real")]);
	});

	it("starts nothing when no path exists", async () => {
		const f = await fixture();
		expect(run(f, ["nope"]).status).toBe(1);
		await expectNothingLaunched(f);
	});

	it("brings the running app forward with `open` when called without a path", async () => {
		const f = await fixture();
		expect(run(f, []).status).toBe(0);
		const launch = await f.nextLaunch();
		expect(launch.program).toBe("open");
		expect(launch.args).toEqual([join(f.root, "Dazzi.app")]);
	});

	it("rejects an unknown option and answers --help", async () => {
		const f = await fixture();
		const bad = run(f, ["--frobnicate"]);
		expect(bad.status).toBe(2);
		expect(bad.stderr).toContain("--frobnicate");
		const help = run(f, ["--help"]);
		expect(help.status).toBe(0);
		expect(help.stdout).toContain("Usage: dazzi");
		await expectNothingLaunched(f);
	});

	it("takes a folder named like an option after `--`", async () => {
		const f = await fixture();
		await mkdir(join(f.root, "-odd"));
		expect(run(f, ["--", "-odd"]).status).toBe(0);
		expect(parseOsRequestArgv((await f.nextLaunch()).args)?.paths).toEqual([join(f.root, "-odd")]);
	});

	it("refuses more paths than a request can carry instead of dropping them silently", async () => {
		const f = await fixture();
		const many = Array.from({ length: 201 }, (_, i) => `/tmp/p${i}`);
		const result = run(f, many);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("200");
		await expectNothingLaunched(f);
	});

	it("has the marker the installer uses to recognise its own launcher", async () => {
		expect(await readFile(SHIM, "utf8")).toContain("DAZZI-CLI-LAUNCHER");
	});
});
