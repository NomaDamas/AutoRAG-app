import { execFileSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyTree } from "../src/main/copy-tree";

const posix = process.platform !== "win32";
let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "autorag-copy-tree-"));
});

afterEach(async () => {
	// A read-only directory refuses to lose its children until it is writable again.
	for (const dir of ["ro"]) {
		for (const side of ["cp", "tree", "src"]) await chmod(join(root, side, dir), 0o755).catch(() => undefined);
	}
	await rm(root, { recursive: true, force: true });
});

/** A tree with nesting, an empty directory, binary and many small files, and (POSIX) modes and every kind of symlink. */
async function richTree(dir: string, options: { readonly dangling: boolean } = { dangling: true }): Promise<void> {
	await mkdir(join(dir, "sub", "deep"), { recursive: true });
	await mkdir(join(dir, "sub", "many"));
	await mkdir(join(dir, "empty"));
	await writeFile(join(dir, "a.txt"), "alpha");
	await writeFile(join(dir, "sub", "b.txt"), "beta");
	await writeFile(join(dir, "sub", "deep", "c.bin"), Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 7) & 255)));
	for (let i = 0; i < 120; i += 1) await writeFile(join(dir, "sub", "many", `f${i}.txt`), `file ${i}`);
	if (!posix) return;
	await writeFile(join(dir, "run.sh"), "#!/bin/sh\n");
	await chmod(join(dir, "run.sh"), 0o755);
	await writeFile(join(dir, "readonly.txt"), "fixed");
	await chmod(join(dir, "readonly.txt"), 0o444);
	await mkdir(join(dir, "ro"));
	await writeFile(join(dir, "ro", "inside.txt"), "locked in");
	await chmod(join(dir, "ro"), 0o555);
	await symlink("a.txt", join(dir, "rel-link"));
	await symlink(join(dir, "a.txt"), join(dir, "abs-link"));
	if (options.dangling) await symlink("does-not-exist", join(dir, "dangling"));
	await symlink("sub", join(dir, "dir-link"));
}

interface Node {
	readonly type: "file" | "dir" | "link";
	readonly mode: number | null;
	readonly detail: string;
}

/** Everything about a tree that a copy can get wrong, keyed by relative path. */
async function snapshot(dir: string): Promise<Map<string, Node>> {
	const out = new Map<string, Node>();
	async function walk(current: string): Promise<void> {
		for (const name of await readdir(current)) {
			const path = join(current, name);
			const info = await lstat(path);
			const key = relative(dir, path);
			const mode = posix ? info.mode & 0o7777 : null;
			if (info.isSymbolicLink()) out.set(key, { type: "link", mode: null, detail: await readlink(path) });
			else if (info.isDirectory()) {
				out.set(key, { type: "dir", mode, detail: "" });
				await walk(path);
			} else out.set(key, { type: "file", mode, detail: (await readFile(path)).toString("base64") });
		}
	}
	await walk(dir);
	return out;
}

describe("copyTree matches fs.cp", () => {
	for (const dereference of [false, true]) {
		it(`yields the same tree as fs.cp, dereference: ${dereference}`, async () => {
			// Given a rich source
			const src = join(root, "src");
			// (fs.cp itself cannot dereference a dangling link, so that case is covered without dereference only)
			await mkdir(src);
			await richTree(src, { dangling: !dereference });

			// When it is copied by fs.cp (the old behavior) and by copyTree
			await cp(src, join(root, "cp"), { recursive: true, dereference });
			await copyTree(src, join(root, "tree"), { dereference });

			// Then names, bytes, modes, directory modes and every symlink target agree
			const expected = await snapshot(join(root, "cp"));
			const actual = await snapshot(join(root, "tree"));
			expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
			expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(expected));
			expect(actual.size).toBeGreaterThan(120);
		});
	}

	it.skipIf(!posix)("keeps a relative symlink pointing at the original, as fs.cp does", async () => {
		const src = join(root, "src");
		await mkdir(src);
		await writeFile(join(src, "a.txt"), "alpha");
		await symlink("a.txt", join(src, "rel"));

		await copyTree(src, join(root, "tree"));

		expect(await readlink(join(root, "tree", "rel"))).toBe(join(src, "a.txt"));
	});

	it("copies a single file and creates the missing parent folders of the target", async () => {
		await writeFile(join(root, "one.txt"), "solo");

		await copyTree(join(root, "one.txt"), join(root, "made", "on", "demand", "one copy.txt"));

		expect(await readFile(join(root, "made", "on", "demand", "one copy.txt"), "utf8")).toBe("solo");
	});

	it("reports a missing source with the OS reason and creates nothing", async () => {
		await expect(copyTree(join(root, "missing"), join(root, "out"))).rejects.toThrow(/ENOENT/);
		expect(await readdir(root)).toEqual([]);
	});
});

describe("copyTree refuses to copy a folder into itself", () => {
	const intoSelf = /subdirectory of self/;

	it("rejects a target inside the source before writing anything", async () => {
		const src = join(root, "src");
		await mkdir(join(src, "inner"), { recursive: true });
		await writeFile(join(src, "a.txt"), "alpha");

		for (const target of [join(src, "src"), join(src, "inner", "deep", "src")]) {
			await expect(copyTree(src, target)).rejects.toThrow(intoSelf);
		}
		await expect(copyTree(src, src)).rejects.toThrow(/src and dest cannot be the same/);
		expect(await readdir(src)).toEqual(["a.txt", "inner"]);
		expect(await readdir(join(src, "inner"))).toEqual([]);
	});

	it.skipIf(!posix)("sees through a symlinked parent that leads back into the source, even below a missing folder", async () => {
		const src = join(root, "src");
		await mkdir(src);
		await writeFile(join(src, "a.txt"), "alpha");
		await symlink(src, join(root, "alias"));

		await expect(copyTree(src, join(root, "alias", "src copy"))).rejects.toThrow(intoSelf);
		await expect(copyTree(src, join(root, "alias", "not", "made", "yet"))).rejects.toThrow(intoSelf);
		expect(await readdir(src)).toEqual(["a.txt"]);
	});

	it("does not mistake a sibling with the same name prefix for the inside", async () => {
		const src = join(root, "docs");
		await mkdir(src);
		await writeFile(join(src, "a.txt"), "alpha");

		await copyTree(src, join(root, "docs copy"));

		expect(await readFile(join(root, "docs copy", "a.txt"), "utf8")).toBe("alpha");
	});
});

describe("copyTree bounds its work", () => {
	it("runs at most `concurrency` file copies at once, and does use that many", async () => {
		// Given 60 files and a copy that stays in flight for a moment
		const src = join(root, "src");
		await mkdir(src);
		for (let i = 0; i < 60; i += 1) await writeFile(join(src, `f${i}.txt`), String(i));
		let active = 0;
		let peak = 0;
		const copied: string[] = [];

		// When copying with a cap of 5
		await copyTree(src, join(root, "out"), {
			concurrency: 5,
			copyFile: async (from, to) => {
				active += 1;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 5));
				await writeFile(to, await readFile(from));
				copied.push(to);
				active -= 1;
			},
		});

		// Then never more than 5 ran together, 5 did, and every file arrived
		expect(peak).toBe(5);
		expect(copied).toHaveLength(60);
		expect((await readdir(join(root, "out"))).length).toBe(60);
	});

	it("stops starting new copies after a failure and leaves no write running behind the rejection", async () => {
		// Given 300 files and a copy that fails on its tenth call
		const src = join(root, "src");
		await mkdir(src);
		for (let i = 0; i < 300; i += 1) await writeFile(join(src, `f${String(i).padStart(3, "0")}.txt`), String(i));
		let started = 0;

		// When the copy runs with a cap of 3
		const failure = copyTree(src, join(root, "out"), {
			concurrency: 3,
			copyFile: async (from, to) => {
				started += 1;
				const call = started;
				await new Promise((resolve) => setTimeout(resolve, 2));
				if (call === 10) throw new Error("disk went away");
				await writeFile(to, await readFile(from));
			},
		});

		// Then the first failure is the reason, nothing new starts after it, and the destination stops changing
		await expect(failure).rejects.toThrow("disk went away");
		const startedAtRejection = started;
		const settled = (await readdir(join(root, "out"))).length;
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(started).toBe(startedAtRejection);
		expect(started).toBeLessThanOrEqual(10 + 2);
		expect((await readdir(join(root, "out"))).length).toBe(settled);
	});

	it.skipIf(!posix)("refuses a FIFO the way fs.cp does, naming the target", async () => {
		const src = join(root, "src");
		await mkdir(src);
		execFileSync("mkfifo", [join(src, "pipe")]);

		await expect(copyTree(src, join(root, "out"))).rejects.toThrow(/cannot copy a FIFO pipe: .*pipe/);
	});
});
