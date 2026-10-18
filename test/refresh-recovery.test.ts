import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_QUARANTINED, runWithRecovery } from "../src/main/refresh-recovery";

const ROOT = resolve("/data/docs");
const fail = (code: string, path?: string): Error => Object.assign(new Error(`${code}: boom`), { code, ...(path === undefined ? {} : { path }) });
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function harness(script: Array<Error | "ok">, searchPaths: readonly string[] = [ROOT]) {
	const sleeps: number[] = [];
	const seen: Array<readonly string[]> = [];
	let call = 0;
	return {
		sleeps,
		seen,
		run: () =>
			runWithRecovery(
				async (excluded) => {
					seen.push([...excluded]);
					const step = script[Math.min(call, script.length - 1)];
					call += 1;
					if (step instanceof Error) throw step;
					return "done";
				},
				{ searchPaths, sleep: async (ms) => void sleeps.push(ms) },
			),
	};
}

describe("runWithRecovery", () => {
	it("returns at once when nothing fails", async () => {
		const h = harness(["ok"]);

		expect(await h.run()).toEqual({ value: "done", retries: 0, quarantined: [], code: null });
		expect(h.sleeps).toEqual([]);
	});

	it("retries a transient error with growing waits and reports what it saw", async () => {
		const h = harness([fail("EMFILE"), fail("EMFILE"), "ok"]);

		expect(await h.run()).toMatchObject({ value: "done", retries: 2, quarantined: [], code: "EMFILE" });
		expect(h.sleeps).toEqual([2_000, 6_000]);
	});

	it("throws an error that is not transient, untouched", async () => {
		const error = fail("ENOSPC", join(ROOT, "a.md"));
		const h = harness([error]);

		await expect(h.run()).rejects.toBe(error);
		expect(h.sleeps).toEqual([]);
	});

	it("throws an error with no code, untouched", async () => {
		const error = new Error("plain");

		await expect(harness([error]).run()).rejects.toBe(error);
	});

	it("leaves out a file that keeps failing and carries on with everything else", async () => {
		const locked = join(ROOT, "locked.docx");
		const h = harness([fail("EBUSY", locked), fail("EBUSY", locked), fail("EBUSY", locked), "ok"]);

		expect(await h.run()).toMatchObject({ value: "done", retries: 2, quarantined: [locked], code: "EBUSY" });
		expect(h.seen.at(-1)).toEqual([locked]);
	});

	it("gives every file its own retry budget", async () => {
		const [a, b] = [join(ROOT, "a.docx"), join(ROOT, "b.docx")];
		const h = harness([fail("EIO", a), fail("EIO", a), fail("EIO", a), fail("EIO", b), fail("EIO", b), fail("EIO", b), "ok"]);

		expect((await h.run()).quarantined).toEqual([a, b]);
	});

	it("spends one retry budget per file even when the error code keeps changing", async () => {
		const file = join(ROOT, "flaky.docx");
		const h = harness([fail("EBUSY", file), fail("EIO", file), fail("EBUSY", file), "ok"]);

		expect(await h.run()).toMatchObject({ value: "done", retries: 2, quarantined: [file] });
	});

	it("does not leave out a file for process-wide pressure like EMFILE, nor one outside the search roots", async () => {
		const pressure = fail("EMFILE", join(ROOT, "a.md"));
		await expect(harness([pressure, pressure, pressure, pressure]).run()).rejects.toBe(pressure);

		const outside = fail("EIO", "/data/workspace/.autorag/parsed/x.md");
		await expect(harness([outside, outside, outside, outside]).run()).rejects.toBe(outside);
	});

	it.skipIf(process.platform === "win32")("leaves out a file reached through a symlinked search root, which the librarian walks by its real path", async () => {
		const directory = await mkdtemp(join(tmpdir(), "autorag-refresh-recovery-"));
		directories.push(directory);
		const target = join(directory, "target");
		await mkdir(target, { recursive: true });
		const link = join(directory, "link");
		await symlink(target, link);
		// The failing path as the librarian reports it: walked from the pinned (real) root.
		const locked = join(await realpath(target), "locked.docx");
		const busy = fail("EBUSY", locked);
		const h = harness([busy, busy, busy, "ok"], [link]);

		expect(await h.run()).toMatchObject({ value: "done", quarantined: [locked] });
		expect(h.seen.at(-1)).toEqual([locked]);
	});

	it("does not match a sibling folder that shares the root's name as a prefix", async () => {
		const sibling = fail("EIO", `${ROOT}-other/a.md`);

		await expect(harness([sibling, sibling, sibling, sibling]).run()).rejects.toBe(sibling);
	});

	it("stops leaving files out once too many fail, because then it is not about files", async () => {
		const script: Array<Error | "ok"> = [];
		for (let index = 0; index <= MAX_QUARANTINED; index += 1) script.push(...Array.from({ length: 3 }, () => fail("EIO", join(ROOT, `f${index}.md`))));
		const h = harness(script);

		await expect(h.run()).rejects.toMatchObject({ code: "EIO" });
		expect(h.seen.at(-1)).toHaveLength(MAX_QUARANTINED);
	});
});
