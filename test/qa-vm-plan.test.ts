import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guestScriptPath, needsEmbeddingAssets, orphanVmNames, parseArgs, runVmName, vmCapacity, vmExitCode } from "../scripts/qa-vm/plan.mjs";

const PREFIX = "autorag-qa-run-";
const vm = (Name: string, Running: boolean) => ({ Name, Running });

describe("qa-vm argument parsing", () => {
	it("treats bare words as lane names and defaults to auto mode", () => {
		expect(parseArgs(["kind", "live-sync"])).toMatchObject({ command: "run", mode: "auto", lanes: ["kind", "live-sync"] });
	});

	it("reads a subcommand only in first position, so a lane can never be mistaken for one", () => {
		expect(parseArgs(["setup", "--rebuild"])).toMatchObject({ command: "setup", rebuild: true });
		expect(parseArgs(["kind", "setup"])).toMatchObject({ command: "run", lanes: ["kind", "setup"] });
	});

	it("rejects asking for both paths and unknown options instead of guessing", () => {
		expect(() => parseArgs(["--vm", "--host"])).toThrow(/mutually exclusive/);
		expect(() => parseArgs(["--turbo"])).toThrow(/unknown option/);
	});

	it("hands everything after a script file to the script, even words that look like qa options", () => {
		const options = parseArgs(["script", "--vm", "--skip-build", "tmp/check.mjs", "--host", "--vm", "kind", "--", "x"]);
		expect(options).toMatchObject({ command: "script", mode: "vm", skipBuild: true, script: "tmp/check.mjs", scriptArgs: ["--host", "--vm", "kind", "--", "x"] });
		expect(options.lanes).toEqual([]);
	});

	it("needs a script file, and still rejects unknown qa options placed before it", () => {
		expect(() => parseArgs(["script"])).toThrow(/usage: qa script/);
		expect(() => parseArgs(["script", "--vm"])).toThrow(/usage: qa script/);
		expect(() => parseArgs(["script", "--turbo", "x.mjs"])).toThrow(/unknown option/);
	});
});

describe("qa-vm script path as the guest sees it", () => {
	it("runs a host-absolute in-checkout script as a path relative to the synced checkout", () => {
		const root = "/Volumes/SSD1/7/AutoRAG-app";
		expect(guestScriptPath(root, `${root}/tmp-qa.mjs`)).toBe("tmp-qa.mjs");
		expect(guestScriptPath(root, `${root}/scripts/manual-qa/launch-finder.mjs`)).toBe(join("scripts", "manual-qa", "launch-finder.mjs"));
	});

	it("normalizes a user-typed relative path to the same form", () => {
		expect(guestScriptPath("/repo", "./tmp/deep/check.mjs")).toBe(join("tmp", "deep", "check.mjs"));
	});
});

describe("qa-vm VM job exit code", () => {
	it("passes the job's own code through when the artifacts came back", () => {
		expect(vmExitCode(0, true)).toBe(0);
		expect(vmExitCode(1, true)).toBe(1);
		expect(vmExitCode(null, true)).toBe(1);
	});

	it("reports 75 when the job passed but its artifacts could not be pulled before the VM was destroyed", () => {
		expect(vmExitCode(0, false)).toBe(75);
		// A job that already failed keeps its own failure code.
		expect(vmExitCode(1, false)).toBe(1);
	});
});

describe("qa-vm VM naming", () => {
	it("puts a filesystem- and tart-safe branch slug in the name", () => {
		const name = runVmName({ prefix: PREFIX, branch: "feat/QA Tart_VM!", suffix: "ab12" });
		expect(name).toBe("autorag-qa-run-feat-qa-tart-vm-ab12");
		expect(name).toMatch(/^[a-z0-9-]+$/);
	});

	it("bounds long branch names and survives an empty branch (detached HEAD)", () => {
		const long = runVmName({ prefix: PREFIX, branch: `feat/${"x".repeat(80)}`, suffix: "s" });
		expect(long.length).toBeLessThanOrEqual(PREFIX.length + 32 + 2);
		expect(runVmName({ prefix: PREFIX, branch: "", suffix: "s" })).toBe("autorag-qa-run-detached-s");
	});
});

describe("qa-vm capacity", () => {
	it("offers both slots when nothing else is running", () => {
		expect(vmCapacity([vm("autorag-qa-golden", false)], { max: 2, runPrefix: PREFIX })).toBe(2);
	});

	it("does not count pool VMs against the allowance; the slot pool already limits those", () => {
		expect(vmCapacity([vm(`${PREFIX}a`, true), vm(`${PREFIX}b`, true)], { max: 2, runPrefix: PREFIX })).toBe(2);
	});

	it("shrinks the allowance for each running VM outside the pool (e.g. a hand-started or half-built image)", () => {
		const running = [vm("autorag-qa-golden-build", true)];
		expect(vmCapacity(running, { max: 2, runPrefix: PREFIX })).toBe(1);
		expect(vmCapacity([...running, vm("scratch", true)], { max: 2, runPrefix: PREFIX })).toBe(0);
		expect(vmCapacity([...running, vm("scratch", true), vm("other", true)], { max: 2, runPrefix: PREFIX })).toBe(0);
	});
});

describe("qa-vm orphan detection", () => {
	const holders = [{ index: 0, owner: { vm: `${PREFIX}live` } }];

	it("names pool VMs that no slot claims and never touches the golden image or other VMs", () => {
		const vms = [vm(`${PREFIX}live`, true), vm(`${PREFIX}crashed`, false), vm("autorag-qa-golden", false), vm("my-own-vm", false)];
		expect(orphanVmNames(vms, holders, PREFIX)).toEqual([`${PREFIX}crashed`]);
	});

	it("names nothing while a slot is mid-creation, since its VM name is not recorded yet", () => {
		const vms = [vm(`${PREFIX}starting`, true)];
		expect(orphanVmNames(vms, [{ index: 1, owner: null }], PREFIX)).toEqual([]);
	});
});

describe("qa-vm embedding assets", () => {
	it("copies the host's model into the guest only for jobs that index for real", () => {
		expect(needsEmbeddingAssets({ kind: "sweep", lanes: ["onboarding"] })).toBe(true);
		expect(needsEmbeddingAssets({ kind: "sweep", lanes: [] })).toBe(true);
		expect(needsEmbeddingAssets({ kind: "script" })).toBe(true);
		expect(needsEmbeddingAssets({ kind: "sweep", lanes: ["kind", "split-panes"] })).toBe(false);
	});
});
