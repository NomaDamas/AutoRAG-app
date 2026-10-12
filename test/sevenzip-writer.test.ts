import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArchiveLimits } from "../src/main/archive-common";
import { extractWithLibarchive } from "../src/main/libarchive-reader";
import { writeSevenZip, type SevenZipMember } from "../src/main/sevenzip-writer";

const LIMITS: ArchiveLimits = { maxTotalBytes: 20 * 1024 ** 3, maxEntries: 100_000, maxEngineBytes: 1024 ** 3 };

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "autorag-7z-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function hasBin(name: string): boolean {
	try {
		execFileSync(process.platform === "win32" ? "where" : "which", [name], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** Files by name under `root/src`, written and returned as 7z members. */
async function members(files: Readonly<Record<string, Buffer>>): Promise<SevenZipMember[]> {
	const src = join(root, "src");
	await mkdir(src, { recursive: true });
	const list: SevenZipMember[] = [];
	for (const [name, body] of Object.entries(files)) {
		await writeFile(join(src, name), body);
		list.push({ source: join(src, name), entry: name, directory: false });
	}
	return list;
}

/** Extract `archive` with the app's own wasm engine and return name -> bytes. */
async function readBack(archive: string): Promise<Record<string, Buffer>> {
	const out = join(root, "out");
	await extractWithLibarchive(archive, out, LIMITS);
	const result: Record<string, Buffer> = {};
	for (const name of await readdir(out)) result[name] = await readFile(join(out, name));
	return result;
}

const TEXT = Buffer.from("본문과 english text mixed 0123456789\n".repeat(4000));

describe("writeSevenZip", () => {
	it("round-trips files across several solid blocks and a block-spanning file order", async () => {
		const files = { "a.txt": TEXT, "b.txt": Buffer.from(TEXT.toString().replace(/0/g, "1")), "c.txt": TEXT, "d.txt": Buffer.from("tiny") };
		const archive = join(root, "multi.7z");
		// 64 KiB blocks: each ~150 KiB text file lands in its own folder.
		await writeSevenZip(archive, await members(files), { solidBlockBytes: 64 * 1024 });
		expect(await readBack(archive)).toEqual(files);
	});

	it("compresses text far below what deflate manages, by sharing a dictionary across files", async () => {
		const files = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}.txt`, Buffer.from(`${TEXT.toString()}\nfile ${i}\n`)]));
		const archive = join(root, "solid.7z");
		await writeSevenZip(archive, await members(files));
		const packed = (await stat(archive)).size;
		const raw = Object.values(files).reduce((sum, file) => sum + file.length, 0);
		expect(packed).toBeLessThan(raw / 100);
		expect(await readBack(archive)).toEqual(files);
	});

	it("stores already-compressed data as Copy instead of burning time in LZMA", async () => {
		const noise = randomBytes(600 * 1024);
		const archive = join(root, "noise.7z");
		await writeSevenZip(archive, await members({ "noise.bin": noise }));
		// Copy: the archive is the data plus a small header, never meaningfully larger.
		expect((await stat(archive)).size).toBeLessThan(noise.length + 512);
		expect((await stat(archive)).size).toBeGreaterThanOrEqual(noise.length);
		expect(await readBack(archive)).toEqual({ "noise.bin": noise });
	});

	it("deflates a single file past the LZMA size cap and keeps its neighbours intact", async () => {
		const files = { "before.txt": TEXT, "huge.txt": Buffer.from(TEXT.toString().repeat(3)), "after.txt": Buffer.from("after") };
		const archive = join(root, "cap.7z");
		await writeSevenZip(archive, await members(files), { lzmaMaxFileBytes: TEXT.length * 2 });
		expect(await readBack(archive)).toEqual(files);
	});

	it("writes empty files and empty directories without a stream", async () => {
		const src = join(root, "src");
		await mkdir(join(src, "hollow"), { recursive: true });
		await writeFile(join(src, "zero.txt"), "");
		await writeFile(join(src, "one.txt"), "one");
		const list: SevenZipMember[] = [
			{ source: join(src, "hollow"), entry: "hollow/", directory: true },
			{ source: join(src, "zero.txt"), entry: "zero.txt", directory: false },
			{ source: join(src, "one.txt"), entry: "one.txt", directory: false },
		];
		const archive = join(root, "empty.7z");
		await writeSevenZip(archive, list);
		const out = join(root, "out");
		await extractWithLibarchive(archive, out, LIMITS);
		expect((await stat(join(out, "hollow"))).isDirectory()).toBe(true);
		expect(await readFile(join(out, "zero.txt"), "utf8")).toBe("");
		expect(await readFile(join(out, "one.txt"), "utf8")).toBe("one");
	});

	it("leaves no partial archive behind when a source disappears", async () => {
		const list = await members({ "a.txt": TEXT });
		const archive = join(root, "gone.7z");
		await rm(list[0]?.source ?? "");
		await expect(writeSevenZip(archive, list)).rejects.toThrow();
		expect(await readdir(root)).not.toContain("gone.7z");
	});

	it.skipIf(!hasBin("bsdtar"))("is readable by an independent implementation (bsdtar)", async () => {
		const files = { "a.txt": TEXT, "noise.bin": randomBytes(400 * 1024), "한글.txt": Buffer.from("한글 본문\n".repeat(3000)) };
		const archive = join(root, "ext.7z");
		await writeSevenZip(archive, await members(files), { solidBlockBytes: 256 * 1024 });
		const out = join(root, "bsdtar-out");
		await mkdir(out);
		execFileSync("bsdtar", ["-xf", archive, "-C", out]);
		for (const [name, body] of Object.entries(files)) {
			expect(await readFile(join(out, name))).toEqual(body);
		}
	});
});
